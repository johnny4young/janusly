//go:build integration

package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// farFuture starts keyset walks: any real row sorts before it.
var farFuture = time.Now().Add(24 * time.Hour)

func newHarness(t *testing.T) (context.Context, *pgxpool.Pool, *Queries, string) {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	// A fresh org per test keeps reruns and parallel tests isolated without
	// truncating shared tables.
	raw := make([]byte, 8)
	_, _ = rand.Read(raw)
	suffix := hex.EncodeToString(raw)
	return ctx, pool, New(pool), "org-test-" + suffix
}

// uid derives rerun-safe identifiers: the shared tables persist between test
// runs, so every primary key must be unique per invocation, not per test.
func uid(org, name string) string { return name + "-" + org[len(org)-8:] }

func text(v string) pgtype.Text { return pgtype.Text{String: v, Valid: true} }

func seedRun(t *testing.T, ctx context.Context, q *Queries, org, runID string) {
	t.Helper()
	if err := q.InsertWorkflow(ctx, InsertWorkflowParams{ID: "wf-" + runID, OrgID: org, Name: "wf", CreatedBy: text("tester")}); err != nil {
		t.Fatalf("insert workflow: %v", err)
	}
	if err := q.InsertWorkflowVersion(ctx, InsertWorkflowVersionParams{
		ID: "wfv-" + runID, OrgID: org, WorkflowID: "wf-" + runID, Version: 1,
		DagJson: json.RawMessage(`{"nodes":[],"edges":[]}`), CreatedBy: text("tester"),
	}); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if err := q.InsertRun(ctx, InsertRunParams{
		ID: runID, OrgID: org, WorkflowVersionID: "wfv-" + runID, Status: "running",
		InputJson: json.RawMessage(`{"b":1,"a":2}`), CreatedBy: text("tester"),
	}); err != nil {
		t.Fatalf("insert run: %v", err)
	}
}

func TestRunRoundTripKeepsRawJSON(t *testing.T) {
	ctx, _, q, org := newHarness(t)
	runID := uid(org, "run-json")
	seedRun(t, ctx, q, org, runID)

	got, err := q.GetRun(ctx, GetRunParams{ID: runID, OrgID: org})
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	// Postgres jsonb normalizes on write (alphabetical keys, canonical
	// spacing) — identically for Node, which stores through the same column
	// type. The raw passthrough guarantees Go adds NO second re-encoding on
	// top: the bytes read back are exactly the PG-normalized form.
	if !bytes.Equal(got.InputJson, []byte(`{"a": 2, "b": 1}`)) {
		t.Fatalf("expected the pg-normalized form untouched by Go, got: %s", got.InputJson)
	}
	var parsed map[string]int
	if err := json.Unmarshal(got.InputJson, &parsed); err != nil || parsed["a"] != 2 || parsed["b"] != 1 {
		t.Fatalf("semantic content lost: %s (%v)", got.InputJson, err)
	}
	if got.Status != "running" || got.WorkflowVersionID != "wfv-"+runID {
		t.Fatalf("unexpected run row: %+v", got)
	}

	if _, err := q.GetRun(ctx, GetRunParams{ID: runID, OrgID: "another-org"}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-org read must miss, got: %v", err)
	}
}

