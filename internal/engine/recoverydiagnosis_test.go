package engine

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/aidiagnosis"
)

func diagnosisFacts(language string) RecoveryDiagnosisFacts {
	level := 3
	return RecoveryDiagnosisFacts{
		Language: language, Message: "The invoice total does not match the contract.",
		Details: []string{"expected 100", "received 91"},
		RunID:   "run-1", SourceNodeID: "invoice", DetectorID: "invoice_total",
		DetectorKind: "expression", Action: "quarantine", HasWorkflow: true,
		WorkflowSnapshotAvailable: true, RecoveryContractAvailable: true, AutonomyLevel: &level,
	}
}

func TestBuildRecoveryDiagnosisProviderFreeEnglishAndSpanish(t *testing.T) {
	for _, language := range []string{"en", "es"} {
		diagnosis := BuildRecoveryDiagnosis(diagnosisFacts(language), nil)
		if diagnosis.Mode != "deterministic_fallback" || len(diagnosis.Hypotheses) != 1 ||
			len(diagnosis.RecommendedCandidateKinds) != 3 {
			t.Fatalf("%s deterministic envelope: %+v", language, diagnosis)
		}
		hypothesis := diagnosis.Hypotheses[0]
		if len(hypothesis.EvidenceRefs) != 3 || len(hypothesis.Evidence) < 2 || len(hypothesis.CounterEvidence) < 1 {
			t.Fatalf("%s evidence envelope: %+v", language, hypothesis)
		}
		if language == "es" && !strings.Contains(hypothesis.Cause, "salida del nodo") {
			t.Fatalf("Spanish fallback not localized: %+v", hypothesis)
		}
	}
}

func TestBuildRecoveryDiagnosisAIControlsOnlyBoundedProse(t *testing.T) {
	facts := diagnosisFacts("en")
	enrichment := &aidiagnosis.Enrichment{
		Summary: "The detector and retained snapshot point to a total mismatch.",
		Hypotheses: []aidiagnosis.Hypothesis{{
			ID: "rounding_mismatch", Cause: "A rounding policy may differ from the declared contract.",
			Confidence: 0.7, Evidence: []string{"The retained values differ."},
			CounterEvidence: []string{"The bounded evidence does not include the upstream rounding rule."},
		}},
	}
	diagnosis := BuildRecoveryDiagnosis(facts, enrichment)
	if diagnosis.Mode != "ai_enriched" || diagnosis.Summary != enrichment.Summary || len(diagnosis.Hypotheses) != 1 {
		t.Fatalf("AI prose was not merged: %+v", diagnosis)
	}
	if got := strings.Join(diagnosis.RecommendedCandidateKinds, ","); got != "repair_workflow,adjust_detector,accept_loss" {
		t.Fatalf("AI must not control candidate kinds: %s", got)
	}
	refs := diagnosis.Hypotheses[0].EvidenceRefs
	if len(refs) != 3 || refs[0].ID != "run-1" || refs[2].ID != "invoice_total" {
		t.Fatalf("engine refs must remain deterministic: %+v", refs)
	}
	raw, _ := json.Marshal(diagnosis)
	for _, forbidden := range []string{"permissions", "approval", "patch"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("authority field leaked into diagnosis: %s", raw)
		}
	}
}

func TestBuildRecoveryDiagnosisRejectsInvalidInternalEnrichment(t *testing.T) {
	invalid := &aidiagnosis.Enrichment{Summary: "attempted override", Hypotheses: nil}
	diagnosis := BuildRecoveryDiagnosis(diagnosisFacts("en"), invalid)
	if diagnosis.Mode != "deterministic_fallback" {
		t.Fatalf("invalid internal enrichment must fall back: %+v", diagnosis)
	}
}

func TestRecoveryDiagnosisDetailsAreStableAndBounded(t *testing.T) {
	raw := json.RawMessage(`{"z":"last","a":{"token":"first"},"items":["second","third","fourth","fifth","sixth"]}`)
	details := recoveryDiagnosisDetails(raw)
	if len(details) != aidiagnosis.MaxDetails || details[0] != "a.token: first" || details[1] != "items: second" {
		t.Fatalf("stable bounded details: %+v", details)
	}
}
