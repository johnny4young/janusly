//go:build integration

package httpapi

import (
	"context"
	"testing"
	"time"
)

func TestRunComparisonProjectsTenantScopedNodeDiff(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	baseID, replayID := "compare-base-"+h.org, "compare-replay-"+h.org
	otherID := "compare-other-" + h.org
	otherOrg := h.org + "-other"
	createdAt := time.Now().UTC().Truncate(time.Millisecond)

	if _, err := pool.Exec(ctx, `INSERT INTO runs
		(id, org_id, workflow_version_id, status, input_json, replay_mode, parent_run_id, created_at)
		VALUES ($1, $2, 'wv-base', 'succeeded', '{}', NULL, NULL, $4),
		       ($3, $2, 'wv-replay', 'failed', '{}', 'validation', $1, $4),
		       ($5, $6, 'wv-other', 'succeeded', '{}', NULL, NULL, $4)`,
		baseID, h.org, replayID, createdAt, otherID, otherOrg); err != nil {
		t.Fatalf("seed runs: %v", err)
	}
	started := createdAt.Add(time.Second)
	if _, err := pool.Exec(ctx, `INSERT INTO run_nodes
		(id, run_id, node_id, status, state_json, error_json, started_at, finished_at)
		VALUES
		  ($1, $2, 'alpha', 'succeeded', '{"output":{"ok":true},"private":"hidden"}', NULL, $7, $8),
		  ($3, $2, 'beta', 'failed', '{"checkpoint":"base"}', '{"name":"BaseError"}', $8, $7),
		  ($4, $5, 'beta', 'succeeded', '{"output":"fixed"}', NULL, $7, $9),
		  ($6, $5, 'zeta', 'waiting', '{"waiting":{"reason":"approval"}}', NULL, $7, NULL)`,
		baseID+"-alpha", baseID, baseID+"-beta", replayID+"-beta", replayID,
		replayID+"-zeta", started, started.Add(1500*time.Millisecond), started.Add(250*time.Millisecond)); err != nil {
		t.Fatalf("seed nodes: %v", err)
	}
	seedUsage := func(id, orgID, runID string, quantity int, metadata string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO usage_events
			(id, org_id, run_id, metric, quantity, metadata)
			VALUES ($1, $2, $3, 'llm.completion', $4, $5)`,
			id, orgID, runID, quantity, metadata); err != nil {
			t.Fatalf("seed usage: %v", err)
		}
	}
	seedUsage(baseID+"-u1", h.org, baseID, 10, `{"nodeId":"alpha","costUsd":0.1}`)
	seedUsage(baseID+"-u2", h.org, baseID, 5, `{"nodeId":"alpha","costUsd":null}`)
	seedUsage(baseID+"-u3", h.org, baseID, 3, `{"nodeId":"beta","costUsd":null}`)
	seedUsage(replayID+"-u1", h.org, replayID, 7, `{"nodeId":"beta","costUsd":0.2}`)
	seedUsage(replayID+"-unattributed", h.org, replayID, 999, `{"costUsd":10}`)
	// Same run id but another tenant must never contaminate the aggregate.
	seedUsage(baseID+"-foreign", otherOrg, baseID, 999, `{"nodeId":"alpha","costUsd":999}`)

	if res := h.call("GET", "/runs/compare", nil, ""); res.status != 400 ||
		res.body["code"] != "runs_base_and_replay_run_id_required" {
		t.Fatalf("missing ids: %d %+v", res.status, res.body)
	}
	if res := h.call("GET", "/runs/compare?baseRunId="+otherID+"&replayRunId="+replayID, nil, ""); res.status != 404 || res.body["code"] != "runs_compare_run_not_found" || res.body["error"] != "Base run not found" {
		t.Fatalf("cross-org base: %d %+v", res.status, res.body)
	}
	if res := h.call("GET", "/runs/compare?baseRunId="+baseID+"&replayRunId="+otherID, nil, ""); res.status != 404 || res.body["code"] != "runs_compare_run_not_found" || res.body["error"] != "Replay run not found" {
		t.Fatalf("cross-org replay: %d %+v", res.status, res.body)
	}

	res := h.call("GET", "/runs/compare?baseRunId="+baseID+"&replayRunId="+replayID, nil, "")
	if res.status != 200 {
		t.Fatalf("comparison: %d %+v", res.status, res.body)
	}
	base := res.body["baseRun"].(map[string]any)
	replay := res.body["replayRun"].(map[string]any)
	if base["id"] != baseID || base["status"] != "succeeded" || base["replayMode"] != nil || base["parentRunId"] != nil {
		t.Fatalf("base summary: %+v", base)
	}
	if replay["id"] != replayID || replay["status"] != "failed" || replay["replayMode"] != "validation" || replay["parentRunId"] != baseID {
		t.Fatalf("replay summary: %+v", replay)
	}
	if base["createdAt"] != createdAt.Format("2006-01-02T15:04:05.000Z") {
		t.Fatalf("createdAt projection: %+v", base)
	}

	nodes := res.body["perNode"].([]any)
	if len(nodes) != 3 {
		t.Fatalf("node union: %+v", nodes)
	}
	alpha := nodes[0].(map[string]any)
	beta := nodes[1].(map[string]any)
	zeta := nodes[2].(map[string]any)
	if alpha["nodeId"] != "alpha" || beta["nodeId"] != "beta" || zeta["nodeId"] != "zeta" {
		t.Fatalf("stable node order: %+v", nodes)
	}
	alphaBase := alpha["base"].(map[string]any)
	alphaReplay := alpha["replay"].(map[string]any)
	if alphaBase["latencyMs"] != float64(1500) || alphaBase["tokens"] != float64(15) || alphaBase["costUsd"] != 0.1 ||
		alphaBase["output"].(map[string]any)["ok"] != true || alphaBase["errorJson"] != nil {
		t.Fatalf("alpha base: %+v", alphaBase)
	}
	if alphaReplay["status"] != "missing" || alphaReplay["tokens"] != float64(0) || alphaReplay["output"] != nil {
		t.Fatalf("alpha missing replay: %+v", alphaReplay)
	}
	betaBase := beta["base"].(map[string]any)
	betaReplay := beta["replay"].(map[string]any)
	if betaBase["latencyMs"] != float64(0) || betaBase["tokens"] != float64(3) || betaBase["costUsd"] != nil ||
		betaBase["output"].(map[string]any)["checkpoint"] != "base" || betaBase["errorJson"].(map[string]any)["name"] != "BaseError" {
		t.Fatalf("beta base: %+v", betaBase)
	}
	if betaReplay["latencyMs"] != float64(250) || betaReplay["tokens"] != float64(7) || betaReplay["costUsd"] != 0.2 || betaReplay["output"] != "fixed" {
		t.Fatalf("beta replay: %+v", betaReplay)
	}
	zetaReplay := zeta["replay"].(map[string]any)
	if zetaReplay["status"] != "waiting" || zetaReplay["latencyMs"] != nil ||
		zetaReplay["output"].(map[string]any)["waiting"] == nil {
		t.Fatalf("zeta replay: %+v", zetaReplay)
	}
}