func TestInsertTriggerEventConcurrentDeterministicIdentityConverges(t *testing.T) {
	ctx, _, q, org := newHarness(t)
	runID := uid(org, "run-trigger-anchor")
	seedRun(t, ctx, q, org, runID)
	eventID := uid(org, "provider-event")
	dedupeKey := "provider:" + eventID
	params := InsertTriggerEventParams{
		ID: eventID, OrgID: org, TriggerType: "pagerduty_incident",
		WorkflowID:        text("wf-" + runID),
		WorkflowVersionID: "wfv-" + runID,
		NodeID:            "on_provider",
		DedupeKey:         text(dedupeKey),
		PayloadJson:       json.RawMessage(`{"event":{"id":"same-delivery"}}`),
	}

	const contenders = 16
	start := make(chan struct{})
	results := make(chan struct {
		created int64
		err     error
	}, contenders)
	var group sync.WaitGroup
	for range contenders {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			created, err := q.InsertTriggerEvent(ctx, params)
			results <- struct {
				created int64
				err     error
			}{created: created, err: err}
		}()
	}
	close(start)
	group.Wait()
	close(results)

	var inserts int64
	for result := range results {
		if result.err != nil {
			t.Fatalf("same deterministic delivery raised a unique conflict: %v", result.err)
		}
		inserts += result.created
	}
	if inserts != 1 {
		t.Fatalf("concurrent delivery inserted %d rows, want 1", inserts)
	}
	stored, err := q.FindTriggerEventByDedupe(ctx, FindTriggerEventByDedupeParams{
		OrgID: org, DedupeKey: text(dedupeKey),
	})
	if err != nil || stored.ID != eventID || stored.Status != "received" {
		t.Fatalf("durable delivery did not converge: row=%+v err=%v", stored, err)
	}
}

func TestListRunsKeysetStableUnderTies(t *testing.T) {
	ctx, pool, q, org := newHarness(t)
	ids := []string{uid(org, "run-a"), uid(org, "run-b"), uid(org, "run-c")}
	for _, id := range ids {
		seedRun(t, ctx, q, org, id)
	}
	// Force identical timestamps so only the id tiebreak orders the page.
	tie := time.Now().Truncate(time.Millisecond)
	if _, err := pool.Exec(ctx, "update runs set created_at=$1 where org_id=$2", tie, org); err != nil {
		t.Fatalf("force ties: %v", err)
	}

	page1, err := q.ListRuns(ctx, ListRunsParams{OrgID: org, BeforeCreatedAt: farFuture, BeforeID: "zzz", PageLimit: 2})
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(page1) != 2 || page1[0].ID != ids[2] || page1[1].ID != ids[1] {
		t.Fatalf("unexpected first page: %+v", page1)
	}
	last := page1[len(page1)-1]
	page2, err := q.ListRuns(ctx, ListRunsParams{OrgID: org, BeforeCreatedAt: *last.CreatedAt, BeforeID: last.ID, PageLimit: 2})
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2) != 1 || page2[0].ID != ids[0] {
		t.Fatalf("cursor skipped or repeated rows: %+v", page2)
	}
}

func TestRunNodeTransitionsAreCompareAndSet(t *testing.T) {
	ctx, pool, q, org := newHarness(t)
	casNow := time.Now().UTC()
	casRun := uid(org, "run-cas")
	seedRun(t, ctx, q, org, casRun)
	if _, err := q.InsertRunNodes(ctx, []InsertRunNodesParams{{ID: uid(org, "rn"), RunID: casRun, NodeID: "step", Status: "pending"}}); err != nil {
		t.Fatalf("insert node: %v", err)
	}

	if rows, _ := q.QueueRunNode(ctx, QueueRunNodeParams{RunID: casRun, NodeID: "step"}); rows != 1 {
		t.Fatalf("first queue must win, rows=%d", rows)
	}
	if rows, _ := q.QueueRunNode(ctx, QueueRunNodeParams{RunID: casRun, NodeID: "step"}); rows != 0 {
		t.Fatalf("second queue must lose, rows=%d", rows)
	}

	// Completion requires the running state; a queued node must not complete.
	if rows, _ := q.CompleteRunNode(ctx, CompleteRunNodeParams{RunID: casRun, NodeID: "step", StateJson: json.RawMessage(`{}`), FinishedAt: &casNow}); rows != 0 {
		t.Fatalf("complete from queued must lose, rows=%d", rows)
	}
	if _, err := pool.Exec(ctx, "update run_nodes set status='running' where run_id=$1", casRun); err != nil {
		t.Fatalf("promote to running: %v", err)
	}
	if rows, _ := q.CompleteRunNode(ctx, CompleteRunNodeParams{RunID: casRun, NodeID: "step", StateJson: json.RawMessage(`{"output":{"ok":true}}`), FinishedAt: &casNow}); rows != 1 {
		t.Fatalf("complete from running must win, rows=%d", rows)
	}

	node, err := q.GetRunNode(ctx, GetRunNodeParams{RunID: casRun, NodeID: "step"})
	if err != nil || node.Status != "succeeded" || node.FinishedAt == nil {
		t.Fatalf("unexpected node after completion: %+v err=%v", node, err)
	}
}

