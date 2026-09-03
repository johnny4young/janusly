//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func technicalAutonomyWorkflow(maxAttempts int, url string) map[string]any {
	return map[string]any{
		"id": "billing-recovery", "name": "Billing recovery",
		"recovery": map[string]any{"contract": map[string]any{
			"version": "1",
			"failure": map[string]any{
				"technical": map[string]any{"terminalNodeFailure": true, "stalledNode": true},
				"semantic":  map[string]any{"mode": "disabled"},
			},
			"evidence": map[string]any{"required": []string{
				"failure_snapshot", "audit_trail", "validation_receipt", "effect_receipt", "terminal_outcome",
			}},
			"effects": []any{map[string]any{
				"nodeId": "charge", "kind": "financial_mutation", "idempotency": "required", "receipt": "provider",
			}},
			"repairs":    map[string]any{"allowed": []string{"retry", "config_patch"}},
			"validation": map[string]any{"minimumEvidenceLevel": "provider_simulated"},
			"approval": map[string]any{
				"productionMutation": "autonomous_level_4", "permission": "recovery.write",
			},
			"autonomyLevel": 4,
			"narrowAutonomy": map[string]any{
				"allowedRepairClasses": []string{"retry"}, "minimumPriorVerifiedRecoveries": 2,
				"maxAffectedExecutions": 1, "rollbackRequired": true,
			},
			"verification": map[string]any{"kind": "generation_bound_terminal_success"},
			"recurrence":   map[string]any{"windowDays": 7},
		}},
		"nodes": []any{map[string]any{
			"id": "charge", "type": "http", "config": map[string]any{
				"url": url, "method": "POST", "retry": map[string]any{"maxAttempts": maxAttempts},
			},
		}},
		"edges": []any{},
	}
}

func autonomyJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func autonomyRowsByID(t *testing.T, response apiResponse) map[string]map[string]any {
	t.Helper()
	if response.status != 200 {
		t.Fatalf("pending status: %d %+v", response.status, response.body)
	}
	result := map[string]map[string]any{}
	for _, raw := range response.body["rows"].([]any) {
		row := raw.(map[string]any)
		result[row["id"].(string)] = row
	}
	return result
}

func autonomyFactorByID(t *testing.T, assessment map[string]any, id string) map[string]any {
	t.Helper()
	for _, raw := range assessment["factors"].([]any) {
		factor := raw.(map[string]any)
		if factor["id"] == id {
			return factor
		}
	}
	t.Fatalf("factor %s absent: %+v", id, assessment)
	return nil
}

