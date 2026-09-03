package authoring

import (
	"encoding/json"
	"regexp"
	"slices"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
)

func TestIsPagerDutyWorkflowPromptRequiresProviderActionAndWindow(t *testing.T) {
	t.Parallel()
	tests := []struct {
		prompt string
		want   bool
	}{
		{"When PagerDuty alerts me after hours, acknowledge and snooze it for 12 hours", true},
		{"When PagerDuty alerts outside 09:00–17:00, acknowledge and snooze for 12 hours", true},
		{"Si PagerDuty alerta entre 22:00 y 23:00, muévelo a revisando y aplázalo por 12 horas", true},
		{"Si PagerDuty alerta fuera de 09:00—17:00, muévelo a revisando y aplázalo por 12 horas", true},
		{"Durante una semana, PagerDuty mueve casos a revisando en ciertos rangos y los aplaza por 12 horas", true},
		{"Acknowledge and snooze this PagerDuty incident", false},
		{"When PagerDuty alerts after hours, acknowledge it", false},
		{"When PagerDuty alerts after hours, snooze it for 12 hours", false},
		{"Summarize a PagerDuty incident after hours", false},
		{"When my pager alerts after hours, acknowledge and snooze it for 12 hours", false},
		{"Summarize an incident and post it to Slack", false},
	}
	for _, testCase := range tests {
		if got := IsPagerDutyWorkflowPrompt(testCase.prompt); got != testCase.want {
			t.Fatalf("IsPagerDutyWorkflowPrompt(%q)=%v want %v", testCase.prompt, got, testCase.want)
		}
	}
}

