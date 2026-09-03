package authoring

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
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

func TestCompileBriefTreatsStructuredManualAndNoEffectsAsExplicit(t *testing.T) {
	compiled, err := CompileBrief(CompileBriefRequest{Brief: IntentBrief{
		Objective: "Inspect one payload", Trigger: "manual", ExpectedOutcome: "A local inspection",
		ExternalEffects: []string{}, Language: "en",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !compiled.Complete || len(compiled.ClarifyingQuestions) != 0 {
		t.Fatalf("structured manual/read-only intent was reclassified as ambiguous: %+v", compiled)
	}

	compiled, err = CompileBrief(CompileBriefRequest{
		Prompt: "Send an email to the customer",
		Brief: IntentBrief{
			Objective: "Prepare a local preview", Trigger: "manual", ExpectedOutcome: "A local preview",
			ExternalEffects: []string{}, Language: "en",
		},
	})
	if err != nil || !compiled.Complete || len(compiled.Brief.ExternalEffects) != 0 {
		t.Fatalf("an explicit no-effects contract must win over prompt inference: compiled=%+v err=%v", compiled, err)
	}
}

func TestCompileBriefTreatsPromptNoEffectsAsExplicit(t *testing.T) {
	for _, prompt := range []string{
		"Manual approval only; this workflow does not modify external systems.",
		"Aprobación manual; este flujo no modifica sistemas externos.",
	} {
		compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
		if err != nil {
			t.Fatal(err)
		}
		if !compiled.Complete || len(compiled.ClarifyingQuestions) != 0 {
			t.Fatalf("explicit read-only prompt was reclassified as ambiguous: prompt=%q compiled=%+v", prompt, compiled)
		}
		if len(compiled.Brief.ExternalEffects) != 0 {
			t.Fatalf("explicit read-only prompt invented external effects: prompt=%q effects=%v", prompt, compiled.Brief.ExternalEffects)
		}
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
		{"Use the CRM MCP tool to update a contact", "manual", "mcp_write"},
		{"Generate a PDF invoice", "manual", "pdf_generation"},
		{"Store this finding in vector memory", "manual", "vector_memory_write"},
		{"Append the result rows to a sheet", "manual", "sheet_append"},
		{"Create a workflow that uses MCP to inspect customer data", "manual", ""},
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

func TestCompileBriefPreservesPagerDutyTriggerAndEffects(t *testing.T) {
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: "Cuando PagerDuty alerta al usuario PUSER1 fuera del horario laboral, muévelo a revisando y aplázalo por 12 horas. Usa la credencial API pagerduty-api y la credencial webhook pagerduty-webhook."})
	if err != nil {
		t.Fatal(err)
	}
	if compiled.Brief.Trigger != "pagerduty" {
		t.Fatalf("trigger=%q", compiled.Brief.Trigger)
	}
	for _, effect := range []string{"pagerduty_acknowledge", "pagerduty_snooze"} {
		if !containsAnyFold(strings.Join(compiled.Brief.ExternalEffects, ","), effect) {
			t.Fatalf("effects=%v missing %q", compiled.Brief.ExternalEffects, effect)
		}
	}
	if containsAnyFold(strings.Join(compiled.Brief.ExternalEffects, ","), "outbound_webhook") {
		t.Fatalf("a webhook credential is a binding, not an outbound effect: %v", compiled.Brief.ExternalEffects)
	}
}

func TestCompileBriefBlocksVaguePagerDutyWindowUntilClarified(t *testing.T) {
	prompt := "Yo, como usuario, tengo disponibilidad laboral 24x7 por una semana y uso PagerDuty; en las disponibilidades que salten en ciertos rangos de horas, automáticamente se mueve a revisando con tiempo de 12 horas."
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
	if err != nil {
		t.Fatal(err)
	}
	if compiled.Complete || compiled.Brief.Trigger != "pagerduty" || len(compiled.ClarifyingQuestions) != 3 {
		t.Fatalf("vague PagerDuty brief must remain bounded and incomplete: %+v", compiled)
	}
	questions := strings.Join(compiled.ClarifyingQuestions, " ")
	for _, expected := range []string{"rango horario exacto", "fechas inclusivas", "zona horaria IANA"} {
		if !strings.Contains(questions, expected) {
			t.Fatalf("questions=%q missing %q", questions, expected)
		}
	}

	// The proposal endpoint recompiles from the structured brief without the
	// original prompt, so the objective/outcome must retain the same guard.
	recompiled, err := CompileBrief(CompileBriefRequest{Brief: compiled.Brief})
	if err != nil {
		t.Fatal(err)
	}
	if recompiled.Complete || len(recompiled.ClarifyingQuestions) != 3 {
		t.Fatalf("structured recompile bypassed clarifications: %+v", recompiled)
	}
}

func TestCompileBriefAcceptsExplicitPagerDutyCampaignDates(t *testing.T) {
	prompt := "En PagerDuty, durante una semana del 2026-09-01 al 2026-09-07, si el usuario PUSER1 recibe un incidente entre 22:00 y 23:00 en America/Bogota, muévelo a revisando y aplázalo por 12 horas usando operator@example.com."
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
	if err != nil {
		t.Fatal(err)
	}
	if !compiled.Complete || len(compiled.ClarifyingQuestions) != 0 {
		t.Fatalf("explicit PagerDuty campaign remained ambiguous: %+v", compiled)
	}
}

func TestCompileBriefAcceptsPagerDutyWeekExplicitlyAnchoredAtNow(t *testing.T) {
	for _, prompt := range []string{
		"Starting now for one week, when PagerDuty assigns an incident to user PUSER1 outside 09:00–17:00 America/Bogota, acknowledge it and snooze it for 12 hours as operator@example.com.",
		"Desde ahora y durante una semana, cuando PagerDuty asigne un incidente al usuario PUSER1 fuera de 09:00–17:00 en America/Bogota, muévelo a revisando y aplázalo por 12 horas como operator@example.com.",
	} {
		compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
		if err != nil || !compiled.Complete || len(compiled.ClarifyingQuestions) != 0 {
			t.Fatalf("anchored relative week remained ambiguous: compiled=%+v err=%v", compiled, err)
		}
	}
}

func TestCompileBriefAcceptsOneDayPagerDutyCampaign(t *testing.T) {
	prompt := "From 2026-09-01 to 2026-09-01, when PagerDuty alerts user PUSER1 between 22:00 and 23:00 in America/Bogota, acknowledge it and snooze it for 12 hours using operator@example.com."
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
	if err != nil {
		t.Fatal(err)
	}
	if !compiled.Complete || len(compiled.ClarifyingQuestions) != 0 {
		t.Fatalf("one-day PagerDuty campaign remained ambiguous: %+v", compiled)
	}
}

func TestCompileBriefAcceptsThirtyOneCalendarDaysAcrossDST(t *testing.T) {
	prompt := "From 2026-10-15 to 2026-11-14, when PagerDuty alerts user PUSER1 between 22:00 and 23:00 in America/New_York, acknowledge it and snooze it for 12 hours using operator@example.com."
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
	if err != nil {
		t.Fatal(err)
	}
	if !compiled.Complete || len(compiled.ClarifyingQuestions) != 0 {
		t.Fatalf("31-day DST-spanning campaign remained ambiguous: %+v", compiled)
	}
}

func TestCompileBriefRequestsPagerDutyActorConfigurationBeforeCompletion(t *testing.T) {
	prompt := "From 2026-09-01 to 2026-09-07, when PagerDuty alerts between 22:00 and 23:00 in America/Bogota, acknowledge it and snooze it for 12 hours."
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
	if err != nil {
		t.Fatal(err)
	}
	questions := strings.Join(compiled.ClarifyingQuestions, " ")
	if compiled.Complete || len(compiled.ClarifyingQuestions) != 2 ||
		!strings.Contains(questions, "requester email") || !strings.Contains(questions, "PagerDuty user ID") {
		t.Fatalf("missing actor configuration was not surfaced: %+v", compiled)
	}

	complete, err := CompileBrief(CompileBriefRequest{Prompt: prompt + " Requester operator@example.com, PagerDuty user ID PUSER1."})
	if err != nil || !complete.Complete || len(complete.ClarifyingQuestions) != 0 {
		t.Fatalf("exact actor configuration did not complete the brief: compiled=%+v err=%v", complete, err)
	}
}

func TestCompileBriefRejectsAmbiguousPagerDutyActorIdentities(t *testing.T) {
	prompt := "From 2026-09-01 to 2026-09-07, when PagerDuty alerts user PUSER1 or user PUSER2 between 22:00 and 23:00 in America/Bogota, acknowledge it and snooze it for 12 hours as first@example.com or second@example.com."
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
	if err != nil {
		t.Fatal(err)
	}
	questions := strings.Join(compiled.ClarifyingQuestions, " ")
	if compiled.Complete || len(compiled.ClarifyingQuestions) != 2 ||
		!strings.Contains(questions, "single authorized requester email") ||
		!strings.Contains(questions, "single exact PagerDuty user ID") {
		t.Fatalf("ambiguous actor configuration must remain unresolved: %+v", compiled)
	}
}

func TestCompileBriefRequiresFinitePagerDutyActivation(t *testing.T) {
	prompt := "When PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours as operator@example.com."
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
	if err != nil {
		t.Fatal(err)
	}
	questions := strings.Join(compiled.ClarifyingQuestions, " ")
	if compiled.Complete || !strings.Contains(questions, "finite activation period") {
		t.Fatalf("unbounded PagerDuty authority must require clarification: %+v", compiled)
	}
}

func TestCompileBriefRejectsUndeclaredPagerDutyEffects(t *testing.T) {
	intent := "Starting now for one week, when PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours as operator@example.com."
	compiled, err := CompileBrief(CompileBriefRequest{Brief: IntentBrief{
		Objective: intent, Trigger: "pagerduty", ExpectedOutcome: intent,
		ExternalEffects: []string{}, Language: "en",
	}})
	if err != nil {
		t.Fatal(err)
	}
	questions := strings.Join(compiled.ClarifyingQuestions, " ")
	if compiled.Complete || !strings.Contains(questions, "Declare both external effects") {
		t.Fatalf("undeclared PagerDuty writes must require clarification: %+v", compiled)
	}
}

func TestCompileBriefRejectsInvalidPagerDutySafetyBounds(t *testing.T) {
	for name, prompt := range map[string]string{
		"clock":    "When PagerDuty alerts user PUSER1 outside working hours 25:00 to 26:00 in UTC, acknowledge and snooze for 12 hours.",
		"timezone": "When PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in America/Not_A_Zone, acknowledge and snooze for 12 hours.",
		"duration": "When PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in UTC, acknowledge and snooze for 999 hours.",
		"campaign": "During one week from 2026-09-01 to 2026-12-31, when PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in UTC, acknowledge and snooze for 12 hours.",
	} {
		compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
		if err != nil {
			t.Fatal(err)
		}
		if compiled.Complete || len(compiled.ClarifyingQuestions) == 0 {
			t.Fatalf("invalid PagerDuty %s bound became applicable: %+v", name, compiled)
		}
	}
}

func TestCompileBriefDoesNotTurnPagerDutyReportScheduleIntoEventTrigger(t *testing.T) {
	for _, prompt := range []string{
		"Schedule a weekly PagerDuty incident report every Monday",
		"Schedule a weekly PagerDuty alerts report every Monday",
	} {
		compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
		if err != nil {
			t.Fatal(err)
		}
		if compiled.Brief.Trigger != "schedule" {
			t.Fatalf("prompt=%q trigger=%q want schedule", prompt, compiled.Brief.Trigger)
		}
	}
}

func TestPagerDutyProposalGenerationPreservesLongSourceConfiguration(t *testing.T) {
	prompt := strings.Repeat("Operational context without executable authority. ", 30) +
		"Starting now for one week, when PagerDuty assigns an incident to user PUSER1 outside 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours as operator@example.com."
	if len([]rune(prompt)) <= maxBriefFieldChars || len([]rune(prompt)) > MaxBriefPromptChars {
		t.Fatalf("test prompt must cross the brief-field bound only: %d", len([]rune(prompt)))
	}
	compiled, err := CompileBrief(CompileBriefRequest{Prompt: prompt})
	if err != nil || !compiled.Complete {
		t.Fatalf("complete long PagerDuty intent rejected: %+v %v", compiled, err)
	}
	generationPrompt := ProposalGenerationPrompt(compiled, prompt)
	if generationPrompt != prompt {
		t.Fatal("recognized PagerDuty source must survive the bounded brief projection")
	}
	document, recognized, err := CompilePagerDutyWorkflow(generationPrompt, DeterministicWorkflowOptions{
		NewID: func() string { return "12345678-1234-1234-1234-123456789abc" },
		Now:   func() time.Time { return time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC) },
		Brief: &compiled.Brief,
	})
	if err != nil || !recognized || document == nil {
		t.Fatalf("long source lost deterministic recipe configuration: recognized=%v err=%v", recognized, err)
	}
	inputs, _ := document["inputs"].(map[string]any)
	properties, _ := inputs["properties"].(map[string]any)
	for field, expected := range map[string]any{
		"timeZone": "America/Bogota", "windowStart": "09:00", "windowEnd": "17:00", "snoozeSeconds": 43_200,
	} {
		property, _ := properties[field].(map[string]any)
		if property["default"] != expected {
			t.Fatalf("%s default=%v want=%v", field, property["default"], expected)
		}
	}
}

func TestPagerDutyProposalGenerationMergesStructuredBriefConstraints(t *testing.T) {
	prompt := "Starting now for one week, when PagerDuty assigns an incident to user PUSER1 outside 09:00 to 17:00, acknowledge it and snooze it for 12 hours."
	request := CompileBriefRequest{
		Prompt: prompt,
		Brief: IntentBrief{
			ExpectedOutcome: "Use America/Bogota and requester operator@example.com.",
			Approvals:       []string{"human_approval_before_external_effect"},
		},
	}
	compiled, err := CompileBrief(request)
	if err != nil || !compiled.Complete {
		t.Fatalf("structured PagerDuty intent should be complete: %+v err=%v", compiled, err)
	}
	generationPrompt := ProposalGenerationPrompt(compiled, prompt)
	if generationPrompt != prompt {
		t.Fatal("qualified source wording should remain provider-prompt bounded")
	}
	document, recognized, err := CompilePagerDutyWorkflow(generationPrompt, DeterministicWorkflowOptions{
		NewID: func() string { return "abcdef12-1234-1234-1234-123456789abc" },
		Now:   func() time.Time { return time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC) },
		Brief: &compiled.Brief,
	})
	if err != nil || !recognized || document == nil {
		t.Fatalf("structured constraints lost at deterministic boundary: recognized=%v err=%v", recognized, err)
	}
	inputs, _ := document["inputs"].(map[string]any)
	properties, _ := inputs["properties"].(map[string]any)
	timeZone, _ := properties["timeZone"].(map[string]any)
	if timeZone["default"] != "America/Bogota" {
		t.Fatalf("structured timezone lost: %+v", timeZone)
	}
	raw, marshalErr := json.Marshal(document)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	workflow, issues := domain.Parse(raw)
	if workflow == nil || len(issues) > 0 {
		t.Fatalf("structured recipe did not parse: workflow=%+v issues=%+v", workflow, issues)
	}
	_ = workflowNode(t, workflow, "approve_action")
	load := workflowNode(t, workflow, "load_incident")
	input, _ := load.Config["input"].(map[string]any)
	if input["requesterEmail"] != "operator@example.com" {
		t.Fatalf("structured requester email lost: %+v", input)
	}
}