func TestAutoHealingAutonomyProjection(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	original := autonomyJSON(t, technicalAutonomyWorkflow(1, "https://payments.example/charge"))
	retryCandidate := autonomyJSON(t, technicalAutonomyWorkflow(3, "https://payments.example/charge"))
	configCandidate := autonomyJSON(t, technicalAutonomyWorkflow(1, "https://payments.example/v2/charge"))
	eligibleID := "autonomy-eligible-" + suffix
	blockedID := "autonomy-blocked-" + suffix
	missingID := "autonomy-missing-" + suffix
	eligibleDLQ := "autonomy-eligible-dlq-" + suffix
	blockedDLQ := "autonomy-blocked-dlq-" + suffix

	seedDeadLetter := func(id, runID, org string) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO dead_letters
			(id, org_id, run_id, node_id, attempt, workflow_json, node_json, error_json, status)
			VALUES ($1, $2, $3, 'charge', 1, $4::jsonb,
			'{"id":"charge","type":"http","config":{}}'::jsonb,
			'{"code":"provider_timeout","message":"Provider timed out"}'::jsonb, 'open')`,
			id, org, runID, original); err != nil {
			t.Fatalf("seed dead letter: %v", err)
		}
	}
	seedHealing := func(id, org, deadLetterID, signature, status string, candidate []byte) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO auto_healing_runs
			(id, org_id, dead_letter_id, signature, status, proposed_patch_json,
			 approach_label, confidence, validation_evidence_level, loop_attempt_count)
			VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'untrusted_label', 90,
			'provider_simulated', 1)`, id, org, deadLetterID, signature, status, candidate); err != nil {
			t.Fatalf("seed auto healing: %v", err)
		}
	}

	seedDeadLetter(eligibleDLQ, "run-eligible-"+suffix, h.org)
	seedDeadLetter(blockedDLQ, "run-blocked-"+suffix, h.org)
	seedHealing(eligibleID, h.org, eligibleDLQ, "signature-eligible", "validated", retryCandidate)
	seedHealing(blockedID, h.org, blockedDLQ, "signature-blocked", "validated", configCandidate)
	seedHealing(missingID, h.org, "missing-dlq-"+suffix, "signature-missing", "validated", retryCandidate)

	for index := range 2 {
		priorDLQ := fmt.Sprintf("autonomy-prior-%s-%d", suffix, index)
		seedDeadLetter(priorDLQ, fmt.Sprintf("run-prior-%s-%d", suffix, index), h.org)
		seedHealing(fmt.Sprintf("prior-eligible-%s-%d", suffix, index), h.org, priorDLQ, "signature-eligible", "applied", retryCandidate)
		seedHealing(fmt.Sprintf("prior-blocked-%s-%d", suffix, index), h.org, priorDLQ, "signature-blocked", "applied", configCandidate)
		if _, err := pool.Exec(ctx, `INSERT INTO recovery_impact_events
			(dead_letter_id, org_id, run_id, node_id, user_id, recovered_at, downtime_ended_ms)
			VALUES ($1, $2, $3, 'charge', 'operator', now(), 1000)`,
			priorDLQ, h.org, fmt.Sprintf("run-prior-%s-%d", suffix, index)); err != nil {
			t.Fatalf("seed impact: %v", err)
		}
	}
	// A duplicate applied decision for the same dead letter must not inflate
	// the distinct verified-recovery count.
	seedHealing("prior-eligible-duplicate-"+suffix, h.org,
		"autonomy-prior-"+suffix+"-0", "signature-eligible", "applied", retryCandidate)
	// Same-signature facts in another tenant must not leak into this count.
	foreignOrg := "foreign-autonomy-" + suffix
	foreignDLQ := "foreign-autonomy-dlq-" + suffix
	seedDeadLetter(foreignDLQ, "foreign-run-"+suffix, foreignOrg)
	seedHealing("foreign-autonomy-"+suffix, foreignOrg, foreignDLQ, "signature-eligible", "applied", retryCandidate)
	if _, err := pool.Exec(ctx, `INSERT INTO recovery_impact_events
		(dead_letter_id, org_id, run_id, node_id, user_id, recovered_at, downtime_ended_ms)
		VALUES ($1, $2, $3, 'charge', 'operator', now(), 1000)`, foreignDLQ, foreignOrg, "foreign-run-"+suffix); err != nil {
		t.Fatalf("seed foreign impact: %v", err)
	}

	rows := autonomyRowsByID(t, h.call("GET", "/auto-healing/pending", nil, ""))
	if len(rows) != 3 {
		t.Fatalf("pending row count: %d %+v", len(rows), rows)
	}
	eligible := rows[eligibleID]["autonomyAssessment"].(map[string]any)
	if eligible["eligible"] != true || eligible["repairClass"] != "retry" ||
		eligible["priorVerifiedRecoveries"] != float64(2) || len(eligible["factors"].([]any)) != 7 {
		t.Fatalf("eligible assessment: %+v", eligible)
	}
	if policy := eligible["policy"].(map[string]any); policy["unavailableReason"] != nil {
		t.Fatalf("available policy null contract: %+v", policy)
	}

	blocked := rows[blockedID]["autonomyAssessment"].(map[string]any)
	repair := autonomyFactorByID(t, blocked, "repair_scope")
	if blocked["eligible"] != false || blocked["repairClass"] != "config_patch" ||
		blocked["priorVerifiedRecoveries"] != float64(2) || repair["reason"] != "repair_not_allowlisted" {
		t.Fatalf("blocked assessment: %+v", blocked)
	}

	missing := rows[missingID]["autonomyAssessment"].(map[string]any)
	if missing["eligible"] != false || missing["repairClass"] != nil ||
		autonomyFactorByID(t, missing, "policy")["reason"] != "policy_unavailable" {
		t.Fatalf("missing context must fail closed: %+v", missing)
	}

	detail := h.call("GET", "/auto-healing/"+eligibleID, nil, "")
	if detail.status != 200 {
		t.Fatalf("detail: %d %+v", detail.status, detail.body)
	}
	detailAssessment := detail.body["row"].(map[string]any)["autonomyAssessment"].(map[string]any)
	if detailAssessment["eligible"] != true || detailAssessment["priorVerifiedRecoveries"] != float64(2) {
		t.Fatalf("detail assessment: %+v", detailAssessment)
	}
}
