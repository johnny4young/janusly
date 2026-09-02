//go:build integration

package httpapi

import (
	"fmt"
	"testing"
	"time"
)

func v2ContractDoc(detectorSource string) map[string]any {
	return v2ContractDocWithFixtures(detectorSource, detectorSource)
}

func v2ContractDocWithFixtures(detectorSource, fixtureSource string) map[string]any {
	return map[string]any{
		"contract": map[string]any{
			"version": "2",
			"failure": map[string]any{
				"technical": map[string]any{"terminalNodeFailure": true, "stalledNode": false},
				"semantic": map[string]any{
					"mode": "deterministic",
					"detectors": []any{map[string]any{
						"id": "det-total", "sourceNodeId": detectorSource, "kind": "expression",
						"passWhen": "context." + detectorSource + `.output.total == "10"`,
						"action":   "observe", "message": "total out of bounds",
					}},
					"evaluationFixtures": []any{
						map[string]any{"id": "fx-pass", "sourceNodeId": fixtureSource,
							"output": map[string]any{"total": "10"}, "expected": "pass"},
						map[string]any{"id": "fx-violation", "sourceNodeId": fixtureSource,
							"output": map[string]any{"total": "900"}, "expected": "violation"},
					},
				},
			},
			"evidence":      map[string]any{"required": []any{"failure_snapshot", "audit_trail", "terminal_outcome"}},
			"effects":       []any{},
			"repairs":       map[string]any{"allowed": []any{"retry"}},
			"validation":    map[string]any{"minimumEvidenceLevel": "static"},
			"approval":      map[string]any{"productionMutation": "required", "permission": "recovery.write"},
			"autonomyLevel": 2,
			"verification":  map[string]any{"kind": "generation_bound_terminal_success"},
			"recurrence":    map[string]any{"windowDays": 7},
		},
	}
}

func qualificationWorkflowDoc(id string, recovery map[string]any) map[string]any {
	doc := map[string]any{
		"id": id, "name": "Qualify", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "calc", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"total": "{{context.input.total}}"},
			}},
			map[string]any{"id": "after", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "calc", "to": "after"}},
	}
	if recovery != nil {
		doc["recovery"] = recovery
	}
	return doc
}

// Qualification receipts per EXACT version pair — the immutable
// dataset digest, bootstrap (V1→V2) vs compare modes, the passed receipt
// unlocking the rollout create gate, and a coverage regression failing
// the candidate (no node runs, no provider is called, no LLM judge).
func TestRolloutQualificationReceipts(t *testing.T) {
	h := newAPIHarness(t)
	wfID := fmt.Sprintf("wf-qual-%d", time.Now().UnixNano())

	save := func(id string, recovery map[string]any) string {
		res := h.call("POST", "/workflows/save", qualificationWorkflowDoc(id, recovery), "")
		if res.status != 200 {
			t.Fatalf("save: %d %+v", res.status, res.body)
		}
		return res.body["versionId"].(string)
	}
	v1 := save(wfID, nil)                   // V1 baseline: no contract
	v2 := save(wfID, v2ContractDoc("calc")) // V2 candidate

	// The pair is required but has no receipt yet — the rollout refuses.
	res := h.call("GET", "/workflows/"+wfID+"/rollout/qualification?baselineVersionId="+v1+"&candidateVersionId="+v2, nil, "")
	if res.status != 200 || res.body["required"] != true || res.body["qualification"] != nil {
		t.Fatalf("pre-receipt read: %d %+v", res.status, res.body)
	}
	createBody := map[string]any{
		"baselineVersionId": v1, "canaryVersionId": v2,
		"trafficPercent": 20, "minimumSampleSize": 5, "minimumSuccessRatePercent": 90,
	}
	if res = h.call("POST", "/workflows/"+wfID+"/rollout", createBody, ""); res.status != 409 ||
		res.body["code"] != "workflow_recovery_qualification_required" {
		t.Fatalf("gate must 409: %d %+v", res.status, res.body)
	}

	// Record the receipt: V1→V2 runs in BOOTSTRAP mode and passes (the
	// candidate's own fixtures replay through the runtime evaluator).
	res = h.call("POST", "/workflows/"+wfID+"/rollout/qualification", map[string]any{
		"baselineVersionId": v1, "candidateVersionId": v2,
	}, "")
	if res.status != 200 || res.body["required"] != true {
		t.Fatalf("record: %d %+v", res.status, res.body)
	}
	qualification := res.body["qualification"].(map[string]any)
	if qualification["mode"] != "bootstrap" || qualification["status"] != "passed" ||
		qualification["datasetDigest"] == "" || qualification["datasetVersion"] != "1" {
		t.Fatalf("receipt: %+v", qualification)
	}
	// The passed receipt for the EXACT pair unlocks the create.
	if res = h.call("POST", "/workflows/"+wfID+"/rollout", createBody, ""); res.status != 200 {
		t.Fatalf("post-receipt create: %d %+v", res.status, res.body)
	}

	// Compare-mode coverage regression: the candidate moves its detector
	// off the baseline dataset's source node → uncovered → failed, and
	// the failed receipt does NOT satisfy the gate.
	wf2 := wfID + "-b"
	b1 := save(wf2, v2ContractDoc("calc"))
	b2 := save(wf2, v2ContractDoc("after"))
	res = h.call("POST", "/workflows/"+wf2+"/rollout/qualification", map[string]any{
		"baselineVersionId": b1, "candidateVersionId": b2,
	}, "")
	if res.status != 200 {
		t.Fatalf("compare record: %d %+v", res.status, res.body)
	}
	compare := res.body["qualification"].(map[string]any)
	summary := compare["summary"].(map[string]any)
	if compare["mode"] != "compare" || compare["status"] != "failed" ||
		summary["coverageFailureCount"].(float64) < 1 || summary["regressionCount"].(float64) < 1 {
		t.Fatalf("regression receipt: %+v", compare)
	}
	if res = h.call("POST", "/workflows/"+wf2+"/rollout", map[string]any{
		"baselineVersionId": b1, "canaryVersionId": b2,
		"trafficPercent": 20, "minimumSampleSize": 5, "minimumSuccessRatePercent": 90,
	}, ""); res.status != 409 {
		t.Fatalf("failed receipt must NOT unlock: %d %+v", res.status, res.body)
	}

	// Plain pair (no contracts anywhere) → not required, nothing recorded.
	wf3 := wfID + "-c"
	c1 := save(wf3, nil)
	c2 := save(wf3, nil)
	res = h.call("POST", "/workflows/"+wf3+"/rollout/qualification", map[string]any{
		"baselineVersionId": c1, "candidateVersionId": c2,
	}, "")
	if res.status != 200 || res.body["required"] != false {
		t.Fatalf("not-required: %d %+v", res.status, res.body)
	}
}
