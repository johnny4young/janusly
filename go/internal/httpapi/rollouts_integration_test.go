//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
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

// T-152: idempotent terminal receipts feeding the aggregate counters,
// the minimum-sample auto-rollback with its atomic audit evidence,
// frozen evidence after finish, and the bounded crash-window repair.
func TestRolloutAutoRollback(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	wfID := fmt.Sprintf("wf-auto-%d", time.Now().UnixNano())

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer broken.Close()

	// v1 baseline: healthy. v2 canary: an http node against a dead
	// upstream — every canary run fails.
	brokenDoc := rolloutWorkflowDoc(wfID, "canary")
	brokenDoc["nodes"] = append(brokenDoc["nodes"].([]any), map[string]any{
		"id": "call", "type": "http", "config": map[string]any{"url": broken.URL, "timeoutMs": 500},
	})
	brokenDoc["edges"] = append(brokenDoc["edges"].([]any), map[string]any{"from": "done", "to": "call"})
	res := h.call("POST", "/workflows/save", rolloutWorkflowDoc(wfID, "baseline"), "")
	v1 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/save", brokenDoc, "")
	v2 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/"+wfID+"/rollout", map[string]any{
		"baselineVersionId": v1, "canaryVersionId": v2,
		"trafficPercent": 50, "minimumSampleSize": 5, "minimumSuccessRatePercent": 90,
	}, "")
	if res.status != 200 {
		t.Fatalf("create: %d %+v", res.status, res.body)
	}
	rolloutID := res.body["rollout"].(map[string]any)["id"].(string)

	// Drive runs until the canary sample breaches (5 failures at 0%).
	rolloutStatus := func() (string, string, int, int) {
		var status, reason string
		var canaryFailed, receipts int
		_ = pool.QueryRow(ctx, `SELECT status, COALESCE(rolled_back_reason, ''), canary_failed
			FROM workflow_rollouts WHERE id = $1`, rolloutID).Scan(&status, &reason, &canaryFailed)
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_rollout_outcomes WHERE rollout_id = $1`,
			rolloutID).Scan(&receipts)
		return status, reason, canaryFailed, receipts
	}
	deadline := time.Now().Add(60 * time.Second)
	for {
		status, _, _, _ := rolloutStatus()
		if status == "rolled_back" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("auto-rollback did not fire")
		}
		res = h.call("POST", "/v1/start", map[string]any{"workflow": rolloutWorkflowDoc(wfID, "req")}, "")
		runID := extractRunID(t, res)
		var variant string
		_ = pool.QueryRow(ctx, `SELECT COALESCE(workflow_rollout_variant, '') FROM runs WHERE id = $1`,
			runID).Scan(&variant)
		if variant == "canary" {
			h.waitRun(runID, "failed")
		} else {
			h.waitRun(runID, "succeeded")
		}
		time.Sleep(50 * time.Millisecond)
	}
	status, reason, canaryFailed, receipts := rolloutStatus()
	if status != "rolled_back" || reason != "canary_success_rate_breach" {
		t.Fatalf("auto-rollback: %s %s", status, reason)
	}
	if canaryFailed < 5 || receipts < canaryFailed {
		t.Fatalf("counters/receipts: failed=%d receipts=%d", canaryFailed, receipts)
	}
	var audited int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'workflow.rollout.auto_rolled_back' AND target_id = $2`,
		h.org, rolloutID).Scan(&audited)
	if audited != 1 {
		t.Fatalf("auto-rollback must audit exactly once: %d", audited)
	}

	// Frozen evidence: a terminal arrival after the finish is IGNORED.
	frozenFailed := canaryFailed
	res = h.call("POST", "/v1/start", map[string]any{"workflow": rolloutWorkflowDoc(wfID, "late")}, "")
	lateRun := extractRunID(t, res)
	h.waitRun(lateRun, "succeeded")
	time.Sleep(200 * time.Millisecond)
	if _, _, nowFailed, _ := rolloutStatus(); nowFailed != frozenFailed {
		t.Fatalf("finished rollout must keep frozen evidence")
	}

	// Crash-window repair on a SECOND live rollout: receipt+counters both
	// missing (they commit together) → the bounded repair re-drives them.
	wf2 := wfID + "-b"
	res = h.call("POST", "/workflows/save", rolloutWorkflowDoc(wf2, "one"), "")
	w1 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/save", rolloutWorkflowDoc(wf2, "two"), "")
	w2 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/"+wf2+"/rollout", map[string]any{
		"baselineVersionId": w1, "canaryVersionId": w2,
		"trafficPercent": 50, "minimumSampleSize": 100, "minimumSuccessRatePercent": 1,
	}, "")
	rollout2 := res.body["rollout"].(map[string]any)["id"].(string)
	res = h.call("POST", "/v1/start", map[string]any{"workflow": rolloutWorkflowDoc(wf2, "req")}, "")
	repairRun := extractRunID(t, res)
	h.waitRun(repairRun, "succeeded")
	time.Sleep(200 * time.Millisecond)
	// Simulate the crash window: receipt AND counter increment vanish.
	if _, err := pool.Exec(ctx, `DELETE FROM workflow_rollout_outcomes WHERE run_id = $1`, repairRun); err != nil {
		t.Fatalf("simulate: %v", err)
	}
	_, _ = pool.Exec(ctx, `UPDATE workflow_rollouts SET baseline_succeeded = 0, canary_succeeded = 0 WHERE id = $1`, rollout2)
	// The operator read runs the bounded repair.
	_ = h.call("GET", "/workflows/"+wf2+"/rollout", nil, "")
	var repairedReceipts, repairedCounters int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_rollout_outcomes WHERE run_id = $1`, repairRun).Scan(&repairedReceipts)
	_ = pool.QueryRow(ctx, `SELECT baseline_succeeded + canary_succeeded FROM workflow_rollouts WHERE id = $1`, rollout2).Scan(&repairedCounters)
	if repairedReceipts != 1 || repairedCounters != 1 {
		t.Fatalf("repair must re-drive receipt + counters: %d %d", repairedReceipts, repairedCounters)
	}
}

// T-153: sandbox validation and replay revivals NEVER consume canary
// traffic — the validation child carries no assignment and produces no
// outcome receipt; the redriven run keeps its FROZEN original assignment
// and its post-replay terminal cannot double-count.
func TestValidationAndReplayNeverConsumeCanary(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	wfID := fmt.Sprintf("wf-nocanary-%d", time.Now().UnixNano())

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer broken.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer healthy.Close()
	httpDoc := func(url string) map[string]any {
		return map[string]any{
			"id": wfID, "name": "NoCanary", "dslVersion": "1.0",
			"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
				"url": url, "timeoutMs": 500,
			}}},
			"edges": []any{},
		}
	}
	res := h.call("POST", "/workflows/save", httpDoc(healthy.URL), "")
	v1 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/save", httpDoc(broken.URL), "")
	v2 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/"+wfID+"/rollout", map[string]any{
		"baselineVersionId": v1, "canaryVersionId": v2,
		"trafficPercent": 50, "minimumSampleSize": 100, "minimumSuccessRatePercent": 1,
	}, "")
	if res.status != 200 {
		t.Fatalf("rollout: %d %+v", res.status, res.body)
	}

	// Drive starts until one CANARY run fails and lands in the DLQ.
	var canaryRun, dlqID string
	deadline := time.Now().Add(60 * time.Second)
	for canaryRun == "" {
		if time.Now().After(deadline) {
			t.Fatalf("no canary failure arrived")
		}
		res = h.call("POST", "/v1/start", map[string]any{"workflow": httpDoc(healthy.URL)}, "")
		runID := extractRunID(t, res)
		var variant string
		_ = pool.QueryRow(ctx, `SELECT COALESCE(workflow_rollout_variant, '') FROM runs WHERE id = $1`,
			runID).Scan(&variant)
		if variant == "canary" {
			h.waitRun(runID, "failed")
			canaryRun = runID
			if err := pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&dlqID); err != nil {
				t.Fatalf("dead letter: %v", err)
			}
		} else {
			h.waitRun(runID, "succeeded")
		}
	}
	time.Sleep(200 * time.Millisecond)
	var receiptsBefore int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_rollout_outcomes WHERE run_id = $1`, canaryRun).Scan(&receiptsBefore)
	if receiptsBefore != 1 {
		t.Fatalf("failed canary must have one receipt: %d", receiptsBefore)
	}

	// The sandbox validation child: replay_mode=validation, NO rollout
	// assignment, NO outcome receipt ever.
	res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": dlqID, "suggestedWorkflow": httpDoc(healthy.URL),
	}, "")
	if res.status != 200 {
		t.Fatalf("validate-fix: %d %+v", res.status, res.body)
	}
	validationRun := res.body["runId"].(string)
	h.waitRun(validationRun, "succeeded")
	var vReplayMode, vRollout string
	var vReceipts int
	_ = pool.QueryRow(ctx, `SELECT COALESCE(replay_mode, ''), COALESCE(workflow_rollout_id, '') FROM runs WHERE id = $1`,
		validationRun).Scan(&vReplayMode, &vRollout)
	time.Sleep(200 * time.Millisecond)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_rollout_outcomes WHERE run_id = $1`, validationRun).Scan(&vReceipts)
	if vReplayMode != "validation" || vRollout != "" || vReceipts != 0 {
		t.Fatalf("validation child must never consume canary: mode=%s rollout=%q receipts=%d",
			vReplayMode, vRollout, vReceipts)
	}

	// The replay revival keeps the FROZEN assignment and cannot
	// double-count: same rollout id + variant, receipts stay at 1, and
	// the canary counters never move from the revival's success.
	var failedBefore int
	_ = pool.QueryRow(ctx, `SELECT canary_failed FROM workflow_rollouts WHERE workflow_id = $1`, wfID).Scan(&failedBefore)
	res = h.call("POST", "/dlq/cluster-apply", map[string]any{
		"clusterSignature": func() string {
			res := h.call("GET", "/dlq/clusters", nil, "")
			return res.body["clusters"].([]any)[0].(map[string]any)["signature"].(string)
		}(),
		"deadLetterIds":     []any{dlqID},
		"suggestedWorkflow": httpDoc(healthy.URL),
	}, "")
	if res.body["replayed"] != float64(1) {
		t.Fatalf("apply: %+v", res.body)
	}
	h.waitRun(canaryRun, "succeeded")
	time.Sleep(300 * time.Millisecond)
	var rolloutRef, variant string
	var receiptsAfter, failedAfter, succeededAfter int
	_ = pool.QueryRow(ctx, `SELECT COALESCE(workflow_rollout_id, ''), COALESCE(workflow_rollout_variant, '') FROM runs WHERE id = $1`,
		canaryRun).Scan(&rolloutRef, &variant)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_rollout_outcomes WHERE run_id = $1`, canaryRun).Scan(&receiptsAfter)
	_ = pool.QueryRow(ctx, `SELECT canary_failed, canary_succeeded FROM workflow_rollouts WHERE workflow_id = $1`, wfID).
		Scan(&failedAfter, &succeededAfter)
	if rolloutRef == "" || variant != "canary" {
		t.Fatalf("revival must keep the frozen assignment: %q %q", rolloutRef, variant)
	}
	if receiptsAfter != 1 || failedAfter != failedBefore || succeededAfter != 0 {
		t.Fatalf("revival terminal must not double-count: receipts=%d failed=%d->%d succeeded=%d",
			receiptsAfter, failedBefore, failedAfter, succeededAfter)
	}
}

