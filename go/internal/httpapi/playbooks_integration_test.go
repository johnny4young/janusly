//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/engine"
)

// The evidence-gated playbook loop: draft from a fresh sandbox, manual
// activation (one active per exact match), match lookup, replay claim
// verified end to end (applied receipt + audit), and the auto-retire when
// a later sandbox regresses.
func TestRecoveryPlaybookLoop(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	wfID := fmt.Sprintf("wf-pb-%d", time.Now().UnixNano())

	var healed atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !healed.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	workflow := map[string]any{
		"id": wfID, "name": "Playbook", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": upstream.URL, "timeoutMs": 500,
		}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/workflows/save", workflow, ""); res.status >= 300 {
		t.Fatalf("save: %d", res.status)
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	runID := extractRunID(t, res)
	h.waitRun(runID, "failed")
	var deadLetterID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&deadLetterID)

	// 1. Fresh sandbox evidence: heal + validate-fix (no playbook yet).
	healed.Store(true)
	res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": workflow,
	}, "")
	if res.status != 200 {
		t.Fatalf("validate-fix: %d %+v", res.status, res.body)
	}
	validationRunID := res.body["runId"].(string)
	h.waitRun(validationRunID, "succeeded")

	// 2. Draft (idempotent on source version) + manual activation.
	var sourceVersionID string
	_ = pool.QueryRow(ctx, `SELECT id FROM workflow_versions WHERE org_id = $1 AND workflow_id = $2
		ORDER BY version DESC LIMIT 1`, h.org, wfID).Scan(&sourceVersionID)
	draftBody := map[string]any{
		"deadLetterId": deadLetterID, "title": "Reintenta tras sanar upstream",
		"instructionsMarkdown":    "1. Verifica el upstream. 2. Replay.",
		"sourceWorkflowVersionId": sourceVersionID, "validationRunId": validationRunID,
	}
	res = h.call("POST", "/recovery/playbooks", draftBody, "")
	if res.status != 201 {
		t.Fatalf("draft: %d %+v", res.status, res.body)
	}
	playbookID := res.body["playbook"].(map[string]any)["id"].(string)
	if res = h.call("POST", "/recovery/playbooks", draftBody, ""); res.status != 200 || res.body["created"] != false {
		t.Fatalf("draft idempotency: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/recovery/playbooks/"+playbookID+"/activate", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("activate: %d %+v", res.status, res.body)
	}

	// 3. Match lookup finds the active playbook for this failure.
	res = h.call("GET", "/recovery/playbooks/match?deadLetterId="+deadLetterID, nil, "")
	if res.status != 200 || res.body["playbook"] == nil {
		t.Fatalf("match: %d %+v", res.status, res.body)
	}

	// 4. The replay claim: playbook alone (without validation run) → 400;
	// a bogus validation run → 422; the REAL evidence chain requires a
	// FRESH sandbox run carrying the playbook — run one via validate-fix
	// with the playbook claim (exact match verified server-side).
	if res = h.call("POST", "/dlq/replay", map[string]any{
		"deadLetterId": deadLetterID, "recoveryPlaybookId": playbookID,
	}, ""); res.status != 400 {
		t.Fatalf("half claim must 400: %d", res.status)
	}
	if res = h.call("POST", "/dlq/replay", map[string]any{
		"deadLetterId": deadLetterID, "recoveryPlaybookId": playbookID,
		"recoveryValidationRunId": "run-falso",
	}, ""); res.status != 422 {
		t.Fatalf("bogus evidence must 422: %d", res.status)
	}
	res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": workflow,
		"recoveryPlaybookId": playbookID,
	}, "")
	if res.status != 200 {
		t.Fatalf("playbook sandbox: %d %+v", res.status, res.body)
	}
	freshValidationRunID := res.body["runId"].(string)
	h.waitRun(freshValidationRunID, "succeeded")
	res = h.call("POST", "/dlq/replay", map[string]any{
		"deadLetterId": deadLetterID, "recoveryPlaybookId": playbookID,
		"recoveryValidationRunId": freshValidationRunID,
	}, "")
	if res.status != 200 {
		t.Fatalf("verified claim replay: %d %+v", res.status, res.body)
	}
	h.waitRun(runID, "succeeded")

	// 5. The applied receipt landed atomically with the terminal win.
	var uses int
	var appliedRun string
	_ = pool.QueryRow(ctx, `SELECT successful_uses, COALESCE(last_applied_validation_run_id,'')
		FROM recovery_playbooks WHERE id = $1`, playbookID).Scan(&uses, &appliedRun)
	if uses != 1 || appliedRun != freshValidationRunID {
		t.Fatalf("applied receipt: uses=%d run=%s", uses, appliedRun)
	}
	var appliedAudits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1
		AND action = 'recovery.playbook.applied'`, h.org).Scan(&appliedAudits)
	if appliedAudits != 1 {
		t.Fatalf("applied audit: %d", appliedAudits)
	}

	// 6. Regression auto-retire: break the upstream, run the playbook's
	// sandbox again — the FAILED validation retires it with the mark.
	healed.Store(false)
	res = h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	thirdRunID := extractRunID(t, res)
	h.waitRun(thirdRunID, "failed")
	var thirdDL string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1 AND status = 'open'
		ORDER BY created_at DESC LIMIT 1`, thirdRunID).Scan(&thirdDL)
	res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": thirdDL, "suggestedWorkflow": workflow,
		"recoveryPlaybookId": playbookID,
	}, "")
	if res.status != 200 {
		t.Fatalf("regression sandbox: %d %+v", res.status, res.body)
	}
	regressionRunID := res.body["runId"].(string)
	h.waitRun(regressionRunID, "failed")
	var status string
	var regressions int
	_ = pool.QueryRow(ctx, `SELECT status, regressions FROM recovery_playbooks WHERE id = $1`, playbookID).
		Scan(&status, &regressions)
	if status != "retired" || regressions != 1 {
		t.Fatalf("failed sandbox must auto-retire: %s/%d", status, regressions)
	}
}

