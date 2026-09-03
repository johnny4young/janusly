//go:build integration

package ratelimit

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// Fixed-window semantics over Postgres: under-limit passes, over-limit
// carries the contract's verbatim message, the next window resets, and
// buckets/keys are independent.
func TestEnforceFixedWindow(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	limiter := New(pool, Hooks{})
	base := time.Date(2026, 7, 31, 10, 0, 0, 0, time.UTC)
	limiter.SetNow(func() time.Time { return base })

	key := fmt.Sprintf("org-rl-%d", time.Now().UnixNano())
	opts := Options{Name: "api:start", Max: 3, Window: time.Minute}
	for i := range 3 {
		if err := limiter.Enforce(ctx, key, opts); err != nil {
			t.Fatalf("hit %d must pass: %v", i, err)
		}
	}
	err := limiter.Enforce(ctx, key, opts)
	var limited *LimitError
	if !errors.As(err, &limited) {
		t.Fatalf("4th hit must limit: %v", err)
	}
	if !strings.HasPrefix(limited.Error(), "Rate limit exceeded for api:start. Retry in ") ||
		!strings.HasSuffix(limited.Error(), "s.") {
		t.Fatalf("Node message shape: %q", limited.Error())
	}

	// A different KEY (other tenant) and a different BUCKET are unaffected.
	if err := limiter.Enforce(ctx, key+"-other", opts); err != nil {
		t.Fatalf("other tenant must pass: %v", err)
	}
	if err := limiter.Enforce(ctx, key, Options{Name: "api:save", Max: 3, Window: time.Minute}); err != nil {
		t.Fatalf("other bucket must pass: %v", err)
	}

	// The next window starts clean.
	limiter.SetNow(func() time.Time { return base.Add(time.Minute) })
	if err := limiter.Enforce(ctx, key, opts); err != nil {
		t.Fatalf("next window must reset: %v", err)
	}

	// Cleanup drops the expired windows once the clock passes them.
	if _, err := CleanupExpired(ctx, pool); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
}