func TestCompilePagerDutyWorkflowBuildsCanonicalBoundedGraph(t *testing.T) {
	t.Parallel()
	prompt := "When PagerDuty alerts user PLOCALUSER outside working hours 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours. Use API credential pagerduty-api and webhook credential pagerduty-webhook for operator@example.com."
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "abcdef12-3456-4789-abcd-ef1234567890" },
		Now:   func() time.Time { return time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil || !recognized || document == nil {
		t.Fatalf("compile: recognized=%v err=%v document=%+v", recognized, err, document)
	}
	if document["id"] != "pagerduty_off_hours_abcdef1234564789abcdef1234567890" || document["templatePolicy"] != "strict" {
		t.Fatalf("identity/policy: %+v", document)
	}
	workflow := parsedPagerDutyWorkflow(t, document)
	if workflow.Name != "PagerDuty governed on-call handling" || workflowNode(t, workflow, "action_clock").Label != "Capture action time" {
		t.Fatalf("English operator copy drifted: name=%q clock=%q", workflow.Name, workflowNode(t, workflow, "action_clock").Label)
	}
	if len(workflow.Nodes) != 11 || len(workflow.Edges) != 11 {
		t.Fatalf("graph=%d nodes/%d edges want 11/11", len(workflow.Nodes), len(workflow.Edges))
	}
	if issues := domain.Validate(workflow, nil).Issues; len(issues) != 0 {
		t.Fatalf("canonical graph must validate: %+v", issues)
	}
	trigger := workflowNode(t, workflow, "on_pagerduty")
	if trigger.Config["webhookCredential"] != "pagerduty-webhook" {
		t.Fatalf("trigger=%+v", trigger.Config)
	}
	policy := workflowNodeInput(t, workflowNode(t, workflow, "evaluate_policy"))
	if policy["pagerDutyUserId"] != "PLOCALUSER" || policy["snoozeSeconds"] != "{{context.input.snoozeSeconds}}" ||
		policy["timeZone"] != "{{context.input.timeZone}}" || policy["windowMode"] != "{{context.input.windowMode}}" ||
		policy["evaluatedAt"] != "{{context.action_clock.output.result.at}}" {
		t.Fatalf("policy=%+v", policy)
	}
	actionClock := workflowNode(t, workflow, "action_clock")
	if actionClock.Type != "tool" || actionClock.Config["tool"] != "time.now" {
		t.Fatalf("action clock=%+v", actionClock)
	}
	if !workflowHasEdge(workflow, "load_incident", "action_clock", "") ||
		!workflowHasEdge(workflow, "action_clock", "evaluate_policy", "") {
		t.Fatalf("policy must consume a clock captured after the authoritative read: %+v", workflow.Edges)
	}
	inputs, ok := domain.ParseInputSchemaValue(document["inputs"])
	if !ok {
		t.Fatalf("inputs are not a valid schema: %+v", document["inputs"])
	}
	if inputs.Properties["timeZone"].DefaultValue() != "America/Bogota" ||
		inputs.Properties["windowMode"].DefaultValue() != "outside" ||
		inputs.Properties["snoozeSeconds"].DefaultValue() != float64(43_200) {
		t.Fatalf("input defaults: %+v", inputs.Properties)
	}
	snooze := workflowNodeInput(t, workflowNode(t, workflow, "snooze_incident"))
	if snooze["credential"] != "pagerduty-api" || snooze["requesterEmail"] != "operator@example.com" ||
		snooze["durationSeconds"] != "{{context.input.snoozeSeconds}}" {
		t.Fatalf("snooze=%+v", snooze)
	}
	if !regexp.MustCompile(`^pagerduty_off_hours_[a-f0-9]{32}$`).MatchString(workflow.ID) {
		t.Fatalf("workflow id=%q", workflow.ID)
	}
	if workflow.Recovery == nil || workflow.Recovery.Contract == nil || workflow.Recovery.Contract.Version != "2" ||
		len(workflow.Recovery.Contract.Failure.Semantic.Detectors) != 1 {
		t.Fatalf("workflow assurance contract=%+v", workflow.Recovery)
	}
	verification := workflowNode(t, workflow, "verify_outcome")
	verificationInput := workflowNodeInput(t, verification)
	if verification.Type != "tool" || verification.Config["tool"] != "pagerduty.outcome.verify" ||
		verificationInput["expectedIncidentId"] != "{{context.snooze_incident.output.result.incident.id}}" ||
		verificationInput["expectedSnoozeUntil"] != "{{context.snooze_incident.output.result.snoozeUntil}}" {
		t.Fatalf("verification node=%+v", verification)
	}
	actionEvidence := workflowNode(t, workflow, "action_evidence").Config["mapping"].(map[string]any)
	if actionEvidence["evaluatedAt"] != "{{context.action_clock.output.result.at}}" ||
		actionEvidence["approvalRequired"] != false || actionEvidence["approvalRevalidated"] != false {
		t.Fatalf("automatic evidence must identify its effective clock and approval posture: %+v", actionEvidence)
	}
	if workflow.Outputs["result"] != "{{context.outcome_projection.output}}" ||
		!workflowHasEdge(workflow, "action_evidence", "outcome_projection", "") ||
		!workflowHasEdge(workflow, "ignored_evidence", "outcome_projection", "") {
		t.Fatalf("mutually exclusive terminals need one stable intent projection: outputs=%+v edges=%+v", workflow.Outputs, workflow.Edges)
	}
	assertPagerDutyActionBranchIsTransitivelyGuarded(t, workflow)
}

func TestPagerDutyExternalIdentifiersRequireExplicitIDs(t *testing.T) {
	t.Parallel()
	implicit := extractPagerDutyFlowSettings(
		"When PagerDuty assigns an incident to user Alice for service checkout, acknowledge and snooze for 12 hours.",
		time.Now(), nil,
	)
	if implicit.pagerDutyUserID != "" || len(implicit.serviceIDs) != 0 {
		t.Fatalf("human-readable names must not be promoted into provider IDs: %+v", implicit)
	}

	explicit := extractPagerDutyFlowSettings(
		"PagerDuty user ID PUSER1 and service ID PSVC1", time.Now(), nil,
	)
	if explicit.pagerDutyUserID != "PUSER1" || !slices.Equal(explicit.serviceIDs, []string{"PSVC1"}) {
		t.Fatalf("explicit provider IDs were not preserved: %+v", explicit)
	}

	ambiguous := extractPagerDutyFlowSettings(
		"PagerDuty user PUSER1 or user puser2, service ID PSVC1 or service ID PSVC2, requester First@Example.com or second@example.com, in UTC or America/Bogota",
		time.Now(), nil,
	)
	if ambiguous.pagerDutyUserID != "" || len(ambiguous.serviceIDs) != 0 ||
		ambiguous.requesterEmail != "" || ambiguous.timeZone != "" {
		t.Fatalf("conflicting authority identities must remain unresolved: %+v", ambiguous)
	}
}

