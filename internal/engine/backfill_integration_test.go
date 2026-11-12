//go:build integration

package engine

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

// statementHookTx runs before on the first statement whose sqlc name matches,
// and fails that statement when fail is set.
type statementHookTx struct {
	store.DBTX
	name   string
	before func()
	fail   bool
}

func (h *statementHookTx) hit(sql string) bool {
	if !strings.Contains(sql, "-- name: "+h.name+" ") {
		return false
	}
	if h.before != nil {
		before := h.before
		h.before = nil
		before()
	}
	return h.fail
}

func (h *statementHookTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if h.hit(sql) {
		return pgconn.CommandTag{}, errInjected
	}
	return h.DBTX.Exec(ctx, sql, args...)
}

func (h *statementHookTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if h.hit(sql) {
		return nil, errInjected
	}
	return h.DBTX.Query(ctx, sql, args...)
}

func (h *statementHookTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if h.hit(sql) {
		return errRow{}
	}
	return h.DBTX.QueryRow(ctx, sql, args...)
}

const backfillDoc = `{"id":"%s","name":"backfill","nodes":[
	{"id":"inbox","type":"webhook_received","config":{"endpointKey":"hook"}},
	{"id":"after","type":"noop","config":{}}
],"edges":[{"from":"inbox","to":"after"}]}`

// seedPausedWorkflowWithBuffer saves a webhook workflow, pauses it and buffers
// count trigger events oldest-first.
func seedPausedWorkflowWithBuffer(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, org string, count int) string {
	t.Helper()
	workflowID := "wf-backfill-" + org
	saved, err := eng.SaveWorkflowVersion(ctx, SaveWorkflowVersionInput{
		OrgID: org, UserID: "user-1", Workflow: mustParse(t, fmt.Sprintf(backfillDoc, workflowID)),
	})
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workflows SET status = 'paused_manual' WHERE org_id = $1 AND id = $2`, org, workflowID); err != nil {
		t.Fatalf("pause: %v", err)
	}
	for i := range count {
		if _, err := pool.Exec(ctx, `INSERT INTO trigger_events
			(id, org_id, trigger_type, workflow_id, workflow_version_id, node_id, status, payload_json, created_at)
			VALUES ($1, $2, 'webhook_received', $3, $4, 'inbox', 'buffered', '{"event":{"n":1}}', now() - make_interval(secs => $5))`,
			fmt.Sprintf("te-%s-%d", org, i), org, workflowID, saved.VersionID, count-i); err != nil {
			t.Fatalf("buffer event %d: %v", i, err)
		}
	}
	return workflowID
}

func bufferedState(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org string) (buffered, claimed, started int) {
	t.Helper()
	if err := pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE status = 'buffered'),
		count(*) FILTER (WHERE status = 'buffered' AND backfill_claim_token IS NOT NULL),
		count(*) FILTER (WHERE status = 'started')
		FROM trigger_events WHERE org_id = $1`, org).Scan(&buffered, &claimed, &started); err != nil {
		t.Fatalf("trigger events: %v", err)
	}
	return buffered, claimed, started
}

// A pause that lands while a resume drains its page holds the rest of the page.
func TestBackfillPageStopsWhenPausedMidPage(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	workflowID := seedPausedWorkflowWithBuffer(t, ctx, pool, eng, org, 3)
	eng.wrapTx = func(tx store.DBTX) store.DBTX {
		return &statementHookTx{DBTX: tx, name: "InsertRun", before: func() {
			if _, err := pool.Exec(ctx, `UPDATE workflows SET status = 'paused_manual' WHERE org_id = $1 AND id = $2`, org, workflowID); err != nil {
				t.Errorf("pause mid-page: %v", err)
			}
		}}
	}

	outcome, lifted, err := eng.ResumeWorkflow(ctx, org, workflowID, "user-1")
	if err != nil || lifted != WorkflowStatusPausedManual {
		t.Fatalf("resume: lifted=%q err=%v", lifted, err)
	}
	if outcome.Backfilled != 1 || outcome.Failed != 0 || outcome.Remaining != 2 {
		t.Fatalf("outcome = %+v, want 1 backfilled and 2 remaining", outcome)
	}
	if buffered, claimed, started := bufferedState(t, ctx, pool, org); buffered != 2 || claimed != 0 || started != 1 {
		t.Fatalf("buffered=%d claimed=%d started=%d, want 2/0/1", buffered, claimed, started)
	}
}

// An event whose start fails goes back to the buffer, so the next resume retries it.
func TestBackfillReleasesClaimWhenStartFails(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	workflowID := seedPausedWorkflowWithBuffer(t, ctx, pool, eng, org, 1)
	healthy := eng.wrapTx
	eng.wrapTx = func(tx store.DBTX) store.DBTX { return &statementHookTx{DBTX: tx, name: "InsertRun", fail: true} }

	outcome, _, err := eng.ResumeWorkflow(ctx, org, workflowID, "user-1")
	if err != nil {
		t.Fatalf("resume: %v", err)
	}
	if outcome.Backfilled != 0 || outcome.Failed != 1 || outcome.Remaining != 1 {
		t.Fatalf("failed start outcome = %+v, want 1 failed and 1 remaining", outcome)
	}
	if buffered, claimed, _ := bufferedState(t, ctx, pool, org); buffered != 1 || claimed != 0 {
		t.Fatalf("buffered=%d claimed=%d, want the event back in the buffer unclaimed", buffered, claimed)
	}

	eng.wrapTx = healthy
	retried, _, err := eng.ResumeWorkflow(ctx, org, workflowID, "user-1")
	if err != nil || retried.Backfilled != 1 || retried.Remaining != 0 {
		t.Fatalf("retry: %+v err=%v", retried, err)
	}
}
