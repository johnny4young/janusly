//go:build integration

package httpapi

import (
	"encoding/base64"
	"fmt"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/secretstore"
)

// The product surface trio: snippets (built-ins immutable, custom CRUD,
// insertion beacon), solution packs (catalog → install → sandbox sample
// run → deterministic inject-failure), and onboarding milestones that
// derive from the durable state those actions leave behind.
func TestProductSurfaceLoop(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	suffix := fmt.Sprint(time.Now().UnixNano())

	// ── snippets ────────────────────────────────────────────────────────
	res := h.call("GET", "/snippets", nil, "")
	if res.status != 200 || len(res.body["snippets"].([]any)) < 9 {
		t.Fatalf("snippet list must lead with the built-ins: %d %+v", res.status, res.body)
	}
	first := res.body["snippets"].([]any)[0].(map[string]any)
	if first["builtin"] != true {
		t.Fatalf("built-ins lead the list: %+v", first)
	}
	// Built-ins are read-only.
	if res = h.call("DELETE", "/snippets/builtin:retry-with-backoff", nil, ""); res.status != 409 {
		t.Fatalf("builtin delete must 409: %d", res.status)
	}
	// Custom CRUD with name-collision guard.
	custom := map[string]any{
		"name": "Mi snippet " + suffix, "category": "transform",
		"nodes": []any{map[string]any{"id": "n1", "type": "noop", "config": map[string]any{}}},
		"edges": []any{}, "entryNodeId": "n1",
	}
	res = h.call("POST", "/snippets", custom, "")
	if res.status != 201 {
		t.Fatalf("create snippet: %d %+v", res.status, res.body)
	}
	snippetID := res.body["snippet"].(map[string]any)["id"].(string)
	if res = h.call("POST", "/snippets", custom, ""); res.status != 409 {
		t.Fatalf("duplicate name must 409: %d", res.status)
	}
	custom["name"] = "Mi snippet v2 " + suffix
	if res = h.call("POST", "/snippets/"+snippetID, custom, ""); res.status != 200 {
		t.Fatalf("update snippet: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/snippets/"+snippetID+"/inserted", map[string]any{
		"workflowId": "wf-x", "insertedNodeCount": 1,
	}, ""); res.status != 200 {
		t.Fatalf("insertion beacon: %d", res.status)
	}
	var insertedAudits int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'snippet.inserted'`, h.org).Scan(&insertedAudits)
	if insertedAudits != 1 {
		t.Fatalf("beacon must audit: %d", insertedAudits)
	}
	if res = h.call("DELETE", "/snippets/"+snippetID, nil, ""); res.status != 200 {
		t.Fatalf("delete snippet: %d", res.status)
	}

	// ── onboarding baseline: only org_created done ──────────────────────
	res = h.call("GET", "/onboarding", nil, "")
	if res.status != 200 || res.body["enabled"] != true || res.body["currentStep"] != "credential_configured" {
		t.Fatalf("onboarding baseline: %d %+v", res.status, res.body)
	}

	// ── solution packs ──────────────────────────────────────────────────
	res = h.call("GET", "/solution-packs", nil, "")
	if res.status != 200 || len(res.body["packs"].([]any)) != 3 {
		t.Fatalf("pack catalog: %d %+v", res.status, res.body)
	}
	pack := res.body["packs"].([]any)[0].(map[string]any)
	packID := pack["id"].(string)
	// Dependency hints carry EXISTENCE only.
	deps := pack["requiredCredentials"].([]any)
	if len(deps) > 0 {
		hint := deps[0].(map[string]any)
		if _, leaked := hint["secretRef"]; leaked || hint["configured"] != false {
			t.Fatalf("dependency hint shape: %+v", hint)
		}
	}
	res = h.call("GET", "/solution-packs/"+packID, nil, "")
	if res.status != 200 || res.body["pack"].(map[string]any)["workflow"] == nil {
		t.Fatalf("pack detail: %d", res.status)
	}

	// Install as a draft workflow; a second install appends a version.
	res = h.call("POST", "/workflows/import-pack", map[string]any{"packId": packID}, "")
	if res.status != 201 {
		t.Fatalf("import pack: %d %+v", res.status, res.body)
	}
	workflowID := res.body["workflowId"].(string)
	if res = h.call("POST", "/workflows/import-pack", map[string]any{"packId": packID}, ""); res.status != 201 {
		t.Fatalf("re-import: %d", res.status)
	}
	var versions int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM workflow_versions WHERE workflow_id = $1 AND org_id = $2`, workflowID, h.org).Scan(&versions)
	if versions != 2 {
		t.Fatalf("re-install must append a version: %d", versions)
	}

	// Sample run is a SANDBOX (validation replay mode).
	res = h.call("POST", "/solution-packs/"+packID+"/sample-run", map[string]any{}, "")
	if res.status != 202 || res.body["sandbox"] != true {
		t.Fatalf("sample run: %d %+v", res.status, res.body)
	}
	sampleRunID := res.body["runId"].(string)
	var replayMode string
	_ = pool.QueryRow(ctx, `SELECT coalesce(replay_mode,'') FROM runs WHERE id = $1`, sampleRunID).Scan(&replayMode)
	if replayMode != "validation" {
		t.Fatalf("sample run must be validation: %q", replayMode)
	}

	// The selected runtime fixture crosses the real worker/DLQ boundary and
	// returns the exact dead-letter identity only after it is durable.
	fixtureIDs := pack["failureFixtureIds"].([]any)
	res = h.call("POST", "/solution-packs/"+packID+"/inject-failure", map[string]any{
		"fixtureId": fixtureIDs[0],
	}, "")
	if res.status != 200 || res.body["deadLetterId"] == "" ||
		res.body["fixtureId"] != fixtureIDs[0] || res.body["recoveryPath"] != "runtime_failure" {
		t.Fatalf("inject failure: %d %+v", res.status, res.body)
	}
	failureRunID := res.body["runId"].(string)
	var dlqCount int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM dead_letters WHERE run_id = $1`, failureRunID).Scan(&dlqCount)
	if dlqCount != 1 {
		t.Fatalf("injected failure must dead-letter: %d", dlqCount)
	}
	detail := h.call("GET", "/dlq?id="+res.body["deadLetterId"].(string), nil, "")
	drill, _ := detail.body["drill"].(map[string]any)
	outcome, _ := detail.body["drillOutcome"].(map[string]any)
	if detail.status != 200 || drill["fixtureId"] != fixtureIDs[0] ||
		outcome["status"] != "awaiting_action" {
		t.Fatalf("drill detail/outcome: %d %+v", detail.status, detail.body)
	}

	// ── onboarding derives the new milestones + completes via recovery ──
	if res := h.call("POST", "/credentials", map[string]any{
		"name": "onboard-cred-" + suffix, "kind": "webhook_secret", "secretValue": "whsec-x",
	}, ""); res.status != 200 {
		t.Fatalf("credential: %d %+v", res.status, res.body)
	}
	// A green run for first_run_succeeded.
	res = h.call("POST", "/v1/start", map[string]any{"workflow": map[string]any{
		"id": "wf-onboard-" + suffix, "name": "ok", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}}, "")
	h.waitRun(extractRunID(t, res), "succeeded")
	// Resolve the injected dead letter → recovery_applied.
	if _, err := pool.Exec(ctx,
		`UPDATE dead_letters SET status = 'resolved' WHERE run_id = $1`, failureRunID); err != nil {
		t.Fatalf("resolve dlq: %v", err)
	}

	res = h.call("GET", "/onboarding", nil, "")
	if res.status != 200 || res.body["completed"] != true || res.body["status"] != "completed" {
		t.Fatalf("onboarding must complete: %+v", res.body)
	}
	var completedAudits int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'onboarding.completed'`, h.org).Scan(&completedAudits)
	if completedAudits != 1 {
		t.Fatalf("completion audits exactly once: %d", completedAudits)
	}
	// The latch survives re-reads.
	if res = h.call("GET", "/onboarding", nil, ""); res.body["completed"] != true {
		t.Fatalf("completed latch: %+v", res.body)
	}
	// Restart re-derives from the restart epoch.
	if res = h.call("POST", "/onboarding", map[string]any{"action": "restart"}, ""); res.status != 200 ||
		res.body["completed"] == true {
		t.Fatalf("restart must reopen: %d %+v", res.status, res.body)
	}
}