func TestPagerDutyExplicitCredentialAmbiguityNeverFallsBackToCatalog(t *testing.T) {
	t.Parallel()
	catalog := &Catalog{Credentials: []CredentialCapability{
		{Name: "only-api", Kind: "pagerduty_api_token", Configured: true},
		{Name: "only-hook", Kind: "pagerduty_webhook_secret", Configured: true},
	}}
	settings := extractPagerDutyFlowSettings(
		"API credential first-api and API credential second-api; webhook credential first-hook and webhook credential second-hook",
		time.Now(), catalog,
	)
	if settings.apiCredential != "" || settings.webhookCredential != "" {
		t.Fatalf("explicit ambiguity must not be replaced by a catalog default: %+v", settings)
	}
}

func TestPagerDutyTemporalAuthorityFailsClosedWhenAmbiguous(t *testing.T) {
	t.Parallel()
	prompt := "From 2026-09-01 to 2026-09-07 or from 2026-09-08 to 2026-09-14, PagerDuty may act outside 09:00 to 17:00 or outside 22:00 to 23:00 and snooze for 12 hours or snooze for 24 hours."
	settings := extractPagerDutyFlowSettings(prompt, time.Now(), nil)
	if settings.workingStart != "" || settings.workingEnd != "" || settings.snoozeSeconds != 0 ||
		settings.activeFrom != "ambiguous" || settings.activeUntil != "ambiguous" {
		t.Fatalf("conflicting temporal authority must remain fail-closed: %+v", settings)
	}
	if validPagerDutyWorkingHours(prompt) || validPagerDutyDateRange(prompt) || validPagerDutyDuration(prompt) {
		t.Fatalf("conflicting temporal authority passed brief validation: %q", prompt)
	}
}

func TestCompilePagerDutyWorkflowSupportsFiniteWeekAndInsideWindow(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 1, 15, 4, 5, 999, time.UTC)
	prompt := "En PagerDuty, durante una semana 24x7, cuando el usuario PLOCALUSER tenga incidentes entre 22:00 y 23:30 en America/Bogota, automáticamente muévelos a revisando y aplázalos por 12 horas. API credential pd-api, webhook credential pd-hook, requester operator@example.com."
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "12345678-0000-4000-8000-000000000000" }, Now: func() time.Time { return now },
	})
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	workflow := parsedPagerDutyWorkflow(t, document)
	if workflow.Name != "Gestión gobernada de guardia en PagerDuty" ||
		workflowNode(t, workflow, "action_clock").Label != "Capturar hora de acción" ||
		workflowNode(t, workflow, "acknowledge_incident").Label != "Reconocer incidente" {
		t.Fatalf("Spanish operator copy was not localized: name=%q clock=%q acknowledge=%q",
			workflow.Name, workflowNode(t, workflow, "action_clock").Label,
			workflowNode(t, workflow, "acknowledge_incident").Label)
	}
	policy := workflowNodeInput(t, workflowNode(t, workflow, "evaluate_policy"))
	windows := policy["workingHours"].([]any)
	days := windows[0].(map[string]any)["days"].([]any)
	if !slices.Equal(days, []any{float64(0), float64(1), float64(2), float64(3), float64(4), float64(5), float64(6)}) {
		t.Fatalf("working days=%+v", days)
	}
	inputs, _ := domain.ParseInputSchemaValue(document["inputs"])
	if inputs.Properties["windowMode"].DefaultValue() != "inside" ||
		inputs.Properties["windowStart"].DefaultValue() != "22:00" ||
		inputs.Properties["windowEnd"].DefaultValue() != "23:30" ||
		inputs.Properties["activeFrom"].DefaultValue() != "2026-09-01T10:04:05-05:00" ||
		inputs.Properties["activeUntil"].DefaultValue() != "2026-09-08T10:04:05-05:00" {
		t.Fatalf("finite-window defaults: %+v", inputs.Properties)
	}
	if inputs.Properties["timeZone"].Description != "Zona horaria IANA usada para la ventana de guardia." ||
		inputs.Properties["activeUntil"].Description != "Fin RFC3339 exclusivo de la campaña de automatización finita." {
		t.Fatalf("Spanish input guidance was not localized: %+v", inputs.Properties)
	}
	detector := workflow.Recovery.Contract.Failure.Semantic.Detectors[0]
	if detector.Message != "PagerDuty aceptó la acción, pero el incidente autoritativo no confirmó exactamente el resultado reconocido y aplazado." {
		t.Fatalf("Spanish recovery copy was not localized: %q", detector.Message)
	}
	if policy["activeFrom"] != "{{context.input.activeFrom}}" || policy["activeUntil"] != "{{context.input.activeUntil}}" {
		t.Fatalf("active policy bindings=%+v", policy)
	}
}

