//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// countAudit counts audit rows for one org+action pair.
func countAudit(t *testing.T, pool *pgxpool.Pool, org, action string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = $2`,
		org, action).Scan(&n); err != nil {
		t.Fatalf("count audit %s: %v", action, err)
	}
	return n
}

// waitNodeWaiting polls until some node of the run pauses as waiting.
func waitNodeWaiting(t *testing.T, h *apiHarness, runID string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		res := h.call("GET", "/v1/run?runId="+runID, nil, "")
		nodes, _ := res.body["data"].(map[string]any)["nodes"].([]any)
		for _, n := range nodes {
			if n.(map[string]any)["status"] == "waiting" {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("node never waited")
		}
		time.Sleep(30 * time.Millisecond)
	}
}

// Every wave-1/2 mutation writes its reference-named audit row: the
// workflow lifecycle (save, rollback, soft delete, restore), the run
// lifecycle (adhoc start, resume, cancel), and the DLQ replay.
func TestAuditRetrofitWorkflowAndRunLifecycle(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()

	// Workflow lifecycle: two saves, a rollback, delete + restore.
	wfID := "wf-audit-" + h.org
	doc := map[string]any{
		"id": wfID, "name": "Audit Flow",
		"nodes": []any{map[string]any{"id": "n1", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	first := h.call("POST", "/workflows/save", doc, "")
	if first.status != 200 {
		t.Fatalf("save: %+v", first.body)
	}
	sourceVersionID := first.body["versionId"].(string)
	if res := h.call("POST", "/workflows/save", doc, ""); res.status != 200 {
		t.Fatalf("save v2: %+v", res.body)
	}
	if res := h.call("POST", "/workflows/rollback", map[string]any{
		"workflowId": wfID, "sourceVersionId": sourceVersionID,
	}, ""); res.status != 200 {
		t.Fatalf("rollback: %+v", res.body)
	}
	if res := h.call("DELETE", "/workflows/"+wfID, nil, ""); res.status != 200 {
		t.Fatalf("delete: %+v", res.body)
	}
	if res := h.call("POST", "/workflows/"+wfID+"/restore", nil, ""); res.status != 200 {
		t.Fatalf("restore: %+v", res.body)
	}

	// Run lifecycle: one approval run resumed to completion, one cancelled.
	approval := map[string]any{
		"nodes": []any{
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{"message": "audit"}},
		},
		"edges": []any{},
	}
	resumed := h.call("POST", "/v1/start", map[string]any{"workflow": approval}, "")
	resumedRunID := resumed.body["data"].(map[string]any)["runId"].(string)
	waitNodeWaiting(t, h, resumedRunID)
	if res := h.call("POST", "/v1/resume", map[string]any{
		"runId": resumedRunID, "nodeId": "gate",
	}, ""); res.status != 200 {
		t.Fatalf("resume: %+v", res.body)
	}
	h.waitRun(resumedRunID, "succeeded")

	cancelled := h.call("POST", "/v1/start", map[string]any{"workflow": approval}, "")
	cancelledRunID := cancelled.body["data"].(map[string]any)["runId"].(string)
	waitNodeWaiting(t, h, cancelledRunID)
	if res := h.call("POST", "/v1/run/cancel", map[string]any{
		"runId": cancelledRunID, "reason": "operator stop",
	}, ""); res.status != 200 {
		t.Fatalf("cancel: %+v", res.body)
	}

	// DLQ replay: fail a run, replay its dead letter through the API.
	failRun(t, h, "wf-audit-dlq-"+h.org)
	ids := deadLetterIDs(t, h)
	if len(ids) != 1 {
		t.Fatalf("want 1 dead letter, got %v", ids)
	}
	if res := h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": ids[0]}, ""); res.status != 200 {
		t.Fatalf("dlq replay: %+v", res.body)
	}

	for action, want := range map[string]int{
		"workflow.saved":       2,
		"workflow.rolled_back": 1,
		"workflow.deleted":     1,
		"workflow.restored":    1,
		"run.started.adhoc":    3, // two approval runs + the failed run; the replay revives in place, never a fourth start
		"run.resumed":          1,
		"run.cancelled":        1,
		"dlq.replayed":         1,
	} {
		if got := countAudit(t, pool, h.org, action); got != want {
			t.Fatalf("%s: want %d rows, got %d", action, want, got)
		}
	}

	// The enriched forensic block rides every retrofit row too.
	var raw []byte
	if err := pool.QueryRow(ctx, `SELECT metadata FROM audit_logs
		WHERE org_id = $1 AND action = 'run.cancelled'`, h.org).Scan(&raw); err != nil {
		t.Fatalf("read cancelled row: %v", err)
	}
	var metadata map[string]any
	_ = json.Unmarshal(raw, &metadata)
	if metadata["reason"] != "operator stop" || metadata["source"] == nil || metadata["actor"] == nil {
		t.Fatalf("cancelled metadata must carry reason + actor block: %+v", metadata)
	}
}
