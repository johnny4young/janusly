//go:build integration

package httpapi

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/engine"
)

func rolloutWorkflowDoc(id, verdict string) map[string]any {
	return map[string]any{
		"id": id, "name": "Rollout", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "shape", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"verdict": verdict},
			}},
			map[string]any{"id": "done", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "shape", "to": "done"}},
	}
}

// The rollout substrate (T-149): create-validation ladder (bounds, canary
// strictly newer AND latest, one active per workflow), the deterministic
// sha256 assignment captured on the run row AND the run.started event,
// and the promote decision routing all future traffic to the canary.
func TestWorkflowRolloutAssignment(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	wfID := fmt.Sprintf("wf-rollout-%d", time.Now().UnixNano())

	saveVersion := func(verdict string) string {
		res := h.call("POST", "/workflows/save", rolloutWorkflowDoc(wfID, verdict), "")
		if res.status != 200 {
			t.Fatalf("save: %d %+v", res.status, res.body)
		}
		return res.body["versionId"].(string)
	}
	v1 := saveVersion("one")
	v2 := saveVersion("two")
	v3 := saveVersion("three")

	// The bucket is a pure deterministic function of (rolloutId, key).
	if engine.WorkflowRolloutBucket("r-1", "k-1") != engine.WorkflowRolloutBucket("r-1", "k-1") ||
		engine.WorkflowRolloutBucket("r-1", "k-1") < 0 || engine.WorkflowRolloutBucket("r-1", "k-1") > 99 {
		t.Fatalf("bucket determinism")
	}

	createBody := func(baseline, canary string, traffic int) map[string]any {
		return map[string]any{
			"baselineVersionId": baseline, "canaryVersionId": canary,
			"trafficPercent": traffic, "minimumSampleSize": 5, "minimumSuccessRatePercent": 90,
		}
	}
	// Ladder: out-of-bound traffic, canary not latest, then a real create.
	if res := h.call("POST", "/workflows/"+wfID+"/rollout", createBody(v1, v3, 80), ""); res.status != 422 {
		t.Fatalf("traffic bound must 422: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/workflows/"+wfID+"/rollout", createBody(v1, v2, 50), ""); res.status != 422 ||
		res.body["params"].(map[string]any)["reason"] != "canary_not_latest" {
		t.Fatalf("stale canary must 422: %d %+v", res.status, res.body)
	}
	res := h.call("POST", "/workflows/"+wfID+"/rollout", createBody(v1, v3, 50), "")
	if res.status != 200 || res.body["rollout"].(map[string]any)["status"] != "active" {
		t.Fatalf("create rollout: %d %+v", res.status, res.body)
	}
	rolloutID := res.body["rollout"].(map[string]any)["id"].(string)
	if res = h.call("POST", "/workflows/"+wfID+"/rollout", createBody(v1, v3, 50), ""); res.status != 409 {
		t.Fatalf("second active must 409: %d", res.status)
	}
	res = h.call("GET", "/workflows/"+wfID+"/rollout", nil, "")
	if res.body["rollout"].(map[string]any)["id"] != rolloutID {
		t.Fatalf("latest rollout read: %+v", res.body)
	}

	// 20 starts at 50% traffic: every run captures the frozen assignment
	// (rollout id + variant + the EXACT variant version id), and the
	// run.started event carries the same fields.
	variants := map[string]int{}
	firstRun := ""
	for range 20 {
		res = h.call("POST", "/v1/start", map[string]any{"workflow": rolloutWorkflowDoc(wfID, "request")}, "")
		runID := extractRunID(t, res)
		if firstRun == "" {
			firstRun = runID
		}
		var rolloutRef, variant, versionID string
		if err := pool.QueryRow(ctx, `SELECT COALESCE(workflow_rollout_id, ''),
			COALESCE(workflow_rollout_variant, ''), workflow_version_id FROM runs WHERE id = $1`,
			runID).Scan(&rolloutRef, &variant, &versionID); err != nil {
			t.Fatalf("run row: %v", err)
		}
		if rolloutRef != rolloutID {
			t.Fatalf("run must capture the rollout id: %q", rolloutRef)
		}
		expected := map[string]string{"baseline": v1, "canary": v3}[variant]
		if expected == "" || versionID != expected {
			t.Fatalf("variant %q must pin its version: got %s", variant, versionID)
		}
		variants[variant]++
	}
	if variants["baseline"] == 0 || variants["canary"] == 0 {
		t.Fatalf("50%% traffic must split (p≈1e-6 to fail): %+v", variants)
	}
	var eventPayload string
	_ = pool.QueryRow(ctx, `SELECT payload::text FROM run_events WHERE run_id = $1 AND type = 'run.started'`,
		firstRun).Scan(&eventPayload)
	if !strings.Contains(eventPayload, rolloutID) || !strings.Contains(eventPayload, "workflowRolloutVariant") {
		t.Fatalf("run.started must capture the assignment: %s", eventPayload)
	}

	// Promote: every later start is the canary snapshot (v3), and the
	// decision CAS refuses a second finish.
	if res = h.call("POST", "/workflows/"+wfID+"/rollout/"+rolloutID+"/promote", map[string]any{}, ""); res.status != 200 ||
		res.body["rollout"].(map[string]any)["status"] != "promoted" {
		t.Fatalf("promote: %d %+v", res.status, res.body)
	}
	res = h.call("POST", "/v1/start", map[string]any{"workflow": rolloutWorkflowDoc(wfID, "request")}, "")
	promotedRun := extractRunID(t, res)
	var promotedVersion, promotedVariant string
	_ = pool.QueryRow(ctx, `SELECT workflow_version_id, COALESCE(workflow_rollout_variant, '') FROM runs WHERE id = $1`,
		promotedRun).Scan(&promotedVersion, &promotedVariant)
	if promotedVersion != v3 || promotedVariant != "canary" {
		t.Fatalf("promoted traffic must be all-canary: %s %s", promotedVersion, promotedVariant)
	}
	if res = h.call("POST", "/workflows/"+wfID+"/rollout/"+rolloutID+"/rollback", map[string]any{}, ""); res.status != 409 {
		t.Fatalf("second decision must 409: %d", res.status)
	}
}

// T-150: version-write locking under a live rollout (save + rollback
// refuse with 409), incompatible external-trigger contracts refuse the
// create, and the soft delete cancels the active deployment in the SAME
// commit.
func TestRolloutVersionWriteLocking(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	wfID := fmt.Sprintf("wf-lock-%d", time.Now().UnixNano())

	saveVersion := func(doc map[string]any) string {
		res := h.call("POST", "/workflows/save", doc, "")
		if res.status != 200 {
			t.Fatalf("save: %d %+v", res.status, res.body)
		}
		return res.body["versionId"].(string)
	}
	v1 := saveVersion(rolloutWorkflowDoc(wfID, "one"))
	v2 := saveVersion(rolloutWorkflowDoc(wfID, "two"))

	// Incompatible external triggers: the canary grows a schedule node the
	// baseline lacks → the create refuses before any traffic splits.
	scheduled := rolloutWorkflowDoc(wfID, "three")
	scheduled["nodes"] = append(scheduled["nodes"].([]any), map[string]any{
		"id": "tick", "type": "schedule", "config": map[string]any{"cron": "0 9 * * *"},
	})
	scheduled["edges"] = append(scheduled["edges"].([]any), map[string]any{"from": "tick", "to": "shape"})
	v3 := saveVersion(scheduled)
	res := h.call("POST", "/workflows/"+wfID+"/rollout", map[string]any{
		"baselineVersionId": v1, "canaryVersionId": v3,
		"trafficPercent": 20, "minimumSampleSize": 5, "minimumSuccessRatePercent": 90,
	}, "")
	if res.status != 422 || res.body["params"].(map[string]any)["reason"] != "incompatible_triggers" {
		t.Fatalf("incompatible triggers must 422: %d %+v", res.status, res.body)
	}
	// Identical trigger contracts (v3 → v4 same schedule) are compatible.
	scheduled4 := rolloutWorkflowDoc(wfID, "four")
	scheduled4["nodes"] = append(scheduled4["nodes"].([]any), map[string]any{
		"id": "tick", "type": "schedule", "config": map[string]any{"cron": "0 9 * * *"},
	})
	scheduled4["edges"] = append(scheduled4["edges"].([]any), map[string]any{"from": "tick", "to": "shape"})
	v4 := saveVersion(scheduled4)
	res = h.call("POST", "/workflows/"+wfID+"/rollout", map[string]any{
		"baselineVersionId": v3, "canaryVersionId": v4,
		"trafficPercent": 20, "minimumSampleSize": 5, "minimumSuccessRatePercent": 90,
	}, "")
	if res.status != 200 {
		t.Fatalf("compatible rollout: %d %+v", res.status, res.body)
	}
	_ = v2

	// Version writes are LOCKED while the rollout is live.
	if res = h.call("POST", "/workflows/save", rolloutWorkflowDoc(wfID, "five"), ""); res.status != 409 ||
		res.body["code"] != "workflow_rollout_active" {
		t.Fatalf("save under rollout must 409: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/workflows/rollback", map[string]any{
		"workflowId": wfID, "sourceVersionId": v1,
	}, ""); res.status != 409 || res.body["code"] != "workflow_rollout_active" {
		t.Fatalf("rollback under rollout must 409: %d %+v", res.status, res.body)
	}

	// The soft delete cancels the live deployment atomically.
	if res = h.call("DELETE", "/workflows/"+wfID, nil, ""); res.status != 200 {
		t.Fatalf("delete: %d %+v", res.status, res.body)
	}
	var status, reason string
	if err := pool.QueryRow(ctx, `SELECT status, COALESCE(rolled_back_reason, '') FROM workflow_rollouts
		WHERE org_id = $1 AND workflow_id = $2 ORDER BY created_at DESC LIMIT 1`,
		h.org, wfID).Scan(&status, &reason); err != nil {
		t.Fatalf("rollout row: %v", err)
	}
	if status != "cancelled" || reason != "workflow_deleted" {
		t.Fatalf("delete must cancel the rollout: %s %s", status, reason)
	}
}