// T-154: trigger ingest resolves the rollout assignment at ACCEPT time —
// captured on the trigger event AND the run; the trigger node must exist
// in the ASSIGNED version (else 409 trigger_no_matching_node); buffered
// events keep their captured assignment through the breaker backfill.
func TestTriggerIngestRolloutAssignment(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	wfID := fmt.Sprintf("wf-ingest-roll-%d", time.Now().UnixNano())

	// v1 baseline + v2 canary share the SAME webhook trigger contract.
	res := h.call("POST", "/workflows/save", webhookWorkflow(wfID, "orders.v1"), "")
	v1 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/save", webhookWorkflow(wfID, "orders.v1"), "")
	v2 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/"+wfID+"/rollout", map[string]any{
		"baselineVersionId": v1, "canaryVersionId": v2,
		"trafficPercent": 50, "minimumSampleSize": 100, "minimumSuccessRatePercent": 1,
	}, "")
	if res.status != 200 {
		t.Fatalf("rollout: %d %+v", res.status, res.body)
	}
	rolloutID := res.body["rollout"].(map[string]any)["id"].(string)

	// Accepted events capture the assignment on the EVENT and the RUN,
	// and both variants appear across enough deliveries.
	variants := map[string]int{}
	for i := range 20 {
		res = h.call("POST", "/v1/webhooks/"+wfID, map[string]any{
			"endpointKey": "orders.v1", "eventId": fmt.Sprintf("evt-roll-%d", i),
			"payload": map[string]any{"total": i},
		}, "")
		if res.status != 200 {
			t.Fatalf("ingest %d: %d %+v", i, res.status, res.body)
		}
		data := res.body["data"].(map[string]any)
		eventID := data["triggerEventId"].(string)
		runID := data["runId"].(string)
		var eventRollout, eventVariant, eventVersion string
		_ = pool.QueryRow(ctx, `SELECT COALESCE(workflow_rollout_id, ''), COALESCE(workflow_rollout_variant, ''),
			workflow_version_id FROM trigger_events WHERE id = $1`, eventID).Scan(&eventRollout, &eventVariant, &eventVersion)
		var runRollout, runVariant, runVersion string
		_ = pool.QueryRow(ctx, `SELECT COALESCE(workflow_rollout_id, ''), COALESCE(workflow_rollout_variant, ''),
			workflow_version_id FROM runs WHERE id = $1`, runID).Scan(&runRollout, &runVariant, &runVersion)
		if eventRollout != rolloutID || runRollout != rolloutID || eventVariant != runVariant || eventVersion != runVersion {
			t.Fatalf("event/run assignment must agree: %s/%s vs %s/%s", eventVariant, eventVersion, runVariant, runVersion)
		}
		expected := map[string]string{"baseline": v1, "canary": v2}[eventVariant]
		if eventVersion != expected {
			t.Fatalf("variant %s must pin its version: %s", eventVariant, eventVersion)
		}
		variants[eventVariant]++
	}
	if variants["baseline"] == 0 || variants["canary"] == 0 {
		t.Fatalf("both variants expected: %+v", variants)
	}
}