func TestEnforceTriggerEventConsumesStormBudgetExactlyOnce(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	orgID := "org-trigger-rate-" + suffix
	bucket := "trigger.version.node." + suffix
	base := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	limiter := New(pool, Hooks{})
	limiter.SetNow(func() time.Time { return base })
	opts := Options{Name: bucket, Max: 2, Window: time.Minute}

	insertEvent := func(id string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO trigger_events
			(id,org_id,trigger_type,workflow_id,workflow_version_id,node_id,payload_json)
			VALUES ($1,$2,'pagerduty_incident','workflow','version','trigger','{}'::jsonb)`, id, orgID); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM trigger_events WHERE org_id=$1`, orgID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM rate_limit_windows WHERE name=$1 AND key=$2`, bucket, orgID)
	})

	first := "trigger-event-first-" + suffix
	insertEvent(first)
	var group sync.WaitGroup
	errorsByCall := make(chan error, 12)
	for range 12 {
		group.Add(1)
		go func() {
			defer group.Done()
			errorsByCall <- limiter.EnforceTriggerEvent(ctx, orgID, orgID, first, opts)
		}()
	}
	group.Wait()
	close(errorsByCall)
	for err := range errorsByCall {
		if err != nil {
			t.Fatalf("same accepted event must remain admitted: %v", err)
		}
	}

	var count, windows int
	if err := pool.QueryRow(ctx, `SELECT count FROM rate_limit_windows WHERE name=$1 AND key=$2`, bucket, orgID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("concurrent retries consumed %d storm-budget slots, want 1", count)
	}
	var admittedAt *time.Time
	if err := pool.QueryRow(ctx, `SELECT rate_admitted_at FROM trigger_events WHERE org_id=$1 AND id=$2`, orgID, first).Scan(&admittedAt); err != nil {
		t.Fatal(err)
	}
	if admittedAt == nil || !admittedAt.Equal(base) {
		t.Fatalf("durable admission marker = %v, want %s", admittedAt, base)
	}

	second := "trigger-event-second-" + suffix
	insertEvent(second)
	if err := limiter.EnforceTriggerEvent(ctx, orgID, orgID, second, opts); err != nil {
		t.Fatalf("second distinct event must use the remaining slot: %v", err)
	}
	third := "trigger-event-third-" + suffix
	insertEvent(third)
	err := limiter.EnforceTriggerEvent(ctx, orgID, orgID, third, opts)
	var limited *LimitError
	if !errors.As(err, &limited) {
		t.Fatalf("third distinct event must be rate limited: %v", err)
	}
	var status, reason string
	if err := pool.QueryRow(ctx, `SELECT status, skipped_reason FROM trigger_events WHERE org_id=$1 AND id=$2`, orgID, third).Scan(&status, &reason); err != nil {
		t.Fatal(err)
	}
	if status != "skipped" || reason != "rate_limited" {
		t.Fatalf("over-limit event settlement = %s/%s", status, reason)
	}

	// A delayed relay retry remains admitted even after the fixed window rolls;
	// it must not consume a slot in the new window.
	limiter.SetNow(func() time.Time { return base.Add(time.Minute) })
	if err := limiter.EnforceTriggerEvent(ctx, orgID, orgID, first, opts); err != nil {
		t.Fatalf("delayed retry of admitted event: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM rate_limit_windows WHERE name=$1 AND key=$2`, bucket, orgID).Scan(&windows); err != nil {
		t.Fatal(err)
	}
	if windows != 1 {
		t.Fatalf("admitted retry created %d fixed windows, want 1", windows)
	}

	// Over-limit settlement is also single-winner. A contender that waited on
	// the same row lock must observe the durable skipped state and return a
	// settled signal; it may never reinterpret non-received as admission.
	raceBucket := bucket + "-settlement-race"
	raceEvent := "trigger-event-settlement-race-" + suffix
	insertEvent(raceEvent)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM rate_limit_windows WHERE name=$1 AND key=$2`, raceBucket, orgID)
	})
	raceResults := make(chan error, 2)
	startRace := make(chan struct{})
	for range 2 {
		go func() {
			<-startRace
			raceResults <- limiter.EnforceTriggerEvent(ctx, orgID, orgID, raceEvent, Options{
				Name: raceBucket, Max: 0, Window: time.Minute,
			})
		}()
	}
	close(startRace)
	var limitedResults, settledResults int
	for range 2 {
		err := <-raceResults
		var limit *LimitError
		var settled *TriggerEventSettledError
		switch {
		case errors.As(err, &limit):
			limitedResults++
		case errors.As(err, &settled):
			settledResults++
		default:
			t.Fatalf("unexpected settlement-race result: %v", err)
		}
	}
	if limitedResults != 1 || settledResults != 1 {
		t.Fatalf("settlement race outcomes: limited=%d settled=%d", limitedResults, settledResults)
	}
	if err := pool.QueryRow(ctx, `SELECT status, skipped_reason FROM trigger_events WHERE org_id=$1 AND id=$2`,
		orgID, raceEvent).Scan(&status, &reason); err != nil || status != "skipped" || reason != "rate_limited" {
		t.Fatalf("settlement race durable outcome=%s/%s err=%v", status, reason, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count FROM rate_limit_windows WHERE name=$1 AND key=$2`,
		raceBucket, orgID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("settlement race consumed count=%d err=%v", count, err)
	}

	// A lost Commit acknowledgement is not an ordinary fail-open store error:
	// the transaction may already have settled the event as skipped. Simulate
	// exactly that outcome by committing and then returning a transport error.
	// This attempt must fail closed; its retry observes the durable settlement.
	ambiguousBucket := bucket + "-ambiguous-commit"
	ambiguousEvent := "trigger-event-ambiguous-commit-" + suffix
	insertEvent(ambiguousEvent)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM rate_limit_windows WHERE name=$1 AND key=$2`, ambiguousBucket, orgID)
	})
	ambiguousLimiter := New(pool, Hooks{})
	ambiguousLimiter.SetNow(func() time.Time { return base })
	ambiguousLimiter.commitTx = func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errors.New("lost commit acknowledgement")
	}
	err = ambiguousLimiter.EnforceTriggerEvent(ctx, orgID, orgID, ambiguousEvent, Options{
		Name: ambiguousBucket, Max: 0, Window: time.Minute,
	})
	var indeterminate *TriggerAdmissionIndeterminateError
	if !errors.As(err, &indeterminate) {
		t.Fatalf("ambiguous commit must fail the attempt closed: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT status, skipped_reason FROM trigger_events WHERE org_id=$1 AND id=$2`,
		orgID, ambiguousEvent).Scan(&status, &reason); err != nil || status != "skipped" || reason != "rate_limited" {
		t.Fatalf("ambiguous commit durable outcome=%s/%s err=%v", status, reason, err)
	}
	retryLimiter := New(pool, Hooks{})
	retryErr := retryLimiter.EnforceTriggerEvent(ctx, orgID, orgID, ambiguousEvent, Options{
		Name: ambiguousBucket, Max: 0, Window: time.Minute,
	})
	var settledAfterAmbiguity *TriggerEventSettledError
	if !errors.As(retryErr, &settledAfterAmbiguity) || settledAfterAmbiguity.Status != "skipped" {
		t.Fatalf("retry must converge from committed settlement: %v", retryErr)
	}
}

