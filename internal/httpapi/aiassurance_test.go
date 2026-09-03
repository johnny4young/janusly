package httpapi

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func assuranceWorkflow(nodes []any, edges []any) map[string]any {
	return map[string]any{
		"dslVersion": "1.0", "id": "assurance", "name": "Assurance",
		"nodes": nodes, "edges": edges,
	}
}

func compileAssuranceDocument(t *testing.T, prompt string, document map[string]any) (map[string]any, assuranceCompilation) {
	t.Helper()
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	compiled, meta, err := compileWorkflowAssurance(prompt, raw)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal(compiled, &result); err != nil {
		t.Fatal(err)
	}
	return result, meta
}

func TestCompileWorkflowAssuranceOutputs(t *testing.T) {
	document := assuranceWorkflow(
		[]any{
			map[string]any{"id": "start", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "left", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "right", "type": "noop", "config": map[string]any{}},
		},
		[]any{
			map[string]any{"from": "start", "to": "left"},
			map[string]any{"from": "start", "to": "right"},
		},
	)
	compiled, meta := compileAssuranceDocument(t, "branch", document)
	if !meta.AddedOutputs || meta.AddedRecoveryContract {
		t.Fatalf("compilation metadata: %+v", meta)
	}
	want := map[string]any{
		"result_1": "{{context.left.output}}",
		"result_2": "{{context.right.output}}",
	}
	if !reflect.DeepEqual(compiled["outputs"], want) {
		t.Fatalf("terminal projections: got %#v want %#v", compiled["outputs"], want)
	}

	document["outputs"] = map[string]any{"business_result": "{{context.left.output.value}}"}
	preserved, preservedMeta := compileAssuranceDocument(t, "branch", document)
	if preservedMeta.AddedOutputs || !reflect.DeepEqual(preserved["outputs"], document["outputs"]) {
		t.Fatalf("operator outputs must be preserved: %+v %#v", preservedMeta, preserved["outputs"])
	}
}

func TestCompileWorkflowAssuranceAddsConservativeRecoveryV1(t *testing.T) {
	document := assuranceWorkflow(
		[]any{
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{}},
			map[string]any{"id": "notify", "type": "tool", "config": map[string]any{"tool": "slack.post", "input": map[string]any{}}},
		},
		[]any{map[string]any{"from": "gate", "to": "notify"}},
	)
	compiled, meta := compileAssuranceDocument(t, "Crea un flujo resiliente y recuperable", document)
	if !meta.AddedOutputs || !meta.AddedRecoveryContract {
		t.Fatalf("expected both contracts: %+v", meta)
	}
	recoveryMap := compiled["recovery"].(map[string]any)
	if recoveryMap["circuitBreaker"] != float64(3) {
		t.Fatalf("circuit breaker: %#v", recoveryMap["circuitBreaker"])
	}
	contract := recoveryMap["contract"].(map[string]any)
	if contract["version"] != "1" || contract["autonomyLevel"] != float64(1) {
		t.Fatalf("conservative v1: %#v", contract)
	}
	effects := contract["effects"].([]any)
	if len(effects) != 2 {
		t.Fatalf("truthful effects expected: %#v", effects)
	}
	for _, effectValue := range effects {
		effect := effectValue.(map[string]any)
		if effect["idempotency"] != "unavailable" {
			t.Fatalf("compiler must not invent idempotency: %#v", effect)
		}
	}
}

func TestCompileWorkflowAssurancePreservesV2Qualification(t *testing.T) {
	document := assuranceWorkflow(
		[]any{map[string]any{"id": "calc", "type": "transform", "config": map[string]any{
			"mapping": map[string]any{"total": "{{context.input.total}}"},
		}}},
		[]any{},
	)
	document["recovery"] = map[string]any{
		"circuitBreaker": 5,
		"contract": map[string]any{
			"version": "2",
			"failure": map[string]any{
				"technical": map[string]any{"terminalNodeFailure": true, "stalledNode": false},
				"semantic": map[string]any{
					"mode": "deterministic",
					"detectors": []any{map[string]any{
						"id": "det_total", "sourceNodeId": "calc", "kind": "expression",
						"passWhen": `context.calc.output.total == "10"`, "action": "observe", "message": "unexpected total",
					}},
					"evaluationFixtures": []any{
						map[string]any{"id": "pass", "sourceNodeId": "calc", "output": map[string]any{"total": "10"}, "expected": "pass"},
						map[string]any{"id": "violation", "sourceNodeId": "calc", "output": map[string]any{"total": "11"}, "expected": "violation"},
					},
				},
			},
			"evidence": map[string]any{"required": []any{"failure_snapshot", "audit_trail", "terminal_outcome"}},
			"effects":  []any{}, "repairs": map[string]any{"allowed": []any{"retry"}},
			"validation":    map[string]any{"minimumEvidenceLevel": "static"},
			"approval":      map[string]any{"productionMutation": "required", "permission": "recovery.write"},
			"autonomyLevel": 2,
			"verification":  map[string]any{"kind": "generation_bound_terminal_success"},
			"recurrence":    map[string]any{"windowDays": 7},
		},
	}
	before, _ := json.Marshal(document["recovery"])
	compiled, meta := compileAssuranceDocument(t, "make this resilient", document)
	if meta.AddedRecoveryContract {
		t.Fatal("compiler must never replace an authored V2 contract")
	}
	after, _ := json.Marshal(compiled["recovery"])
	if string(after) != string(before) {
		t.Fatalf("V2 changed:\n before=%s\n after=%s", before, after)
	}
}

func TestCompileWorkflowAssuranceDoesNotMutateFallbackCatalog(t *testing.T) {
	template := fallbackTemplateForPrompt("human approval")
	if _, exists := template["outputs"]; exists {
		t.Fatal("test requires pristine fallback catalog")
	}
	compiled, meta := compiledFallbackForPrompt("human approval in a resilient workflow")
	if !meta.AddedOutputs || !meta.AddedRecoveryContract || compiled["recovery"] == nil {
		t.Fatalf("compiled fallback: %+v %#v", meta, compiled)
	}
	if _, exists := fallbackTemplateForPrompt("human approval")["outputs"]; exists {
		t.Fatal("request compilation mutated the global fallback catalog")
	}
}

func TestCompileWorkflowAssuranceRejectsMalformedExistingRecovery(t *testing.T) {
	document := assuranceWorkflow(
		[]any{map[string]any{"id": "done", "type": "noop", "config": map[string]any{}}},
		[]any{},
	)
	document["recovery"] = "not-an-object"
	raw, _ := json.Marshal(document)
	_, _, err := compileWorkflowAssurance("resilient", raw)
	if err == nil || !strings.Contains(err.Error(), "invalid_contract") {
		t.Fatalf("malformed authored recovery must fail closed: %v", err)
	}
}