func TestCompilePagerDutyWorkflowRecognizesFlagshipUserLanguage(t *testing.T) {
	t.Parallel()
	prompt := "Yo, como usuario, tengo disponibilidad laboral 24x7 por una semana y uso PagerDuty como herramienta para resolver casos; en las disponibilidades que salten en ciertos rangos de horas, automáticamente se mueve a revisando con tiempo de 12 horas."
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "a1b2c3d4-0000-4000-8000-000000000000" },
		Now:   func() time.Time { return time.Date(2026, 9, 1, 15, 4, 5, 0, time.UTC) },
	})
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	workflow := parsedPagerDutyWorkflow(t, document)
	policy := workflowNodeInput(t, workflowNode(t, workflow, "evaluate_policy"))
	windows := policy["workingHours"].([]any)
	days := windows[0].(map[string]any)["days"].([]any)
	if len(days) != 7 {
		t.Fatalf("24x7 days=%+v", days)
	}
	inputs, _ := domain.ParseInputSchemaValue(document["inputs"])
	if inputs.Properties["windowMode"].DefaultValue() != "inside" ||
		inputs.Properties["snoozeSeconds"].DefaultValue() != float64(43_200) ||
		inputs.Properties["activeUntil"].DefaultValue() != "2026-09-08T15:04:05Z" {
		t.Fatalf("flagship defaults=%+v", inputs.Properties)
	}
}

func TestCompilePagerDutyWorkflowUsesInclusiveLocalCampaignDates(t *testing.T) {
	t.Parallel()
	prompt := "En PagerDuty, durante una semana del 2026-09-01 al 2026-09-07, si el usuario PUSER1 recibe un incidente entre 22:00 y 23:00 en America/Bogota, muévelo a revisando y aplázalo por 12 horas."
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "cafebabe-0000-4000-8000-000000000000" },
	})
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	inputs, _ := domain.ParseInputSchemaValue(document["inputs"])
	if inputs.Properties["activeFrom"].DefaultValue() != "2026-09-01T00:00:00-05:00" ||
		inputs.Properties["activeUntil"].DefaultValue() != "2026-09-08T00:00:00-05:00" {
		t.Fatalf("inclusive local dates=%+v", inputs.Properties)
	}
}

func TestCompilePagerDutyWorkflowAcceptsOneDayCampaign(t *testing.T) {
	t.Parallel()
	prompt := "From 2026-09-01 to 2026-09-01, when PagerDuty alerts user PUSER1 between 22:00 and 23:00 in America/Bogota, acknowledge it and snooze it for 12 hours."
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "0ddba11a-0000-4000-8000-000000000000" },
	})
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	inputs, _ := domain.ParseInputSchemaValue(document["inputs"])
	if inputs.Properties["activeFrom"].DefaultValue() != "2026-09-01T00:00:00-05:00" ||
		inputs.Properties["activeUntil"].DefaultValue() != "2026-09-02T00:00:00-05:00" {
		t.Fatalf("one-day inclusive campaign=%+v", inputs.Properties)
	}
}

func TestCompilePagerDutyWorkflowKeepsThirtyOneCalendarDaysAcrossDST(t *testing.T) {
	t.Parallel()
	prompt := "From 2026-10-15 to 2026-11-14, when PagerDuty alerts user PUSER1 between 22:00 and 23:00 in America/New_York, acknowledge it and snooze it for 12 hours."
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "d57c0ffe-0000-4000-8000-000000000000" },
	})
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	inputs, _ := domain.ParseInputSchemaValue(document["inputs"])
	if inputs.Properties["activeFrom"].DefaultValue() != "2026-10-15T00:00:00-04:00" ||
		inputs.Properties["activeUntil"].DefaultValue() != "2026-11-15T00:00:00-05:00" {
		t.Fatalf("DST-spanning campaign=%+v", inputs.Properties)
	}
}

