package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func technicalLevel4Contract() *RecoveryContract {
	contract := &RecoveryContract{Version: "1", AutonomyLevel: 4}
	contract.Failure.Technical.TerminalNodeFailure = true
	contract.Failure.Technical.StalledNode = true
	contract.Failure.Semantic.Mode = "disabled"
	contract.Evidence.Required = []string{
		"failure_snapshot", "audit_trail", "validation_receipt", "effect_receipt", "terminal_outcome",
	}
	contract.Effects = []RecoveryEffect{{
		NodeID: "charge", Kind: "financial_mutation", Idempotency: "required", Receipt: "provider",
	}}
	contract.Repairs.Allowed = []string{"retry", "config_patch", "structural_patch"}
	contract.Validation.MinimumEvidenceLevel = "provider_simulated"
	contract.Approval.ProductionMutation = "autonomous_level_4"
	contract.Approval.Permission = "recovery.write"
	contract.NarrowAutonomy = &RecoveryNarrowAutonomy{
		AllowedRepairClasses: []string{"retry"}, MinimumPriorVerifiedRecoveries: 2,
		MaxAffectedExecutions: 1, RollbackRequired: true,
	}
	contract.Verification.Kind = "generation_bound_terminal_success"
	contract.Recurrence.WindowDays = 7
	return contract
}

func technicalWorkflowDocument(contract *RecoveryContract, maxAttempts int, url string) map[string]any {
	document := map[string]any{
		"id": "billing-recovery", "name": "Billing recovery",
		"nodes": []any{map[string]any{
			"id": "charge", "type": "http", "config": map[string]any{
				"url": url, "method": "POST", "retry": map[string]any{"maxAttempts": maxAttempts},
			},
		}},
		"edges": []any{},
	}
	if contract != nil {
		document["recovery"] = map[string]any{"contract": contract}
	}
	return document
}

func mustTechnicalWorkflow(t *testing.T, document map[string]any) *TechnicalRecoveryWorkflow {
	t.Helper()
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	workflow, ok := ParseTechnicalRecoveryWorkflow(raw)
	if !ok {
		t.Fatalf("technical workflow must parse: %s", raw)
	}
	return workflow
}

func technicalFactorByID(t *testing.T, assessment TechnicalRecoveryAutonomyAssessment, id string) TechnicalAutonomyFactor {
	t.Helper()
	for _, factor := range assessment.Factors {
		if factor.ID == id {
			return factor
		}
	}
	t.Fatalf("factor %s absent: %+v", id, assessment.Factors)
	return TechnicalAutonomyFactor{}
}