func TestDeadLetterClaimHappensOnce(t *testing.T) {
	ctx, _, q, org := newHarness(t)
	dlqRun := uid(org, "run-dlq")
	seedRun(t, ctx, q, org, dlqRun)
	err := q.InsertDeadLetter(ctx, InsertDeadLetterParams{
		ID: uid(org, "dl"), OrgID: org, RunID: dlqRun, NodeID: "step", Attempt: 3,
		WorkflowJson: json.RawMessage(`{}`), NodeJson: json.RawMessage(`{}`),
		ErrorJson: json.RawMessage(`{"message":"upstream timeout"}`),
	})
	if err != nil {
		t.Fatalf("insert dead letter: %v", err)
	}

	got, err := q.GetDeadLetter(ctx, GetDeadLetterParams{ID: uid(org, "dl"), OrgID: org})
	if err != nil || got.Status != "open" || got.ReplayClaimedAt != nil {
		t.Fatalf("unexpected dead letter: %+v err=%v", got, err)
	}

	if rows, _ := q.ClaimDeadLetterReplay(ctx, ClaimDeadLetterReplayParams{ID: uid(org, "dl"), OrgID: org}); rows != 1 {
		t.Fatalf("first claim must win, rows=%d", rows)
	}
	if rows, _ := q.ClaimDeadLetterReplay(ctx, ClaimDeadLetterReplayParams{ID: uid(org, "dl"), OrgID: org}); rows != 0 {
		t.Fatalf("second claim must lose, rows=%d", rows)
	}
}

func TestWakeupsLifecycle(t *testing.T) {
	ctx, _, q, org := newHarness(t)
	due, later := uid(org, "rn-due"), uid(org, "rn-later")
	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)

	// Anchor both wake-ups to real WAITING node rows: engine test suites
	// running concurrently against the shared database sweep due wake-ups
	// of non-waiting nodes, and these must survive that garbage collection.
	anchorRun := uid(org, "run-wake")
	seedRun(t, ctx, q, org, anchorRun)
	for _, rowID := range []string{due, later} {
		if _, err := q.InsertRunNodes(ctx, []InsertRunNodesParams{{
			ID: rowID, RunID: anchorRun, NodeID: "wait-" + rowID[:8], Status: "waiting",
		}}); err != nil {
			t.Fatalf("insert waiting anchor: %v", err)
		}
	}

	if err := q.UpsertWakeup(ctx, UpsertWakeupParams{RunNodeID: due, WakeAt: past, Reason: "retry"}); err != nil {
		t.Fatalf("upsert due: %v", err)
	}
	if err := q.UpsertWakeup(ctx, UpsertWakeupParams{RunNodeID: later, WakeAt: future, Reason: "wait_until"}); err != nil {
		t.Fatalf("upsert later: %v", err)
	}
	t.Cleanup(func() {
		_ = q.DeleteWakeup(context.Background(), due)
		_ = q.DeleteWakeup(context.Background(), later)
	})

	dueRows, err := q.ListDueWakeups(ctx, 1000)
	if err != nil {
		t.Fatalf("list due: %v", err)
	}
	found := map[string]bool{}
	for _, w := range dueRows {
		found[w.RunNodeID] = true
	}
	if !found[due] || found[later] {
		t.Fatalf("due filter wrong: %+v", dueRows)
	}

	if err := q.DeleteWakeup(ctx, due); err != nil {
		t.Fatalf("delete: %v", err)
	}
}
