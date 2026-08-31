package authoring

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCompileBriefIsBoundedAndProviderFree(t *testing.T) {
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: "Cuando llega un correo, prepara el resumen y pide aprobación antes de enviar a Slack"})
	if err != nil {
		t.Fatal(err)
	}
	if compiled.Brief.Language != "es" || compiled.Brief.Trigger != "email" || compiled.Brief.ExpectedOutcome == "" {
		t.Fatalf("brief inference: %+v", compiled)
	}
	if len(compiled.Brief.Approvals) != 1 || len(compiled.Brief.ExternalEffects) == 0 {
		t.Fatalf("brief effects/approvals: %+v", compiled.Brief)
	}
	if len(compiled.ClarifyingQuestions) > 3 {
		t.Fatalf("questions are not bounded: %d", len(compiled.ClarifyingQuestions))
	}

	_, err = CompileBrief(CompileBriefRequest{Prompt: strings.Repeat("x", MaxBriefPromptChars+1)})
	if err == nil {
		t.Fatal("oversized prompt must fail")
	}
}

func TestCompileBriefPreservesStructuredIntent(t *testing.T) {
	compiled, err := CompileBrief(CompileBriefRequest{
		Prompt: "ignored as objective because structured intent wins",
		Brief: IntentBrief{
			Objective: "Reconcile invoices", Trigger: "schedule", ExpectedOutcome: "A reconciliation report",
			Inputs: []string{"ledger", "ledger", "  "}, Language: "en",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if compiled.Brief.Objective != "Reconcile invoices" || len(compiled.Brief.Inputs) != 1 {
		t.Fatalf("structured fields must win and de-duplicate: %+v", compiled.Brief)
	}
	if !strings.Contains(ProposalPrompt(compiled.Brief), "Reconcile invoices") {
		t.Fatal("proposal prompt must carry the compiled objective")
	}
}

func TestCompileBriefEmitsEmptyCollectionsInsteadOfNull(t *testing.T) {
	compiled, err := CompileBrief(CompileBriefRequest{
		Prompt: "necesito un flujo con approval humano antes de escribir",
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, values := range map[string][]string{
		"inputs":          compiled.Brief.Inputs,
		"externalEffects": compiled.Brief.ExternalEffects,
		"approvals":       compiled.Brief.Approvals,
		"examples":        compiled.Brief.Examples,
	} {
		if values == nil {
			t.Fatalf("%s must be an empty JSON collection, not null", name)
		}
	}
	raw, err := json.Marshal(compiled)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), ":null") {
		t.Fatalf("brief wire contract contains null collection: %s", raw)
	}
}

func TestCompileBriefDistinguishesInboundTriggersFromOutboundEffects(t *testing.T) {
	for _, testCase := range []struct {
		prompt, trigger, effect string
	}{
		{"Send an email to the customer", "manual", "email_delivery"},
		{"Call the partner webhook after approval", "manual", "outbound_webhook"},
		{"When a webhook arrives, summarize it", "webhook", ""},
	} {
		compiled, err := CompileBrief(CompileBriefRequest{Prompt: testCase.prompt})
		if err != nil {
			t.Fatal(err)
		}
		if compiled.Brief.Trigger != testCase.trigger {
			t.Fatalf("%q trigger=%q want %q", testCase.prompt, compiled.Brief.Trigger, testCase.trigger)
		}
		if testCase.effect != "" && !containsAnyFold(strings.Join(compiled.Brief.ExternalEffects, ","), testCase.effect) {
			t.Fatalf("%q effects=%v want %q", testCase.prompt, compiled.Brief.ExternalEffects, testCase.effect)
		}
		if testCase.effect == "" && len(compiled.Brief.ExternalEffects) != 0 {
			t.Fatalf("inbound-only prompt inferred outbound effects: %+v", compiled.Brief)
		}
	}
}
