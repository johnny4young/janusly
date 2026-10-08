package authoring

import (
	"encoding/json"
	"os"
	"testing"
)

func TestRulesCorpusReportUsesPredictionsAndHonestAccounting(t *testing.T) {
	raw, err := os.ReadFile("testdata/experience-mechanics.json")
	if err != nil {
		t.Fatal(err)
	}
	report, err := CheckRulesMechanicsCorpus(t.Context(), raw)
	if err != nil || report.Cases != 240 || report.Correct != 240 || len(report.Outcomes) != 240 {
		t.Fatalf("report: %+v %v", report, err)
	}
	if report.ExperienceRules.Modes[DecisionReuse] != 60 || report.ExperienceRules.Modes[DecisionAdapt] != 60 || report.GenerationRequestsAvoided != 120 || report.GenerationRequestsDeferredToReview != 20 || report.GenerationRequestDelta != 140 || report.ExperienceRules.GenerationRequested != 60 || report.ExperienceRules.CanonicalRecipeRequested != 0 {
		t.Fatalf("rules/ablation accounting: modes=%v avoided=%d deferred=%d delta=%d", report.ExperienceRules.Modes, report.GenerationRequestsAvoided, report.GenerationRequestsDeferredToReview, report.GenerationRequestDelta)
	}
	if report.ExperienceRules.ActualLogicalCalls != 0 || report.ExperienceRules.SDKTransportRequests != 0 || report.LegacyTemplates.ActualLogicalCalls != 0 {
		t.Fatal("offline runner invented model traffic")
	}
	var cases []DecisionMechanicsCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	cases[0].Expected.VersionID = "invented"
	poisoned, _ := json.Marshal(cases)
	if _, err := CheckRulesMechanicsCorpus(t.Context(), poisoned); err == nil {
		t.Fatal("poisoned label made predictions authoritative")
	}
}

func TestCanonicalRecipeDoesNotRequestTheGenerativePath(t *testing.T) {
	raw, err := os.ReadFile("testdata/experience-replay.json")
	if err != nil {
		t.Fatal(err)
	}
	report, err := ReplayExperienceCorpus(t.Context(), raw)
	if err != nil {
		t.Fatal(err)
	}
	if report.Decisions.GenerationRequested != 14 || report.Decisions.CanonicalRecipeRequested != 2 {
		t.Fatalf("canonical construction conflated with generative path: got %d want 14", report.Decisions.GenerationRequested)
	}
}