func TestCompilePagerDutyWorkflowTreatsWeekAsLocalCalendarAcrossDST(t *testing.T) {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 30, 9, 30, 0, 0, location)
	prompt := "For one week, when PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in America/New_York, acknowledge and snooze for 12 hours using operator@example.com."
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "abcdef98-0000-4000-8000-000000000000" },
		Now:   func() time.Time { return now },
	})
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	inputs, _ := domain.ParseInputSchemaValue(document["inputs"])
	fromRaw, _ := inputs.Properties["activeFrom"].DefaultValue().(string)
	untilRaw, _ := inputs.Properties["activeUntil"].DefaultValue().(string)
	from, fromErr := time.Parse(time.RFC3339, fromRaw)
	until, untilErr := time.Parse(time.RFC3339, untilRaw)
	if fromErr != nil || untilErr != nil || until.Sub(from) != 7*24*time.Hour+time.Hour ||
		from.In(location).Hour() != until.In(location).Hour() {
		t.Fatalf("local calendar week drifted: from=%q until=%q duration=%v", fromRaw, untilRaw, until.Sub(from))
	}
}

func TestCompilePagerDutyWorkflowDoesNotInferAPIRegionFromTimezone(t *testing.T) {
	t.Parallel()
	compileRegion := func(prompt, id string) any {
		document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
			NewID: func() string { return id },
		})
		if err != nil || !recognized {
			t.Fatalf("compile: recognized=%v err=%v", recognized, err)
		}
		workflow := parsedPagerDutyWorkflow(t, document)
		return workflowNodeInput(t, workflowNode(t, workflow, "load_incident"))["region"]
	}
	base := "When PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in Europe/Madrid, acknowledge it and snooze it for 12 hours."
	if region := compileRegion(base, "00112233-4455-4677-8899-aabbccddeeff"); region != "us" {
		t.Fatalf("European timezone changed PagerDuty account region: %v", region)
	}
	if region := compileRegion(base+" PagerDuty region: EU.", "ffeeddcc-bbaa-4988-8766-554433221100"); region != "eu" {
		t.Fatalf("explicit PagerDuty EU region was not preserved: %v", region)
	}
}

func TestCompilePagerDutyWorkflowKeepsInvalidExplicitBoundsFailClosed(t *testing.T) {
	t.Parallel()
	prompt := "During one week from 2026-09-01 to 2026-12-31, when PagerDuty alerts user PUSER1 outside working hours 25:00 to 26:00 in America/Not_A_Zone, acknowledge and snooze for 999 hours."
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "deadbeef-0000-4000-8000-000000000000" },
	})
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	inputs, _ := domain.ParseInputSchemaValue(document["inputs"])
	if inputs.Properties["timeZone"].DefaultValue() != "" ||
		inputs.Properties["windowStart"].DefaultValue() != "" ||
		inputs.Properties["windowEnd"].DefaultValue() != "" ||
		inputs.Properties["activeFrom"].DefaultValue() != "2026-09-01" ||
		inputs.Properties["activeUntil"].DefaultValue() != "2026-12-31" ||
		inputs.Properties["snoozeSeconds"].DefaultValue() != float64(999*60*60) {
		t.Fatalf("invalid explicit bounds were replaced with permissive defaults: %+v", inputs.Properties)
	}
}

func TestCompilePagerDutyWorkflowLeavesMissingTenantIdentitiesExplicit(t *testing.T) {
	t.Parallel()
	document, recognized, err := CompilePagerDutyWorkflow(
		"PagerDuty after-hours: acknowledge and snooze for 12 hours.",
		DeterministicWorkflowOptions{NewID: func() string { return "87654321-0000-4000-8000-000000000000" }},
	)
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	workflow := parsedPagerDutyWorkflow(t, document)
	report := BindWorkflow(NewBuilder(nil, nil).Build(t.Context(), ""), workflow)
	if report.Complete {
		t.Fatalf("missing tenant identities must block Apply: %+v", report)
	}
	for _, forbidden := range []string{"PAGERDUTY_USER_ID", "operator@example.com", "pagerduty-api", "pagerduty-webhook"} {
		raw, _ := json.Marshal(document)
		if regexp.MustCompile(regexp.QuoteMeta(forbidden)).Match(raw) {
			t.Fatalf("compiler invented %q in %s", forbidden, raw)
		}
	}
}