// The drill surfaces over a REAL recovered chain (reusing the impact
// cycle): the outcome reads recovered + terminal impact + monitoring
// recurrence, and the dossier aggregates it.
func TestRecoveryDrillOutcomeRoutes(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	wfID := fmt.Sprintf("wf-drill-%d", time.Now().UnixNano())

	var healed atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !healed.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	workflow := map[string]any{
		"id": wfID, "name": "Drill", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": upstream.URL, "timeoutMs": 500,
		}}},
		"edges": []any{},
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	runID := extractRunID(t, res)
	h.waitRun(runID, "failed")
	var rootDL string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&rootDL)

	// Mid-flight: claimed replay against a broken upstream → in progress /
	// awaiting on the follow-up dead letter.
	res = h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": rootDL}, "")
	if res.status != 200 {
		t.Fatalf("replay 1: %d", res.status)
	}
	h.waitRun(runID, "failed")

	// Heal + replay the fresh dead letter: the chain recovers.
	var openDL string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1 AND status = 'open'
		ORDER BY created_at DESC LIMIT 1`, runID).Scan(&openDL)
	healed.Store(true)
	res = h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": openDL}, "")
	if res.status != 200 {
		t.Fatalf("replay 2: %d", res.status)
	}
	h.waitRun(runID, "succeeded")

	// The outcome from the ROOT reads the whole chain: recovered with
	// terminal impact, 2 attempts, recurrence monitoring.
	res = h.call("GET", "/recovery/drills/outcome?deadLetterId="+rootDL, nil, "")
	if res.status != 200 {
		t.Fatalf("outcome: %d %+v", res.status, res.body)
	}
	outcome := res.body["outcome"].(map[string]any)
	if outcome["status"] != "recovered" || outcome["evidence"] != "terminal_impact" ||
		outcome["attemptCount"] != float64(2) || outcome["chainCapped"] != false {
		t.Fatalf("outcome shape: %+v", outcome)
	}
	if outcome["recurrence"].(map[string]any)["status"] != "monitoring" {
		t.Fatalf("recurrence: %+v", outcome["recurrence"])
	}
	if outcome["elapsedMs"] == nil || outcome["elapsedMs"].(float64) < 0 {
		t.Fatalf("elapsed: %+v", outcome["elapsedMs"])
	}

	// The dossier aggregates the org's measured drills.
	res = h.call("GET", "/recovery/drills/dossier", nil, "")
	if res.status != 200 {
		t.Fatalf("dossier: %d", res.status)
	}
	drills := res.body["drills"].([]any)
	if len(drills) < 1 {
		t.Fatalf("dossier must list the drill: %+v", res.body)
	}
	summary := res.body["summary"].(map[string]any)
	if summary["recovered"] == nil {
		t.Fatalf("dossier summary: %+v", summary)
	}

	// Unknown dead letter → 404.
	if res = h.call("GET", "/recovery/drills/outcome?deadLetterId=dl-fantasma", nil, ""); res.status != 404 {
		t.Fatalf("unknown outcome: %d", res.status)
	}
}

// The feedback → sweep → curve loop, with the org toggle honored.
func TestCalibrationLoop(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	runID, deadLetterID := "run-fb-"+h.org, "dl-fb-"+h.org
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json)
		VALUES ($1, $2, 'wf-fb', 'failed', '{}')`, runID, h.org); err != nil {
		t.Fatalf("seed feedback run: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO dead_letters
		(id, org_id, run_id, node_id, workflow_json, node_json, error_json)
		VALUES ($1, $2, $3, 'call', '{"id":"wf-fb"}', '{"type":"http"}',
		        '{"message":"HTTP 500"}')`, deadLetterID, h.org, runID); err != nil {
		t.Fatalf("seed feedback DLQ: %v", err)
	}

	// 24 labeled decisions: confident suggestions mostly accepted.
	for i := 0; i < 24; i++ {
		confidence := int32(25)
		accepted := i%4 == 0
		if i >= 12 {
			confidence, accepted = 90, i%6 != 0
		}
		res := h.call("POST", "/recovery/feedback", map[string]any{
			"deadLetterId": deadLetterID, "suggestionMode": "ai",
			"approachLabel": "add_retry", "accepted": accepted,
			"rawConfidence": confidence,
		}, "")
		if res.status != 200 {
			t.Fatalf("feedback %d: %d %+v", i, res.status, res.body)
		}
	}
	// Invalid label refuses.
	if res := h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId": deadLetterID, "suggestionMode": "ai",
		"approachLabel": "magia", "accepted": true,
	}, ""); res.status != 400 {
		t.Fatalf("bad label: %d", res.status)
	}

	// The sweep fits and stores one curve for the approach.
	sweeper := engine.New(pool)
	if written := sweeper.RunCalibrationSweep(ctx); written < 1 {
		t.Fatalf("sweep must write a curve: %d", written)
	}
	res := h.call("GET", "/recovery/calibrations", nil, "")
	if res.status != 200 {
		t.Fatalf("list: %d", res.status)
	}
	curves := res.body["calibrations"].([]any)
	if len(curves) != 1 {
		t.Fatalf("one curve: %+v", curves)
	}
	curve := curves[0].(map[string]any)
	if curve["approachLabel"] != "add_retry" || curve["curveSlope"].(float64) <= 0 ||
		curve["sampleSize"].(float64) != 24 {
		t.Fatalf("curve shape: %+v", curve)
	}

	// The org toggle off → the sweep abstains for this org.
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'ai.confidenceCalibrationEnabled', 'false', 'ai', 'test', 'boolean')`,
		h.org+"-caltoggle", h.org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM confidence_calibrations WHERE org_id = $1`, h.org); err != nil {
		t.Fatal(err)
	}
	_ = sweeper.RunCalibrationSweep(ctx)
	var remaining int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM confidence_calibrations WHERE org_id = $1`, h.org).Scan(&remaining)
	if remaining != 0 {
		t.Fatalf("toggle off must abstain: %d", remaining)
	}
}

