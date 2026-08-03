//go:build integration

package ratelimit

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

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
// carries the reference's verbatim message, the next window resets, and
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

	// The degraded row's metadata matches the reference shape (no actor).
	var raw string
	_ = pool.QueryRow(ctx, `SELECT metadata::text FROM audit_logs
		WHERE org_id = 'system' AND action = 'rate_limit.degraded'
		  AND metadata @> jsonb_build_object('bucket', $1::text)`, bucket).Scan(&raw)
	if !strings.Contains(raw, `"lastError": "connection refused"`) || strings.Contains(raw, `"actor"`) {
		t.Fatalf("degraded metadata shape: %s", raw)
	}
}