func TestCompilePagerDutyWorkflowAutoBindsOnlyUniqueExactCredentials(t *testing.T) {
	prompt := "When PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in UTC, acknowledge and snooze for 12 hours using operator@example.com."
	catalog := bindingTestCatalog()
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "11223344-0000-4000-8000-000000000000" }, Catalog: &catalog,
	})
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	workflow := parsedPagerDutyWorkflow(t, document)
	if got := workflowNode(t, workflow, "on_pagerduty").Config["webhookCredential"]; got != "pagerduty-webhook" {
		t.Fatalf("unique webhook credential not bound: %v", got)
	}
	if got := workflowNodeInput(t, workflowNode(t, workflow, "load_incident"))["credential"]; got != "pagerduty-api" {
		t.Fatalf("unique API credential not bound: %v", got)
	}
	if report := BindWorkflow(catalog, workflow); !report.Complete {
		t.Fatalf("unique exact catalog binding remained incomplete: %+v", report)
	}

	catalog.Credentials = append(catalog.Credentials, CredentialCapability{
		ID: "cred-pd-api-2", Name: "pagerduty-api-secondary", Kind: "pagerduty_api_token", Configured: true,
	})
	document, recognized, err = CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "55667788-0000-4000-8000-000000000000" }, Catalog: &catalog,
	})
	if err != nil || !recognized {
		t.Fatalf("compile ambiguous catalog: recognized=%v err=%v", recognized, err)
	}
	workflow = parsedPagerDutyWorkflow(t, document)
	if got := workflowNodeInput(t, workflowNode(t, workflow, "load_incident"))["credential"]; got != "" {
		t.Fatalf("ambiguous API credentials must remain an explicit choice, got %v", got)
	}
}

func TestCompilePagerDutyWorkflowNeverReplacesExplicitUnknownCredential(t *testing.T) {
	prompt := "When PagerDuty alerts user PUSER1 outside working hours 09:00 to 17:00 in UTC, acknowledge and snooze for 12 hours using operator@example.com, API credential operator-explicit and webhook credential operator-hook."
	catalog := bindingTestCatalog()
	document, recognized, err := CompilePagerDutyWorkflow(prompt, DeterministicWorkflowOptions{
		NewID: func() string { return "99887766-0000-4000-8000-000000000000" }, Catalog: &catalog,
	})
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	workflow := parsedPagerDutyWorkflow(t, document)
	if got := workflowNodeInput(t, workflowNode(t, workflow, "load_incident"))["credential"]; got != "operator-explicit" {
		t.Fatalf("explicit API credential was rewritten: %v", got)
	}
	if got := workflowNode(t, workflow, "on_pagerduty").Config["webhookCredential"]; got != "operator-hook" {
		t.Fatalf("explicit webhook credential was rewritten: %v", got)
	}
}