// Fail-open: a limiter whose pool cannot reach Postgres allows the hit,
// fires the error hook, and never returns an error.
func TestEnforceFailsOpenOnStoreError(t *testing.T) {
	badPool, err := pgxpool.New(context.Background(), "postgres://nobody:nope@127.0.0.1:9/void")
	if err != nil {
		t.Fatalf("bad pool construct: %v", err)
	}
	t.Cleanup(badPool.Close)

	var hookBucket string
	limiter := New(badPool, Hooks{
		OnError: func(bucket, _ string, _ error) { hookBucket = bucket },
		OnSuccess: func(string, string) {
			t.Fatal("success hook must not fire on a dead store")
		},
	})
	if err := limiter.Enforce(context.Background(), "org-x", Options{
		Name: "api:start", Max: 1, Window: time.Minute,
	}); err != nil {
		t.Fatalf("must fail OPEN: %v", err)
	}
	if hookBucket != "api:start" {
		t.Fatalf("error hook must fire with the bucket: %q", hookBucket)
	}
	if err := limiter.EnforceTriggerEvent(context.Background(), "org-x", "org-x", "event-x", Options{
		Name: "trigger:start", Max: 1, Window: time.Minute,
	}); err != nil {
		t.Fatalf("transactional trigger admission must also fail OPEN: %v", err)
	}
	if hookBucket != "trigger:start" {
		t.Fatalf("trigger admission error hook must fire with the bucket: %q", hookBucket)
	}
}

// Degradation lifecycle across two "replicas": the first error audits ONE
// rate_limit.degraded row for (bucket, day) — the second replica's fresh
// in-memory state hits the DB dedupe — same-day repeats stay silent, and
// the first success writes a one-shot rate_limit.recovered.
func TestDegradationAuditsOncePerBucketDay(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	bucket := fmt.Sprintf("bucket-%d", time.Now().UnixNano())
	cause := errors.New("connection refused")

	countRows := func(action string) int {
		var n int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
			WHERE org_id = 'system' AND action = $1
			  AND metadata @> jsonb_build_object('bucket', $2::text)`, action, bucket).Scan(&n)
		return n
	}

	replicaA := NewTracker(pool)
	replicaA.RecordError(bucket, "org-1", cause)
	replicaA.RecordError(bucket, "org-2", cause) // same day: in-memory dedupe
	if got := countRows("rate_limit.degraded"); got != 1 {
		t.Fatalf("replica A must audit once: %d", got)
	}

	replicaB := NewTracker(pool) // fresh memory — the multi-replica case
	replicaB.RecordError(bucket, "org-3", cause)
	if got := countRows("rate_limit.degraded"); got != 1 {
		t.Fatalf("DB dedupe must hold across replicas: %d", got)
	}

	// Health snapshots: public withholds the error string; admin keeps it.
	public := replicaA.Public()
	if public.Healthy || len(public.DegradedBuckets) != 1 || public.DegradedBuckets[0].ErrorCount != 2 {
		t.Fatalf("public snapshot: %+v", public)
	}
	admin := replicaA.Admin()
	if admin.DegradedBuckets[0].LastError != "connection refused" || admin.DegradedBuckets[0].LastObservedKey != "org-2" {
		t.Fatalf("admin snapshot must keep triage fields: %+v", admin)
	}

	// Recovery: one-shot row, state cleared, second success a no-op.
	replicaA.RecordRecovery(bucket, "org-1")
	replicaA.RecordRecovery(bucket, "org-1")
	if got := countRows("rate_limit.recovered"); got != 1 {
		t.Fatalf("recovery must audit once: %d", got)
	}
	if !replicaA.Public().Healthy {
		t.Fatal("recovered tracker must report healthy")
	}

	// The degraded row's metadata matches the contract shape (no actor).
	var raw string
	_ = pool.QueryRow(ctx, `SELECT metadata::text FROM audit_logs
		WHERE org_id = 'system' AND action = 'rate_limit.degraded'
		  AND metadata @> jsonb_build_object('bucket', $1::text)`, bucket).Scan(&raw)
	if !strings.Contains(raw, `"lastError": "connection refused"`) || strings.Contains(raw, `"actor"`) {
		t.Fatalf("degraded metadata shape: %s", raw)
	}
}
