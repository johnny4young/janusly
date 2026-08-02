//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// T-517: the Replay Lab. A whole-run sandbox replay NEVER executes
// write-sides, a patched replay runs the edited doc without touching
// workflow_versions, lineage is trace-only, and the targeted fork clones
// succeeded predecessors, honors the input override, and skips
// unrelated branches.

func TestReplayLabWholeRun(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())

	var writes atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			writes.Add(1)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer target.Close()

	workflow := map[string]any{
		"id": "wf-lab-" + suffix, "name": "Lab", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "shape", "type": "transform", "config": map[string]any{"mapping": map[string]any{"v": "{{context.input.tag}}"}}},
			map[string]any{"id": "post", "type": "http", "config": map[string]any{
				"url": target.URL, "method": "POST", "retry": map[string]any{"maxAttempts": 1},
			}},
		},
		"edges": []any{map[string]any{"from": "shape", "to": "post"}},
	}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": workflow, "input": map[string]any{"tag": "orig"}}, "")
	sourceRunID := extractRunID(t, started)
	h.waitRun(sourceRunID, "succeeded")
	if writes.Load() != 1 {
		t.Fatalf("source run must write once, got %d", writes.Load())
	}

	// Whole-run sandbox: write-side POST is SKIPPED (counter frozen).
	lab := h.call("POST", "/runs/replay-lab", map[string]any{"sourceRunId": sourceRunID}, "")
	if lab.status != 200 {
		t.Fatalf("replay-lab: %d %+v", lab.status, lab.body)
	}
	labRunID := lab.body["runId"].(string)
	h.waitRun(labRunID, "succeeded")
	if writes.Load() != 1 {
		t.Fatalf("sandbox replay must never execute write-sides, counter=%d", writes.Load())
	}

	// Lineage visible on the detail: trace-only replay edge + sandbox tag.
	detail := h.call("GET", "/v1/run?runId="+labRunID, nil, "")
	run := detail.body["data"].(map[string]any)["run"].(map[string]any)
	if run["parentRunId"] != sourceRunID || run["replayMode"] != "validation" {
		t.Fatalf("lineage: %+v", run)
	}
	// Trigger input propagated so {{context.input.*}} resolves identically.
	var labState string
	_ = pool.QueryRow(ctx, `SELECT state_json::text FROM run_nodes WHERE run_id = $1 AND node_id = 'shape'`, labRunID).Scan(&labState)
	if !strings.Contains(labState, "orig") {
		t.Fatalf("trigger input must propagate: %s", labState)
	}

	// Nested labs rejected.
	if res := h.call("POST", "/runs/replay-lab", map[string]any{"sourceRunId": labRunID}, ""); res.status != 400 {
		t.Fatalf("nested lab must 400: %d %+v", res.status, res.body)
	}
	// Unknown/cross-org id → identical 404.
	if res := h.call("POST", "/runs/replay-lab", map[string]any{"sourceRunId": "nope"}, ""); res.status != 404 {
		t.Fatalf("unknown source must 404: %d", res.status)
	}

	// Patched replay: runs the EDITED doc, creates no workflow_versions row.
	var versionsBefore int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_versions WHERE org_id = $1`, h.org).Scan(&versionsBefore)
	patched := map[string]any{
		"id": "wf-lab-" + suffix, "name": "Lab patched", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "only", "type": "transform", "config": map[string]any{"mapping": map[string]any{"v": "patched"}}}},
		"edges": []any{},
	}
	forked := h.call("POST", "/runs/replay-lab", map[string]any{
		"sourceRunId": sourceRunID, "suggestedWorkflow": patched,
	}, "")
	if forked.status != 200 {
		t.Fatalf("patched lab: %d %+v", forked.status, forked.body)
	}
	patchedRunID := forked.body["runId"].(string)
	h.waitRun(patchedRunID, "succeeded")
	var patchedState string
	_ = pool.QueryRow(ctx, `SELECT state_json::text FROM run_nodes WHERE run_id = $1 AND node_id = 'only'`, patchedRunID).Scan(&patchedState)
	if !strings.Contains(patchedState, "patched") {
		t.Fatalf("patched doc must run: %s", patchedState)
	}
	var versionsAfter int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_versions WHERE org_id = $1`, h.org).Scan(&versionsAfter)
	if versionsAfter != versionsBefore {
		t.Fatalf("lab must not touch versions: %d -> %d", versionsBefore, versionsAfter)
	}

	// Audits landed for both intents.
	var audits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'replay_lab.started'`, h.org).Scan(&audits)
	if audits != 2 {
		t.Fatalf("expected 2 replay_lab.started audits, got %d", audits)
	}
}

func TestReplayLabFork(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())

	// a → b → c plus an unrelated root branch d.
	workflow := map[string]any{
		"id": "wf-fork-" + suffix, "name": "Fork", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "a", "type": "transform", "config": map[string]any{"mapping": map[string]any{"seed": "from-a"}}},
			map[string]any{"id": "b", "type": "transform", "config": map[string]any{"mapping": map[string]any{"got": "{{context.a.output.seed}}"}}},
			map[string]any{"id": "c", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "d", "type": "transform", "config": map[string]any{"mapping": map[string]any{"solo": "root"}}},
		},
		"edges": []any{
			map[string]any{"from": "a", "to": "b"},
			map[string]any{"from": "b", "to": "c"},
		},
	}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	sourceRunID := extractRunID(t, started)
	h.waitRun(sourceRunID, "succeeded")

	// Validation ladder.
	if res := h.call("POST", "/runs/replay-lab/fork", map[string]any{"sourceRunId": sourceRunID}, ""); res.status != 400 {
		t.Fatalf("missing forkNodeId must 400: %d", res.status)
	}
	if res := h.call("POST", "/runs/replay-lab/fork", map[string]any{
		"sourceRunId": sourceRunID, "forkNodeId": "ghost",
	}, ""); res.status != 422 {
		t.Fatalf("unknown fork node must 422: %d %+v", res.status, res.body)
	}

	// Fork at b with an input override: a cloned succeeded, b re-runs,
	// c cascades, d (unrelated branch) skipped.
	forked := h.call("POST", "/runs/replay-lab/fork", map[string]any{
		"sourceRunId": sourceRunID, "forkNodeId": "b",
		"inputOverride": map[string]any{"tweak": true},
	}, "")
	if forked.status != 200 || forked.body["predecessorCount"] != float64(1) {
		t.Fatalf("fork: %d %+v", forked.status, forked.body)
	}
	forkRunID := forked.body["runId"].(string)
	h.waitRun(forkRunID, "succeeded")

	rows := map[string]struct{ status, state string }{}
	rowsQuery, err := pool.Query(ctx, `SELECT node_id, status, state_json::text FROM run_nodes WHERE run_id = $1`, forkRunID)
	if err != nil {
		t.Fatalf("nodes: %v", err)
	}
	for rowsQuery.Next() {
		var nodeID, status, state string
		_ = rowsQuery.Scan(&nodeID, &status, &state)
		rows[nodeID] = struct{ status, state string }{status, state}
	}
	rowsQuery.Close()
	if rows["a"].status != "succeeded" || !strings.Contains(rows["a"].state, "from-a") {
		t.Fatalf("predecessor must be cloned succeeded: %+v", rows["a"])
	}
	if rows["b"].status != "succeeded" || !strings.Contains(rows["b"].state, "from-a") {
		t.Fatalf("fork node must re-run reading cloned upstream: %+v", rows["b"])
	}
	if rows["c"].status != "succeeded" {
		t.Fatalf("downstream must cascade: %+v", rows["c"])
	}
	if rows["d"].status != "skipped" || !strings.Contains(rows["d"].state, "outside_replay_fork") {
		t.Fatalf("unrelated branch must be skipped: %+v", rows["d"])
	}
	var parentNodeID string
	_ = pool.QueryRow(ctx, `SELECT coalesce(parent_node_id,'') FROM runs WHERE id = $1`, forkRunID).Scan(&parentNodeID)
	if parentNodeID != "b" {
		t.Fatalf("fork lineage must carry the fork node: %q", parentNodeID)
	}

	// predecessor_not_succeeded: fail a run at `a`, then fork at b.
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	failing := map[string]any{
		"id": "wf-fork-fail-" + suffix, "name": "FF", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "a", "type": "http", "config": map[string]any{
				"url": "http://127.0.0.1:1/unreachable", "retry": map[string]any{"maxAttempts": 1},
			}},
			map[string]any{"id": "b", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "a", "to": "b"}},
	}
	failedStart := h.call("POST", "/v1/start", map[string]any{"workflow": failing}, "")
	failedRunID := extractRunID(t, failedStart)
	h.waitRun(failedRunID, "failed")
	if res := h.call("POST", "/runs/replay-lab/fork", map[string]any{
		"sourceRunId": failedRunID, "forkNodeId": "b",
	}, ""); res.status != 422 {
		t.Fatalf("failed predecessor must 422: %d %+v", res.status, res.body)
	}

	// Oversized override rejected up-front.
	if res := h.call("POST", "/runs/replay-lab/fork", map[string]any{
		"sourceRunId": sourceRunID, "forkNodeId": "b",
		"inputOverride": map[string]any{"blob": strings.Repeat("x", 70_000)},
	}, ""); res.status != 422 || res.body["code"] != "override_too_large" {
		t.Fatalf("oversized override must 422: %d %+v", res.status, res.body)
	}

	var audits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'replay_lab.fork_started'`, h.org).Scan(&audits)
	if audits != 1 {
		t.Fatalf("expected 1 fork audit, got %d", audits)
	}
}