func TestSolutionPackSelectedStalledDrill(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("JANUSLY_GO_REAPER_THRESHOLD_MS", "900000")

	before := 0
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE org_id=$1`, h.org).Scan(&before)
	unknown := h.call("POST", "/solution-packs/incident-triage/inject-failure", map[string]any{
		"fixtureId": "not-a-drill",
	}, "")
	if unknown.status != 400 || unknown.body["code"] != "pack_no_failure_fixture" {
		t.Fatalf("unknown fixture must fail closed: %d %+v", unknown.status, unknown.body)
	}
	afterUnknown := 0
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE org_id=$1`, h.org).Scan(&afterUnknown)
	if afterUnknown != before {
		t.Fatalf("unknown fixture persisted a run: before=%d after=%d", before, afterUnknown)
	}

	res := h.call("POST", "/solution-packs/incident-triage/inject-failure", map[string]any{
		"fixtureId": "worker_interrupted_during_page",
	}, "")
	if res.status != 200 || res.body["fixtureId"] != "worker_interrupted_during_page" ||
		res.body["failureMode"] != "worker_stalled" ||
		res.body["recoveryPath"] != "stalled_node_reaper" {
		t.Fatalf("selected stalled drill: %d %+v", res.status, res.body)
	}
	evidence := res.body["evidence"].(map[string]any)
	if evidence["thresholdMinutes"] != float64(15) ||
		evidence["scanned"] != float64(1) || evidence["reaped"] != float64(1) ||
		evidence["deadLettered"] != float64(1) {
		t.Fatalf("stalled evidence: %+v", evidence)
	}
	runID := res.body["runId"].(string)
	deadLetterID := res.body["deadLetterId"].(string)
	var nodeID, runStatus, nodeStatus, replayMode, evidenceLevel string
	if err := pool.QueryRow(ctx, `
		SELECT dl.node_id, r.status, rn.status, coalesce(r.replay_mode,''),
		       coalesce(r.validation_evidence_level,'')
		FROM dead_letters dl
		JOIN runs r ON r.id=dl.run_id
		JOIN run_nodes rn ON rn.run_id=dl.run_id AND rn.node_id=dl.node_id
		WHERE dl.org_id=$1 AND dl.id=$2 AND dl.run_id=$3
	`, h.org, deadLetterID, runID).Scan(
		&nodeID, &runStatus, &nodeStatus, &replayMode, &evidenceLevel,
	); err != nil {
		t.Fatalf("read stalled drill: %v", err)
	}
	if nodeID != "page_oncall" || runStatus != "failed" || nodeStatus != "failed" ||
		replayMode != "validation" || evidenceLevel != "static" {
		t.Fatalf("stalled durable state: node=%s run=%s/%s mode=%s evidence=%s",
			nodeID, runStatus, nodeStatus, replayMode, evidenceLevel)
	}
	detail := h.call("GET", "/dlq?id="+deadLetterID, nil, "")
	drill := detail.body["drill"].(map[string]any)
	outcome := detail.body["drillOutcome"].(map[string]any)
	if drill["kind"] != "solution_pack_drill" ||
		drill["fixtureId"] != "worker_interrupted_during_page" ||
		drill["recoveryPath"] != "stalled_node_reaper" ||
		outcome["status"] != "awaiting_action" ||
		outcome["latestDeadLetterId"] != deadLetterID {
		t.Fatalf("stalled drill detail: %+v", detail.body)
	}
	if foreign := h.call("GET", "/dlq?id="+deadLetterID, nil, h.org+"-other"); foreign.status != 404 {
		t.Fatalf("drill detail must remain tenant-invisible: %d %+v", foreign.status, foreign.body)
	}
	var audits int
	_ = pool.QueryRow(ctx, `
		SELECT count(*) FROM audit_logs
		WHERE org_id=$1 AND action='solution_pack.failure_injected'
		  AND metadata->>'fixtureId'='worker_interrupted_during_page'
		  AND metadata->>'deadLetterId'=$2
	`, h.org, deadLetterID).Scan(&audits)
	if audits != 1 {
		t.Fatalf("measured drill audit missing: %d", audits)
	}
}
