//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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

	failing := map[string]any{
		"id": wfID, "name": "Playbook", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": upstream.URL, "timeoutMs": 200,
		}}},
		"edges": []any{},
	}
	fixed := map[string]any{
		"id": wfID, "name": "Playbook", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": upstream.URL, "timeoutMs": 500,
		}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/workflows/save", failing, ""); res.status >= 300 {
		t.Fatalf("save: %d", res.status)
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": failing}, "")
	runID := extractRunID(t, res)
	h.waitRun(runID, "failed")
	var deadLetterID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&deadLetterID)

	// 1. A fresh sandbox passes the changed snapshot. Saving and replaying that
	// exact snapshot happen later and remain separate production decisions.
	healed.Store(true)
	res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": fixed,
	}, "")
	if res.status != 200 {
		t.Fatalf("validate-fix: %d %+v", res.status, res.body)
	}
	validationRunID := res.body["runId"].(string)
	h.waitRun(validationRunID, "succeeded")
	res = h.call("POST", "/workflows/save", fixed, "")
	if res.status != 200 {
		t.Fatalf("save fixed snapshot: %d %+v", res.status, res.body)
	}
	sourceVersionID := res.body["versionId"].(string)
	res = h.call("POST", "/dlq/replay", map[string]any{
		"deadLetterId": deadLetterID, "suggestedWorkflow": fixed,
	}, "")
	if res.status != 200 {
		t.Fatalf("apply fixed snapshot: %d %+v", res.status, res.body)
	}
	h.waitRun(runID, "succeeded")
	res = h.call("POST", "/recovery/feedback", map[string]any{
		"deadLetterId": deadLetterID, "suggestionMode": "ai",
		"approachLabel": "raise_timeout", "accepted": true,
	}, "")
	if res.status != 200 {
		t.Fatalf("accepted feedback: %d %+v", res.status, res.body)
	}

	// 2. Promotion re-verifies every server-owned fact. The public view omits
	// the executable source DAG while preserving the complete operator summary.
	draftBody := map[string]any{
		"deadLetterId": deadLetterID, "title": "Reintenta tras sanar upstream",
		"instructionsMarkdown":    "1. Verifica el upstream. 2. Replay.",
		"sourceWorkflowVersionId": sourceVersionID, "validationRunId": validationRunID,
	}
	res = h.call("POST", "/recovery/playbooks", draftBody, "")
	if res.status != 201 {
		t.Fatalf("draft: %d %+v", res.status, res.body)
	}
	draftView := res.body["playbook"].(map[string]any)
	playbookID := draftView["id"].(string)
	if draftView["instructionsMarkdown"] == nil || draftView["createdAt"] == nil || draftView["updatedAt"] == nil ||
		draftView["sourceWorkflowVersionId"] != nil || draftView["orgId"] != nil {
		t.Fatalf("public playbook view drifted: %+v", draftView)
	}
	if res = h.call("POST", "/recovery/playbooks", draftBody, ""); res.status != 200 || res.body["created"] != false {
		t.Fatalf("draft idempotency: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/recovery/playbooks/"+playbookID+"/activate", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("activate: %d %+v", res.status, res.body)
	}

	// 3. A new occurrence with the exact same workflow and signature offers
	// the playbook. Explicit use returns the immutable source, never executes it.
	healed.Store(false)
	res = h.call("POST", "/v1/start", map[string]any{"workflow": failing}, "")
	secondRunID := extractRunID(t, res)
	h.waitRun(secondRunID, "failed")
	var secondDeadLetterID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, secondRunID).Scan(&secondDeadLetterID)
	res = h.call("GET", "/recovery/playbooks/match?deadLetterId="+secondDeadLetterID, nil, "")
	if res.status != 200 || res.body["playbook"] == nil {
		t.Fatalf("match: %d %+v", res.status, res.body)
	}
	res = h.call("POST", "/recovery/playbooks/"+playbookID+"/use", map[string]any{
		"deadLetterId": secondDeadLetterID,
	}, "")
	if res.status != 200 {
		t.Fatalf("explicit use: %d %+v", res.status, res.body)
	}
	suggestion := res.body["suggestion"].(map[string]any)
	if suggestion["mode"] != "playbook" || suggestion["playbook"].(map[string]any)["id"] != playbookID {
		t.Fatalf("use suggestion: %+v", suggestion)
	}

	// 4. The replay claim: playbook alone (without validation run) → 400;
	// a bogus validation run → 422; the REAL evidence chain requires a
	// FRESH sandbox run carrying the playbook — run one via validate-fix
	// with the playbook claim (exact match verified server-side).
	if res = h.call("POST", "/dlq/replay", map[string]any{
		"deadLetterId": secondDeadLetterID, "recoveryPlaybookId": playbookID,
	}, ""); res.status != 400 {
		t.Fatalf("half claim must 400: %d", res.status)
	}
	if res = h.call("POST", "/dlq/replay", map[string]any{
		"deadLetterId": secondDeadLetterID, "suggestedWorkflow": fixed,
		"recoveryPlaybookId":      playbookID,
		"recoveryValidationRunId": "run-falso",
	}, ""); res.status != 422 {
		t.Fatalf("bogus evidence must 422: %d", res.status)
	}
	healed.Store(true)
	res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": secondDeadLetterID, "suggestedWorkflow": fixed,
		"recoveryPlaybookId": playbookID,
	}, "")
	if res.status != 200 {
		t.Fatalf("playbook sandbox: %d %+v", res.status, res.body)
	}
	freshValidationRunID := res.body["runId"].(string)
	h.waitRun(freshValidationRunID, "succeeded")
	res = h.call("POST", "/recovery/playbooks/"+playbookID+"/outcome", map[string]any{
		"deadLetterId": secondDeadLetterID, "validationRunId": freshValidationRunID, "phase": "validation",
	}, "")
	if res.status != 200 || res.body["recorded"] != false {
		t.Fatalf("validation outcome read-back: %d %+v", res.status, res.body)
	}
	res = h.call("POST", "/dlq/replay", map[string]any{
		"deadLetterId": secondDeadLetterID, "suggestedWorkflow": fixed,
		"recoveryPlaybookId":      playbookID,
		"recoveryValidationRunId": freshValidationRunID,
	}, "")
	if res.status != 200 {
		t.Fatalf("verified claim replay: %d %+v", res.status, res.body)
	}
	h.waitRun(secondRunID, "succeeded")
	res = h.call("POST", "/recovery/playbooks/"+playbookID+"/outcome", map[string]any{
		"deadLetterId": secondDeadLetterID, "validationRunId": freshValidationRunID, "phase": "applied",
	}, "")
	if res.status != 200 || res.body["recorded"] != false ||
		res.body["playbook"].(map[string]any)["successfulUses"] != float64(1) {
		t.Fatalf("applied outcome read-back: %d %+v", res.status, res.body)
	}

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

	// Executable match reads fail closed when the parent workflow is in Trash,
	// while restoring the same parent makes the intact immutable source usable.
	if res = h.call("DELETE", "/workflows/"+wfID, nil, ""); res.status != 200 {
		t.Fatalf("soft delete workflow: %d %+v", res.status, res.body)
	}
	res = h.call("GET", "/recovery/playbooks/match?deadLetterId="+secondDeadLetterID, nil, "")
	if res.status != 200 || res.body["playbook"] != nil {
		t.Fatalf("tombstoned workflow must not offer a playbook: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/workflows/"+wfID+"/restore", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("restore workflow: %d %+v", res.status, res.body)
	}
	res = h.call("GET", "/recovery/playbooks/match?deadLetterId="+secondDeadLetterID, nil, "")
	if res.status != 200 || res.body["playbook"] == nil {
		t.Fatalf("restored workflow must offer the playbook: %d %+v", res.status, res.body)
	}

	// 6. A later fresh sandbox regression retires the playbook automatically;
	// the outcome endpoint remains an idempotent read-back of that transition.
	healed.Store(false)
	res = h.call("POST", "/v1/start", map[string]any{"workflow": failing}, "")
	thirdRunID := extractRunID(t, res)
	h.waitRun(thirdRunID, "failed")
	var thirdDL string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1 AND status = 'open'
		ORDER BY created_at DESC LIMIT 1`, thirdRunID).Scan(&thirdDL)
	res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": thirdDL, "suggestedWorkflow": fixed,
		"recoveryPlaybookId": playbookID,
	}, "")
	if res.status != 200 {
		t.Fatalf("regression sandbox: %d %+v", res.status, res.body)
	}
	regressionRunID := res.body["runId"].(string)
	h.waitRun(regressionRunID, "failed")
	res = h.call("POST", "/recovery/playbooks/"+playbookID+"/outcome", map[string]any{
		"deadLetterId": thirdDL, "validationRunId": regressionRunID, "phase": "validation",
	}, "")
	if res.status != 200 || res.body["recorded"] != false {
		t.Fatalf("regression outcome read-back: %d %+v", res.status, res.body)
	}
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
	if _, err := pool.Exec(ctx, `UPDATE runs SET input_json = jsonb_set(
		coalesce(input_json, '{}'::jsonb), '{drill}',
		'{"kind":"solution_pack_drill","packId":"incident-triage","fixtureId":"github_secret_unbound","failureMode":"secret_unbound","recoveryPath":"runtime_failure"}'::jsonb
	) WHERE org_id = $1 AND id = $2`, h.org, runID); err != nil {
		t.Fatalf("mark controlled drill provenance: %v", err)
	}

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

	// The focused route, Home section, and pilot-only dossier alias share the
	// full bounded validation contract.
	res = h.call("GET", "/recovery/validation?windowDays=365", nil, "")
	if res.status != 200 {
		t.Fatalf("validation: %d %+v", res.status, res.body)
	}
	if res.body["windowDays"] != float64(90) || res.body["sampleLimit"] != float64(100) || res.body["sampleCapped"] != false {
		t.Fatalf("validation bounds: %+v", res.body)
	}
	totals := res.body["totals"].(map[string]any)
	if totals["drills"] != float64(1) || totals["completed"] != float64(1) ||
		totals["recovered"] != float64(1) || totals["recoveryRatePercent"] != float64(100) {
		t.Fatalf("validation totals: %+v", totals)
	}
	resolution := res.body["resolution"].(map[string]any)
	if resolution["operator"] != float64(1) || resolution["operatorInterventionRatePercent"] != float64(100) {
		t.Fatalf("validation resolution: %+v", resolution)
	}
	samples := res.body["samples"].([]any)
	if len(samples) != 1 || samples[0].(map[string]any)["runId"] != runID || samples[0].(map[string]any)["resolutionMode"] != "operator" {
		t.Fatalf("validation samples: %+v", samples)
	}

	home := h.call("GET", "/recovery/home", nil, "")
	homeValidation := home.body["sections"].(map[string]any)["validation"].(map[string]any)
	if homeValidation["status"] != "ok" || homeValidation["value"].(map[string]any)["sampleLimit"] != float64(100) {
		t.Fatalf("home validation section: %+v", homeValidation)
	}
	alias := h.call("GET", "/recovery/drills/dossier", nil, "")
	if alias.status != 200 || alias.body["totals"].(map[string]any)["recovered"] != float64(1) {
		t.Fatalf("dossier alias: %d %+v", alias.status, alias.body)
	}

	markdownRes, markdownBody := h.rawGet(t, "/reports/recovery-validation?windowDays=30&format=markdown")
	if markdownRes.StatusCode != 200 || !strings.Contains(markdownRes.Header.Get("Content-Disposition"), "janusly-recovery-validation-") ||
		!strings.Contains(string(markdownBody), "Recovery rate among completed outcomes**: 1/1 (100.0%)") {
		t.Fatalf("validation markdown export: %d %q\n%s", markdownRes.StatusCode,
			markdownRes.Header.Get("Content-Disposition"), markdownBody)
	}
	jsonRes, jsonBody := h.rawGet(t, "/reports/recovery-validation?windowDays=30&format=json")
	if jsonRes.StatusCode != 200 || !strings.Contains(string(jsonBody), `"evidence":"controlled_recovery_drills"`) ||
		!strings.Contains(string(jsonBody), `"limitations":["external_partner_count","setup_time","willingness_to_pay"]`) {
		t.Fatalf("validation JSON export: %d %s", jsonRes.StatusCode, jsonBody)
	}
	if invalid, _ := h.rawGet(t, "/reports/recovery-validation?format=pdf"); invalid.StatusCode != 400 {
		t.Fatalf("validation unknown export format: %d", invalid.StatusCode)
	}
	var exports int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1
		AND action = 'report.recovery_validation.exported' AND target_id = $1`, h.org).Scan(&exports)
	if exports != 2 {
		t.Fatalf("validation exports must be audited: %d", exports)
	}
	foreign := h.call("GET", "/recovery/validation", nil, h.org+"-other")
	if foreign.status != 200 || foreign.body["totals"].(map[string]any)["drills"] != float64(0) {
		t.Fatalf("validation tenant isolation: %d %+v", foreign.status, foreign.body)
	}

	// A server-authored drill without a durable DLQ anchor remains visible as
	// missing evidence rather than disappearing or being inferred as healthy.
	missingRun := "run-drill-missing-" + h.org
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json)
		VALUES ($1, $2, 'wf-missing', 'succeeded',
		'{"drill":{"kind":"solution_pack_drill","packId":"incident-triage","fixtureId":"missing-boundary","failureMode":"unknown","recoveryPath":"runtime_failure"}}'::jsonb)`,
		missingRun, h.org); err != nil {
		t.Fatalf("seed missing-evidence drill: %v", err)
	}
	missing := h.call("GET", "/recovery/validation", nil, "")
	missingTotals := missing.body["totals"].(map[string]any)
	missingSamples := missing.body["samples"].([]any)
	if missing.status != 200 || missingTotals["drills"] != float64(2) ||
		missingTotals["missingEvidence"] != float64(1) || len(missingSamples) != 2 ||
		missingSamples[0].(map[string]any)["runId"] != missingRun || missingSamples[0].(map[string]any)["outcome"] != nil {
		t.Fatalf("missing evidence must stay explicit: %d %+v", missing.status, missing.body)
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
	// Redrive reopens the incident; this fixture fails again as expected.
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