func TestCompilePagerDutyWorkflowAddsApprovalOnlyWhenRequested(t *testing.T) {
	t.Parallel()
	document, recognized, err := CompilePagerDutyWorkflow(
		"When PagerDuty alerts outside working hours, require human approval before acknowledge and snooze for 12 hours. API credential pd-api, webhook credential pd-hook, requester operator@example.com, user PUSER1.",
		DeterministicWorkflowOptions{NewID: func() string { return "fedcba98-0000-4000-8000-000000000000" }},
	)
	if err != nil || !recognized {
		t.Fatalf("compile: recognized=%v err=%v", recognized, err)
	}
	workflow := parsedPagerDutyWorkflow(t, document)
	approval := workflowNode(t, workflow, "approve_action")
	if approval.Type != "approval" || len(workflow.Nodes) != 16 || len(workflow.Edges) != 17 {
		t.Fatalf("approval graph: %+v", workflow.Nodes)
	}
	if approval.Config["decisionTimeoutMs"] != float64(pagerDutyApprovalTimeoutMs) || approval.Config["onTimeout"] != "auto_reject" {
		t.Fatalf("approval deadline must fail closed: %+v", approval.Config)
	}
	if issues := domain.Validate(workflow, nil).Issues; len(issues) != 0 {
		t.Fatalf("approval graph must validate: %+v", issues)
	}
	foundRecheck, foundDirectMutation, foundStaleBranch, foundStaleProjection := false, false, false, false
	for _, edge := range workflow.Edges {
		foundRecheck = foundRecheck || edge.From == "approve_action" && edge.To == "recheck_incident"
		foundDirectMutation = foundDirectMutation || edge.From == "approve_action" && edge.To == "acknowledge_incident"
		foundStaleBranch = foundStaleBranch || edge.From == "recheck_policy" && edge.To == "stale_approval_evidence" &&
			edge.Condition == "context.recheck_policy.output.result.shouldAct === false"
		foundStaleProjection = foundStaleProjection || edge.From == "stale_approval_evidence" && edge.To == "outcome_projection"
	}
	if !foundRecheck || foundDirectMutation || !foundStaleBranch || !foundStaleProjection {
		t.Fatalf("approval must revalidate before mutation and retain no-action evidence: %+v", workflow.Edges)
	}
	recheckPolicy := workflowNodeInput(t, workflowNode(t, workflow, "recheck_policy"))
	if recheckPolicy["incident"] != "{{context.recheck_incident.output.result.incident}}" ||
		recheckPolicy["evaluatedAt"] != "{{context.approval_clock.output.result.at}}" {
		t.Fatalf("approval revalidation is not bound to fresh state/time: %+v", recheckPolicy)
	}
	actionEvidence := workflowNode(t, workflow, "action_evidence").Config["mapping"].(map[string]any)
	if actionEvidence["decision"] != "{{context.recheck_policy.output.result.reason}}" ||
		actionEvidence["evaluatedAt"] != "{{context.approval_clock.output.result.at}}" ||
		actionEvidence["approvalRequired"] != true || actionEvidence["approvalRevalidated"] != true {
		t.Fatalf("approval evidence does not identify the effective decision: %+v", actionEvidence)
	}
	if len(workflow.Recovery.Contract.Effects) != 3 || workflow.Recovery.Contract.Effects[0].NodeID != "approve_action" {
		t.Fatalf("approval effect missing from recovery contract: %+v", workflow.Recovery.Contract.Effects)
	}
	assertPagerDutyActionBranchIsTransitivelyGuarded(t, workflow)
}
func parsedPagerDutyWorkflow(t *testing.T, document map[string]any) *domain.Workflow {
	t.Helper()
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	workflow, issues := domain.Parse(raw)
	if workflow == nil || len(issues) > 0 {
		t.Fatalf("parse: workflow=%+v issues=%+v raw=%s", workflow, issues, raw)
	}
	return workflow
}

func workflowNode(t *testing.T, workflow *domain.Workflow, id string) domain.Node {
	t.Helper()
	for _, node := range workflow.Nodes {
		if node.ID == id {
			return node
		}
	}
	t.Fatalf("node %q not found", id)
	return domain.Node{}
}

func workflowNodeInput(t *testing.T, node domain.Node) map[string]any {
	t.Helper()
	input, ok := node.Config["input"].(map[string]any)
	if !ok {
		t.Fatalf("node %s input=%T", node.ID, node.Config["input"])
	}
	return input
}

func workflowHasEdge(workflow *domain.Workflow, from, to, condition string) bool {
	for _, edge := range workflow.Edges {
		if edge.From == from && edge.To == to && edge.Condition == condition {
			return true
		}
	}
	return false
}

func assertPagerDutyActionBranchIsTransitivelyGuarded(t *testing.T, workflow *domain.Workflow) {
	t.Helper()
	condition := "context.evaluate_policy.output.result.shouldAct === true"
	approvalGraph := false
	for _, node := range workflow.Nodes {
		approvalGraph = approvalGraph || node.ID == "approve_action"
	}
	if approvalGraph {
		condition = "context.recheck_policy.output.result.shouldAct === true"
	}
	for _, edge := range workflow.Edges {
		switch edge.To {
		case "acknowledge_incident", "snooze_incident", "verify_incident", "verify_outcome", "action_evidence", "summarize_action":
			if edge.Condition != condition {
				t.Fatalf("write branch edge %s -> %s is not transitively guarded: %+v", edge.From, edge.To, edge)
			}
		}
	}
	if !approvalGraph {
		return
	}
	const initialCondition = "context.evaluate_policy.output.result.shouldAct === true"
	for _, edge := range workflow.Edges {
		switch edge.To {
		case "approve_action", "recheck_incident", "approval_clock", "recheck_policy":
			if edge.Condition != initialCondition {
				t.Fatalf("approval recheck edge %s -> %s lost its initial guard: %+v", edge.From, edge.To, edge)
			}
		}
	}
}