// The ownership drawer loop: the redrive-opened incident walks the CAS
// ladder (concurrent double-click loses cleanly), comments append
// bounded, the operator cannot claim the sandbox resolution reason, and
// the handoff records its durable dispatch row.
func TestRecoveryItemOwnership(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	wfID := fmt.Sprintf("wf-own-%d", time.Now().UnixNano())

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()
	workflow := map[string]any{
		"id": wfID, "name": "Own", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": upstream.URL, "timeoutMs": 500,
		}}},
		"edges": []any{},
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	runID := extractRunID(t, res)
	h.waitRun(runID, "failed")
	var deadLetterID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&deadLetterID)
	// El redrive abre el incidente (T-137); fallará de nuevo — da igual.
	_ = h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": deadLetterID}, "")
	h.waitRun(runID, "failed")

	res = h.call("GET", "/recovery/items", nil, "")
	items := res.body["items"].([]any)
	if len(items) < 1 {
		t.Fatalf("incident expected: %+v", res.body)
	}
	itemID := items[0].(map[string]any)["id"].(string)

	// Ladder: acknowledge (owner+severity) → in_progress → resolve.
	res = h.call("POST", "/recovery/items/"+itemID+"/acknowledge", map[string]any{
		"owner": "oncall-ana", "severity": "p2", "comment": "mirando el upstream",
	}, "")
	if res.status != 200 {
		t.Fatalf("acknowledge: %d %+v", res.status, res.body)
	}
	item := res.body["item"].(map[string]any)
	if item["status"] != "acknowledged" || item["owner"] != "oncall-ana" || item["severity"] != "p2" ||
		item["firstActionAt"] == nil {
		t.Fatalf("acknowledge shape: %+v", item)
	}
	// A second acknowledge loses the CAS (already acknowledged).
	if res = h.call("POST", "/recovery/items/"+itemID+"/acknowledge", map[string]any{}, ""); res.status != 409 {
		t.Fatalf("double acknowledge must 409: %d", res.status)
	}
	if res = h.call("POST", "/recovery/items/"+itemID+"/in_progress", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("in_progress: %d", res.status)
	}
	// Escalation bumps severity toward p1.
	res = h.call("POST", "/recovery/items/"+itemID+"/escalate", map[string]any{}, "")
	if res.status != 200 || res.body["item"].(map[string]any)["severity"] != "p1" {
		t.Fatalf("escalate: %d %+v", res.status, res.body)
	}
	// The operator cannot claim the terminal-impact reason by hand.
	if res = h.call("POST", "/recovery/items/"+itemID+"/resolve", map[string]any{
		"resolutionReason": "sandbox_replay_succeeded",
	}, ""); res.status != 400 {
		t.Fatalf("sandbox reason must refuse: %d", res.status)
	}
	res = h.call("POST", "/recovery/items/"+itemID+"/resolve", map[string]any{
		"resolutionReason": "upstream_fixed",
	}, "")
	if res.status != 200 || res.body["item"].(map[string]any)["status"] != "resolved" {
		t.Fatalf("resolve: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/recovery/items/"+itemID+"/reopen", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("reopen: %d", res.status)
	}

	// Handoff records the durable dispatch row honestly (no dispatcher).
	res = h.call("POST", "/recovery/items/"+itemID+"/handoff", map[string]any{
		"destination": "slack", "credentialName": "oncall-slack",
	}, "")
	if res.status != 200 {
		t.Fatalf("handoff: %d %+v", res.status, res.body)
	}
	handoff := res.body["handoff"].(map[string]any)
	if handoff["outcome"] != "delivery_failed" || handoff["error"] != "dispatcher_unavailable" {
		t.Fatalf("handoff outcome: %+v", handoff)
	}
	// Repeat = same row, dispatch_count++.
	res = h.call("POST", "/recovery/items/"+itemID+"/handoff", map[string]any{
		"destination": "slack", "credentialName": "oncall-slack",
	}, "")
	if res.body["handoff"].(map[string]any)["dispatchCount"] != float64(2) {
		t.Fatalf("handoff idempotency: %+v", res.body)
	}
	detail := h.call("GET", "/recovery/items/"+itemID, nil, "")
	if detail.status != http.StatusOK {
		t.Fatalf("item detail: %d %+v", detail.status, detail.body)
	}
	detailItem := detail.body["item"].(map[string]any)
	if detailItem["id"] != itemID || detailItem["status"] != "reopened" {
		t.Fatalf("item detail shape: %+v", detailItem)
	}
	handoffs := detail.body["handoffs"].([]any)
	if len(handoffs) != 1 {
		t.Fatalf("item handoff detail: %+v", handoffs)
	}
	detailHandoff := handoffs[0].(map[string]any)
	if detailHandoff["destination"] != "slack" || detailHandoff["credentialName"] != "oncall-slack" ||
		detailHandoff["dispatchCount"] != float64(2) {
		t.Fatalf("item handoff shape: %+v", detailHandoff)
	}
	if crossOrg := h.call("GET", "/recovery/items/"+itemID, nil, h.org+"-other"); crossOrg.status != http.StatusNotFound || crossOrg.body["code"] != "recovery_item_not_found" {
		t.Fatalf("cross-org detail must not enumerate: %d %+v", crossOrg.status, crossOrg.body)
	}
	if res = h.call("POST", "/recovery/items/"+itemID+"/handoff", map[string]any{
		"destination": "paloma",
	}, ""); res.status != 400 {
		t.Fatalf("bad destination: %d", res.status)
	}
}
