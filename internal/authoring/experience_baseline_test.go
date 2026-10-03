package authoring

import (
	"encoding/json"
	"testing"
)

func TestExperienceContractLeavesCanonicalAuthoringUnchanged(t *testing.T) {
	for _, prompt := range []string{
		"Prepare a local uppercase report manually without external effects",
		"Preparar un reporte local manualmente sin efectos externos",
		"When PagerDuty alerts user PUSER1 outside working hours, acknowledge and snooze for 12 hours. API credential pd-api, webhook credential pd-hook, requester operator@example.com.",
	} {
		t.Run(prompt, func(t *testing.T) {
			compiledBefore, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
			if err != nil {
				t.Fatal(err)
			}
			opts := DeterministicWorkflowOptions{NewID: func() string { return "abcdef12-0000-4000-8000-000000000000" }}
			before, err := json.Marshal(DeterministicWorkflowWithOptions(prompt, opts))
			if err != nil {
				t.Fatal(err)
			}
			r, p := decisionFixture(t)
			provider := &fixtureDecisionProvider{proposal: p}
			if _, err := ProposeDecision(t.Context(), provider, r); err != nil {
				t.Fatal(err)
			}
			after, err := json.Marshal(DeterministicWorkflowWithOptions(prompt, opts))
			if err != nil {
				t.Fatal(err)
			}
			compiledAfter, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
			if err != nil {
				t.Fatal(err)
			}
			b1, _ := json.Marshal(compiledBefore)
			b2, _ := json.Marshal(compiledAfter)
			if string(before) != string(after) || string(b1) != string(b2) {
				t.Fatal("decision contract mutated canonical authoring")
			}
		})
	}
}

func TestExperienceContractCanonicalRecipeVetoesRegisteredReuse(t *testing.T) {
	r, p := decisionFixture(t)
	r.CanonicalRecipe = true
	if _, err := ValidateDecision(r, p); err == nil {
		t.Fatal("generic experience displaced canonical recipe")
	}
	p = DecisionProposal{Mode: DecisionGenerate, Reason: DecisionCanonicalRecipe, ContextRevision: r.ContextRevision, CatalogVersion: r.CatalogVersion}
	receipt, err := ValidateDecision(r, p)
	if err != nil || receipt.Source != nil || receipt.Reason != DecisionCanonicalRecipe {
		t.Fatalf("canonical priority lost: %+v %v", receipt, err)
	}
}