func TestTechnicalRecoveryAutonomyRetryAndConfigPatch(t *testing.T) {
	contract := technicalLevel4Contract()
	if problems := ValidateRecoveryContract(contract); len(problems) != 0 {
		t.Fatalf("fixture contract must validate: %v", problems)
	}
	original := mustTechnicalWorkflow(t, technicalWorkflowDocument(contract, 1, "https://payments.example/charge"))
	retryCandidate := mustTechnicalWorkflow(t, technicalWorkflowDocument(contract, 3, "https://payments.example/charge"))
	configCandidate := mustTechnicalWorkflow(t, technicalWorkflowDocument(contract, 1, "https://payments.example/v2/charge"))

	if repair := ClassifyTechnicalRecoveryRepair(original, retryCandidate, "charge"); repair != "retry" {
		t.Fatalf("retry-only patch: %q", repair)
	}
	eligible := EvaluateTechnicalRecoveryAutonomy(TechnicalRecoveryAutonomyInput{
		Contract: contract, Failure: TechnicalFailureTerminal,
		RepairClass: "retry", ValidationEvidenceLevel: "provider_simulated",
		PriorVerifiedRecoveries: 2, AffectedExecutions: 1, RollbackReady: true,
	})
	if !eligible.Eligible || eligible.RepairClass == nil || *eligible.RepairClass != "retry" || len(eligible.Factors) != 7 {
		t.Fatalf("eligible retry: %+v", eligible)
	}
	for index, id := range TechnicalAutonomyFactorIDs {
		if eligible.Factors[index].ID != id || !eligible.Factors[index].Passed || eligible.Factors[index].Reason != "ready" {
			t.Fatalf("ordered factor %d: %+v", index, eligible.Factors[index])
		}
	}
	encoded, err := json.Marshal(eligible)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"unavailableReason":null`) {
		t.Fatalf("available policy must retain explicit null on the wire: %s", encoded)
	}

	if repair := ClassifyTechnicalRecoveryRepair(original, configCandidate, "charge"); repair != "config_patch" {
		t.Fatalf("other failing-node config patch: %q", repair)
	}
	blocked := EvaluateTechnicalRecoveryAutonomy(TechnicalRecoveryAutonomyInput{
		Contract: contract, Failure: TechnicalFailureTerminal,
		RepairClass: "config_patch", ValidationEvidenceLevel: "provider_simulated",
		PriorVerifiedRecoveries: 2, AffectedExecutions: 1, RollbackReady: true,
	})
	repairFactor := technicalFactorByID(t, blocked, "repair_scope")
	if blocked.Eligible || repairFactor.Passed || repairFactor.Reason != "repair_not_allowlisted" {
		t.Fatalf("blocked config patch: %+v", blocked)
	}
}

func TestTechnicalRecoveryAutonomyFailsClosed(t *testing.T) {
	contract := technicalLevel4Contract()
	contract.Failure.Technical.Autonomy = map[string]int{"stalledNode": 3}
	stalled := EvaluateTechnicalRecoveryAutonomy(TechnicalRecoveryAutonomyInput{
		Contract: contract, Failure: TechnicalFailureStalled,
		RepairClass: "retry", ValidationEvidenceLevel: "provider_simulated",
		PriorVerifiedRecoveries: 2, AffectedExecutions: 1, RollbackReady: true,
	})
	policy := technicalFactorByID(t, stalled, "policy")
	if stalled.Eligible || policy.Reason != "autonomy_level_below_4" || stalled.Failure != TechnicalFailureStalled {
		t.Fatalf("stalled override: %+v", stalled)
	}

	missing := EvaluateTechnicalRecoveryAutonomy(TechnicalRecoveryAutonomyInput{
		Failure: TechnicalFailureTerminal, RepairClass: "retry",
		ValidationEvidenceLevel: "unknown", PriorVerifiedRecoveries: 9,
		AffectedExecutions: 1, RollbackReady: true,
	})
	if missing.Eligible || missing.Policy.UnavailableReason == nil ||
		*missing.Policy.UnavailableReason != "contract_missing" ||
		technicalFactorByID(t, missing, "policy").Reason != "policy_unavailable" ||
		missing.ValidationEvidenceLevel != "static" {
		t.Fatalf("missing contract must fail closed: %+v", missing)
	}
}

func TestClassifyTechnicalRecoveryStructuralGrammar(t *testing.T) {
	contract := technicalLevel4Contract()
	originalDocument := technicalWorkflowDocument(contract, 1, "https://payments.example/charge")
	originalDocument["nodes"] = append([]any{map[string]any{
		"id": "start", "type": "noop", "config": map[string]any{},
	}}, originalDocument["nodes"].([]any)...)
	originalDocument["edges"] = []any{map[string]any{
		"id": "into-charge", "from": "start", "to": "charge", "condition": "context.start.output.ok",
	}}
	original := mustTechnicalWorkflow(t, originalDocument)

	candidateDocument := technicalWorkflowDocument(contract, 1, "https://payments.example/charge")
	candidateDocument["nodes"] = []any{
		map[string]any{"id": "start", "type": "noop", "config": map[string]any{}},
		map[string]any{"id": "charge", "type": "http", "config": map[string]any{
			"url": "https://payments.example/charge", "method": "POST", "retry": map[string]any{"maxAttempts": 1},
		}},
		map[string]any{"id": "approve", "type": "approval", "config": map[string]any{"message": "Approve retry"}},
	}
	candidateDocument["edges"] = []any{
		map[string]any{"id": "into-charge", "from": "start", "to": "approve", "condition": "context.start.output.ok"},
		map[string]any{"from": "approve", "to": "charge"},
	}
	candidate := mustTechnicalWorkflow(t, candidateDocument)
	if repair := ClassifyTechnicalRecoveryRepair(original, candidate, "charge"); repair != "structural_patch" {
		t.Fatalf("exact approval insertion: %q", repair)
	}

	unrelatedDocument := technicalWorkflowDocument(contract, 1, "https://payments.example/charge")
	unrelatedDocument["nodes"] = []any{
		map[string]any{"id": "charge", "type": "http", "config": map[string]any{
			"url": "https://payments.example/charge", "method": "POST", "retry": map[string]any{"maxAttempts": 1},
		}},
		map[string]any{"id": "other", "type": "noop", "config": map[string]any{"changed": true}},
	}
	unrelated := mustTechnicalWorkflow(t, unrelatedDocument)
	baseWithOther := technicalWorkflowDocument(contract, 1, "https://payments.example/charge")
	baseWithOther["nodes"] = []any{
		map[string]any{"id": "charge", "type": "http", "config": map[string]any{
			"url": "https://payments.example/charge", "method": "POST", "retry": map[string]any{"maxAttempts": 1},
		}},
		map[string]any{"id": "other", "type": "noop", "config": map[string]any{}},
	}
	if repair := ClassifyTechnicalRecoveryRepair(mustTechnicalWorkflow(t, baseWithOther), unrelated, "charge"); repair != "" {
		t.Fatalf("unrelated node change must fail closed: %q", repair)
	}

	metadataCandidate := technicalWorkflowDocument(contract, 3, "https://payments.example/charge")
	metadataCandidate["metadata"] = map[string]any{"description": "changed"}
	if repair := ClassifyTechnicalRecoveryRepair(
		mustTechnicalWorkflow(t, technicalWorkflowDocument(contract, 1, "https://payments.example/charge")),
		mustTechnicalWorkflow(t, metadataCandidate), "charge",
	); repair != "" {
		t.Fatalf("workflow metadata change must fail closed: %q", repair)
	}

	invalid := technicalWorkflowDocument(contract, 1, "https://payments.example/charge")
	invalid["metadata"] = nil
	raw, _ := json.Marshal(invalid)
	if _, ok := ParseTechnicalRecoveryWorkflow(raw); ok {
		t.Fatal("explicit null metadata must fail schema parsing")
	}
}
