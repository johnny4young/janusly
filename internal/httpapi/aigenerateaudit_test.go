package httpapi

import (
	"reflect"
	"testing"

	"github.com/johnny4young/janusly/internal/ai"
)

func TestFallbackGenerationAuditRetainsBoundedFirstDraftCodes(t *testing.T) {
	codes := []string{"invalid_contract", "unknown_node_type", "dangling_edge", "cycle_detected", "missing_config", "missing_input"}
	meta := generationMeta{repairIssueCodes: codes, validationIssueCodes: codes, failureStage: "candidate_validation"}
	metadata := fallbackGenerationAuditMetadata(meta, &ai.AIError{Class: "parse", Message: "simulated"}, assuranceCompilation{})
	for _, key := range []string{"repairIssueCodes", "validationIssueCodes"} {
		got, ok := metadata[key].([]string)
		if !ok || !reflect.DeepEqual(got, codes[:auditIssueCodeLimit]) {
			t.Fatalf("%s must retain the bounded codes: %#v", key, metadata)
		}
	}
	if len(meta.repairIssueCodes) != len(codes) || len(meta.validationIssueCodes) != len(codes) {
		t.Fatal("audit truncation must not truncate internal qualification evidence")
	}
}

func TestGenerationAuditDiagnosticsShapes(t *testing.T) {
	for _, repaired := range []bool{false, true} {
		t.Run(map[bool]string{false: "clean", true: "repaired"}[repaired], func(t *testing.T) {
			meta := generationMeta{model: "simulated", provider: "simulator", modelCalls: 1, attempts: 1, candidateCount: 1, validCandidates: 1, intentContractAdded: true}
			if repaired {
				meta.repairIssueCodes = []string{"invalid_contract"}
				meta.repairAttempts = 1
				meta.modelCalls = 2
			}
			got := generationAuditMetadata(meta)
			want := map[string]any{"mode": "ai", "generationMode": "free_json", "model": meta.model, "provider": meta.provider, "modelCallCount": meta.modelCalls, "attempts": meta.attempts, "repairAttempts": meta.repairAttempts, "candidateCount": meta.candidateCount, "validCandidates": meta.validCandidates, "intentContractAdded": true, "recoveryContractAdded": false}
			if repaired {
				want["repairIssueCodes"] = []string{"invalid_contract"}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("audit changed shape: got %#v want %#v", got, want)
			}
		})
	}
	for _, tc := range []struct {
		name        string
		meta        generationMeta
		compilation assuranceCompilation
	}{
		{name: "provider failure"},
		{name: "exhausted repair", meta: generationMeta{repairIssueCodes: []string{"invalid_contract"}, validationIssueCodes: []string{"dangling_edge"}, failureStage: "candidate_validation", repairAttempts: 2}, compilation: assuranceCompilation{AddedOutputs: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := fallbackGenerationAuditMetadata(tc.meta, &ai.AIError{Class: "parse", Message: "simulated"}, tc.compilation)
			if got["mode"] != "fallback" || got["error"] != "parse: simulated" || got["intentContractAdded"] != tc.compilation.AddedOutputs {
				t.Fatalf("fallback overrides missing: %#v", got)
			}
			if _, present := got["repairIssueCodes"]; present != (len(tc.meta.repairIssueCodes) > 0) {
				t.Fatalf("repair code presence: %#v", got)
			}
			if _, present := got["validationIssueCodes"]; present != (len(tc.meta.validationIssueCodes) > 0) {
				t.Fatalf("final code presence: %#v", got)
			}
		})
	}
}

func TestGenerationAuditDiagnosticsOwnBoundedCodeCopies(t *testing.T) {
	codes := []string{"invalid_contract", "unknown_node_type", "dangling_edge", "cycle_detected", "missing_config", "missing_input"}
	meta := generationMeta{repairIssueCodes: codes, validationIssueCodes: codes}
	for _, got := range []map[string]any{generationAuditMetadata(meta), fallbackGenerationAuditMetadata(meta, &ai.AIError{Class: "parse"}, assuranceCompilation{})} {
		if len(got["repairIssueCodes"].([]string)) != auditIssueCodeLimit {
			t.Fatal("unbounded first-draft audit codes")
		}
		got["repairIssueCodes"].([]string)[0] = "audit consumer mutation"
		if final, ok := got["validationIssueCodes"].([]string); ok {
			final[0] = "audit consumer mutation"
		}
	}
	if codes[0] != "invalid_contract" || len(meta.repairIssueCodes) != 6 {
		t.Fatalf("audit mutated internal evidence: %#v", meta)
	}
}