// The 409 arm: the baseline variant LACKS the webhook node (only the
// canary has it) — an event assigned to baseline cannot be redirected to
// a version that can't serve it; the ingest answers 409
// trigger_no_matching_node instead of guessing.
func TestTriggerIngestAssignedVersionMissingNode(t *testing.T) {
	h := newAPIHarness(t)
	wfID := fmt.Sprintf("wf-ingest-miss-%d", time.Now().UnixNano())

	plain := map[string]any{
		"id": wfID, "name": "no hook",
		"nodes": []any{map[string]any{"id": "shape", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	res := h.call("POST", "/workflows/save", plain, "")
	v1 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/save", webhookWorkflow(wfID, "late.hook"), "")
	v2 := res.body["versionId"].(string)
	res = h.call("POST", "/workflows/"+wfID+"/rollout", map[string]any{
		"baselineVersionId": v1, "canaryVersionId": v2,
		"trafficPercent": 50, "minimumSampleSize": 100, "minimumSuccessRatePercent": 1,
	}, "")
	if res.status != 200 {
		t.Fatalf("rollout: %d %+v", res.status, res.body)
	}
	saw409, saw200 := false, false
	for i := range 40 {
		res = h.call("POST", "/v1/webhooks/"+wfID, map[string]any{
			"endpointKey": "late.hook", "eventId": fmt.Sprintf("evt-miss-%d", i),
			"payload": map[string]any{},
		}, "")
		switch res.status {
		case 409:
			if res.body["error"].(map[string]any)["code"] != "trigger_no_matching_node" {
				t.Fatalf("409 code: %+v", res.body)
			}
			saw409 = true
		case 200:
			saw200 = true
		default:
			t.Fatalf("unexpected status %d: %+v", res.status, res.body)
		}
		if saw409 && saw200 {
			break
		}
	}
	if !saw409 || !saw200 {
		t.Fatalf("both arms expected at 50%%: 409=%v 200=%v", saw409, saw200)
	}
}
