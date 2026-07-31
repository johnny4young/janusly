//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
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
