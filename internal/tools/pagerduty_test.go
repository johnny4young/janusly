package tools

import (
	"context"
	"encoding/json"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// The deterministic policy ladder — exact reason order from the contract —
// plus the fail-closed bias: malformed working-hours policy is invalid runtime
// input, so it can never authorize a mutation. (The independent rejecting bias
// is tested on time.window.)
func TestPagerDutyPolicyEvaluate(t *testing.T) {
	weekdays := []any{1.0, 2.0, 3.0, 4.0, 5.0}
	workingHours := []any{map[string]any{"days": weekdays, "start": "09:00", "end": "17:00"}}
	incident := func(overrides map[string]any) map[string]any {
		// The PROJECTED shape — what pagerduty.incident.get hands downstream.
		base := map[string]any{
			"id": "PINC1", "status": "triggered", "title": "db down", "urgency": "high",
			"serviceId": "PSVC1", "assignedUserIds": []any{"PUSER1"},
		}
		maps.Copy(base, overrides)
		return base
	}
	evaluate := func(overrides map[string]any) map[string]any {
		input := map[string]any{
			"eventType":   "incident.triggered",
			"occurredAt":  "2026-01-10T03:00:00Z", // Saturday 03:00 UTC — off-hours
			"receivedAt":  "2026-01-10T03:00:05Z",
			"evaluatedAt": "2026-01-10T03:00:06Z",
			"incident":    incident(nil), "pagerDutyUserId": "PUSER1",
			"snoozeSeconds": 43_200.0, "timeZone": "UTC", "workingHours": workingHours,
		}
		maps.Copy(input, overrides)
		// Exercise the policy's defensive result contract directly. The registry
		// independently rejects a statically wrong top-level field type before
		// dispatch; the evaluator still has to fail closed if malformed data ever
		// reaches it through an internal call or a dynamic value.
		result, err := executePagerDutyPolicyEvaluate(context.Background(), input)
		if err != nil {
			t.Fatalf("policy.evaluate must never error: %v", err)
		}
		return result
	}

	if result := evaluate(nil); result["shouldAct"] != true || result["reason"] != "matched" {
		t.Fatalf("matched case: %+v", result)
	}
	ladder := map[string]map[string]any{
		"event_not_actionable":          {"eventType": "incident.annotated"},
		"incident_resolved":             {"incident": incident(map[string]any{"status": "resolved"})},
		"incident_already_acknowledged": {"incident": incident(map[string]any{"status": "acknowledged"})},
		"user_not_assigned":             {"pagerDutyUserId": "PUSER9"},
		"service_filtered":              {"serviceIds": []any{"POTHER"}},
		"urgency_filtered":              {"urgencies": []any{"low"}},
		// Wednesday 10:00 UTC is inside Mon-Fri 09:00-17:00.
		"event_in_working_hours": {"occurredAt": "2026-01-07T10:00:00Z"},
		"received_in_working_hours": {
			"receivedAt": "2026-01-12T10:00:00Z", "evaluatedAt": "2026-01-12T10:00:01Z",
		},
		"evaluation_in_working_hours": {
			"evaluatedAt": "2026-01-12T10:00:00Z",
		},
		"invalid_runtime_input": {"incident": map[string]any{"status": "nonsense"}},
	}
	for reason, overrides := range ladder {
		if result := evaluate(overrides); result["shouldAct"] != false || result["reason"] != reason {
			t.Fatalf("%s: %+v", reason, result)
		}
	}

	// Unknown zone / malformed clock / empty days are invalid for both window
	// modes — the off-hours automation never turns parse failure into authority.
	for name, overrides := range map[string]map[string]any{
		"bad zone":      {"timeZone": "Not/AZone"},
		"bad clock":     {"workingHours": []any{map[string]any{"days": weekdays, "start": "9am", "end": "17:00"}}},
		"empty days":    {"workingHours": []any{map[string]any{"days": []any{}, "start": "09:00", "end": "17:00"}}},
		"mixed days":    {"workingHours": []any{map[string]any{"days": []any{1.0, "bad"}, "start": "09:00", "end": "17:00"}}},
		"duplicate day": {"workingHours": []any{map[string]any{"days": []any{1.0, 1.0}, "start": "09:00", "end": "17:00"}}},
		"no windows":    {"workingHours": []any{}},
	} {
		result := evaluate(overrides)
		if result["shouldAct"] != false || result["reason"] != "invalid_runtime_input" {
			t.Fatalf("fail-closed outside policy (%s): %+v", name, result)
		}
	}

	active := map[string]any{
		"activeFrom": "2026-01-10T02:00:00Z", "activeUntil": "2026-01-10T04:00:00Z",
	}
	if result := evaluate(active); result["shouldAct"] != true || result["reason"] != "matched" {
		t.Fatalf("active period match: %+v", result)
	}
	if result := evaluate(map[string]any{
		"activeFrom": "2026-01-10T04:00:00Z", "activeUntil": "2026-01-11T04:00:00Z",
	}); result["shouldAct"] != false || result["reason"] != "outside_active_period" {
		t.Fatalf("inactive period: %+v", result)
	}
	if result := evaluate(map[string]any{
		"activeFrom": "2026-01-10T02:00:00Z", "activeUntil": "2026-01-10T04:00:00Z",
		"evaluatedAt": "2026-01-10T04:00:00Z",
	}); result["shouldAct"] != false || result["reason"] != "outside_active_period" {
		t.Fatalf("action time outside active period: %+v", result)
	}
	for name, overrides := range map[string]map[string]any{
		"partial":               {"activeFrom": "2026-01-10T02:00:00Z"},
		"reversed":              {"activeFrom": "2026-01-11T02:00:00Z", "activeUntil": "2026-01-10T02:00:00Z"},
		"too long":              {"activeFrom": "2026-01-01T00:00:00Z", "activeUntil": "2026-02-02T00:00:00Z"},
		"receipt before event":  {"receivedAt": "2026-01-10T02:59:59Z"},
		"action before receipt": {"evaluatedAt": "2026-01-10T03:00:04Z"},
		"missing action time":   {"evaluatedAt": nil},
		"empty action time":     {"evaluatedAt": ""},
		"wrong action type":     {"evaluatedAt": 123.0},
		"wrong window mode":     {"windowMode": true},
		"empty window mode":     {"windowMode": ""},
		"wrong active types":    {"activeFrom": 123.0, "activeUntil": 456.0},
		"malformed services":    {"serviceIds": []any{123.0}},
		"malformed urgency":     {"urgencies": []any{"urgent"}},
		"malformed event types": {"actionableEventTypes": "incident.triggered"},
		"unknown event type":    {"actionableEventTypes": []any{"incident.attacker_defined"}},
		"short snooze":          {"snoozeSeconds": 59.0},
		"long snooze":           {"snoozeSeconds": 604_801.0},
		"fractional snooze":     {"snoozeSeconds": 3_600.5},
		"wrong snooze type":     {"snoozeSeconds": "43200"},
	} {
		if result := evaluate(overrides); result["shouldAct"] != false || result["reason"] != "invalid_runtime_input" {
			t.Fatalf("invalid active period (%s): %+v", name, result)
		}
	}

	if result := evaluate(map[string]any{
		"windowMode": "inside", "occurredAt": "2026-01-07T10:00:00Z", "receivedAt": "2026-01-07T10:00:05Z",
		"evaluatedAt": "2026-01-07T10:00:06Z",
	}); result["shouldAct"] != true || result["reason"] != "matched" {
		t.Fatalf("inside-window match: %+v", result)
	}
	if result := evaluate(map[string]any{
		"windowMode": "inside", "occurredAt": "2026-01-07T10:00:00Z", "receivedAt": "2026-01-07T10:00:05Z",
		"evaluatedAt": "2026-01-10T03:00:00Z",
	}); result["shouldAct"] != false || result["reason"] != "evaluation_outside_allowed_window" {
		t.Fatalf("inside-window action-time miss: %+v", result)
	}
	if result := evaluate(map[string]any{"windowMode": "inside"}); result["shouldAct"] != false || result["reason"] != "event_outside_allowed_window" {
		t.Fatalf("inside-window event miss: %+v", result)
	}
	if result := evaluate(map[string]any{
		"windowMode": "inside", "occurredAt": "2026-01-07T10:00:00Z", "receivedAt": "2026-01-10T03:00:00Z",
	}); result["shouldAct"] != false || result["reason"] != "received_outside_allowed_window" {
		t.Fatalf("inside-window receipt miss: %+v", result)
	}
	for name, overrides := range map[string]map[string]any{
		"bad zone":      {"windowMode": "inside", "timeZone": "Not/AZone"},
		"bad clock":     {"windowMode": "inside", "workingHours": []any{map[string]any{"days": weekdays, "start": "9am", "end": "17:00"}}},
		"empty days":    {"windowMode": "inside", "workingHours": []any{map[string]any{"days": []any{}, "start": "09:00", "end": "17:00"}}},
		"mixed days":    {"windowMode": "inside", "workingHours": []any{map[string]any{"days": []any{1.0, "bad"}, "start": "09:00", "end": "17:00"}}},
		"duplicate day": {"windowMode": "inside", "workingHours": []any{map[string]any{"days": []any{1.0, 1.0}, "start": "09:00", "end": "17:00"}}},
		"no windows":    {"windowMode": "inside", "workingHours": []any{}},
	} {
		if result := evaluate(overrides); result["shouldAct"] != false || result["reason"] != "invalid_runtime_input" {
			t.Fatalf("inside-window malformed policy authorized action (%s): %+v", name, result)
		}
	}
}

func TestPagerDutyOutcomeVerifyRequiresAcknowledgementAndExactSnoozeReceipt(t *testing.T) {
	registry := NewRegistry()
	deadline := "2026-01-10T15:00:00Z"
	incident := func(status, observed string) map[string]any {
		pending := []any{}
		if observed != "" {
			pending = append(pending, map[string]any{"type": "unacknowledge", "at": observed})
		}
		return map[string]any{
			"id": "PINC1", "status": status, "title": "db down", "urgency": "high",
			"serviceId": "PSVC1", "assignedUserIds": []any{"PUSER1"}, "pendingActions": pending,
		}
	}
	verify := func(record map[string]any, expectedIncidentID, expected string) map[string]any {
		result, err := registry.Execute(context.Background(), "pagerduty.outcome.verify", map[string]any{
			"incident": record, "expectedIncidentId": expectedIncidentID, "expectedSnoozeUntil": expected,
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	if result := verify(incident("acknowledged", deadline), "PINC1", deadline); result["verified"] != true ||
		result["acknowledged"] != true || result["snoozeVerified"] != true || result["reason"] != "matched" {
		t.Fatalf("verified outcome: %+v", result)
	}
	for name, record := range map[string]map[string]any{
		"status":   incident("triggered", deadline),
		"missing":  incident("acknowledged", ""),
		"mismatch": incident("acknowledged", "2026-01-10T14:59:59Z"),
		"malformed": {
			"id": "PINC1", "status": "acknowledged", "assignedUserIds": []any{"PUSER1"},
			"pendingActions": []any{map[string]any{"type": "unacknowledge", "at": "not-a-time"}},
		},
	} {
		if result := verify(record, "PINC1", deadline); result["verified"] != false {
			t.Fatalf("%s unexpectedly verified: %+v", name, result)
		}
	}
	if result := verify(incident("acknowledged", deadline), "PINC_OTHER", deadline); result["verified"] != false || result["reason"] != "incident_mismatch" {
		t.Fatalf("mismatched receipt incident unexpectedly verified: %+v", result)
	}
}

func TestPagerDutyIncidentProjectionIsBoundedAndUTF8Safe(t *testing.T) {
	longTitle := strings.Repeat("a", pagerDutyIncidentTitleMax-1) + "é-tail"
	incident := projectPagerDutyIncident(map[string]any{
		"id": "PINC1", "status": "triggered", "title": longTitle, "urgency": "high",
		"service":         map[string]any{"id": "PSVC1"},
		"assignments":     []any{map[string]any{"assignee": map[string]any{"id": "PUSER1"}}},
		"pending_actions": []any{map[string]any{"type": "unacknowledge", "at": "2026-01-10T15:00:00Z"}},
	})
	if incident == nil || incident.Title == nil || !json.Valid(mustPagerDutyJSON(t, incident.toMap())) ||
		!utf8.ValidString(*incident.Title) ||
		len(*incident.Title) > pagerDutyIncidentTitleMax || !strings.HasSuffix(*incident.Title, "a") {
		t.Fatalf("bounded projection: %+v", incident)
	}
	for name, record := range map[string]map[string]any{
		"oversized id": {
			"id": strings.Repeat("P", pagerDutyIdentifierMaxBytes+1), "status": "triggered",
		},
		"too many assignments": {
			"id": "PINC1", "status": "triggered", "assignments": make([]any, pagerDutyAssignmentsMax+1),
		},
		"malformed assignment": {
			"id": "PINC1", "status": "triggered", "assignments": []any{"not-an-assignment"},
		},
		"malformed pending action": {
			"id": "PINC1", "status": "triggered",
			"pending_actions": []any{map[string]any{"type": "unacknowledge", "at": "never"}},
		},
		"too many pending actions": {
			"id": "PINC1", "status": "triggered",
			"pending_actions": make([]any, pagerDutyPendingActionsMax+1),
		},
	} {
		if got := projectPagerDutyIncident(record); got != nil {
			t.Fatalf("%s accepted: %+v", name, got)
		}
	}
	projectedUsers := make([]any, pagerDutyAssignmentsMax+1)
	for index := range projectedUsers {
		projectedUsers[index] = "PUSER"
	}
	if got := parseProjectedPagerDutyIncident(map[string]any{
		"id": "PINC1", "status": "triggered", "assignedUserIds": projectedUsers,
	}); got != nil {
		t.Fatalf("oversized projected assignments accepted: %+v", got)
	}
}

func mustPagerDutyJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestPagerDutyWorkingHoursEvaluatorBias(t *testing.T) {
	saturday := time.Date(2026, 1, 10, 3, 0, 0, 0, time.UTC)
	windows := []WorkingWindow{{Days: []int{1, 2, 3, 4, 5}, Start: "09:00", End: "17:00"}}
	if IsWithinPagerDutyWorkingHours(saturday, "UTC", windows) {
		t.Fatal("saturday 03:00 is off-hours under a weekday window")
	}
	// Every malformed shape absorbs as working time.
	if !IsWithinPagerDutyWorkingHours(saturday, "UTC", nil) ||
		!IsWithinPagerDutyWorkingHours(saturday, "Not/AZone", windows) ||
		!IsWithinPagerDutyWorkingHours(saturday, "UTC", []WorkingWindow{{Days: []int{6}, Start: "09:00", End: "09:00"}}) {
		t.Fatal("malformed policy must absorb as working hours")
	}
}

func TestPagerDutyPolicyCatalogMarksEvaluationTimeRequired(t *testing.T) {
	registry := NewRegistry()
	var policy CatalogEntry
	for _, entry := range registry.CatalogEntries() {
		if entry.Name == "pagerduty.policy.evaluate" {
			policy = entry
			break
		}
	}
	if policy.Name == "" || !slices.Contains(policy.Required, "evaluatedAt") {
		t.Fatalf("policy catalog missing required evaluatedAt contract: %+v", policy)
	}
	for _, field := range policy.InputFields {
		if field.Name == "evaluatedAt" {
			if !field.Required {
				t.Fatal("evaluatedAt input field must be marked required for capability consumers")
			}
			return
		}
	}
	t.Fatal("policy catalog missing evaluatedAt input field")
}

func TestPagerDutyDefinitionsRejectInvalidStaticPolicyBeforeRun(t *testing.T) {
	registry := NewRegistry()
	valid := map[string]any{
		"eventType": "{{context.event.output.type}}", "occurredAt": "{{context.event.output.occurredAt}}",
		"receivedAt": "{{context.event.output.receivedAt}}", "evaluatedAt": "{{context.clock.output.result.at}}",
		"incident": "{{context.load.output.result.incident}}", "pagerDutyUserId": "PUSER1",
		"snoozeSeconds": int64(43_200), "timeZone": "America/Bogota",
		"workingHours": []any{map[string]any{
			"days": []int{1, 2, 3, 4, 5}, "start": "{{context.input.start}}", "end": "{{context.input.end}}",
		}},
	}
	if err := registry.ValidateInput("pagerduty.policy.evaluate", valid); err != nil {
		t.Fatalf("valid mixed literal/deferred policy rejected: %v", err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"snooze ceiling": func(input map[string]any) { input["snoozeSeconds"] = 604_801 },
		"unknown zone":   func(input map[string]any) { input["timeZone"] = "Not/AZone" },
		"ambiguous clock": func(input map[string]any) {
			input["workingHours"] = []any{map[string]any{"days": []any{1.0}, "start": "09:00", "end": "09:00"}}
		},
		"unknown event filter": func(input map[string]any) {
			input["actionableEventTypes"] = []any{"incident.future_mutation"}
		},
		"partial activation": func(input map[string]any) { input["activeFrom"] = "2026-01-01T00:00:00Z" },
		"reversed chronology": func(input map[string]any) {
			input["occurredAt"] = "2026-01-02T00:00:00Z"
			input["receivedAt"] = "2026-01-01T00:00:00Z"
		},
	} {
		t.Run(name, func(t *testing.T) {
			input := maps.Clone(valid)
			mutate(input)
			if err := registry.ValidateInput("pagerduty.policy.evaluate", input); err == nil {
				t.Fatal("invalid static policy was accepted")
			}
		})
	}

	partial := maps.Clone(valid)
	partial["activeFrom"] = "2026-01-01T00:00:00Z"
	delete(partial, "activeUntil")
	if err := registry.ValidatePartialInput("pagerduty.policy.evaluate", partial); err != nil {
		t.Fatalf("draft must be able to expose one unresolved activation binding: %v", err)
	}
}

func TestPagerDutyAPIDefinitionsRejectInvalidStaticAuthority(t *testing.T) {
	registry := NewRegistry()
	base := map[string]any{
		"credential": "pagerduty-api", "requesterEmail": "operator@example.com", "incidentId": "PINC1",
	}
	for name, input := range map[string]map[string]any{
		"header injection": maps.Clone(base),
		"unknown region":   maps.Clone(base),
		"fractional rate":  maps.Clone(base),
		"short snooze":     maps.Clone(base),
	} {
		switch name {
		case "header injection":
			input["requesterEmail"] = "operator@example.com\r\nX-Evil: yes"
		case "unknown region":
			input["region"] = "global"
		case "fractional rate":
			input["rateLimitPerMin"] = 1.5
		case "short snooze":
			input["durationSeconds"] = 59
		}
		tool := "pagerduty.incident.get"
		if name == "short snooze" {
			tool = "pagerduty.incident.snooze"
		}
		if err := registry.ValidateInput(tool, input); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}

	templated := map[string]any{
		"credential": "pagerduty-api", "requesterEmail": "{{context.input.email}}",
		"incidentId": "{{context.event.output.incidentId}}", "durationSeconds": "{{context.input.seconds}}",
	}
	if err := registry.ValidateInput("pagerduty.incident.snooze", templated); err != nil {
		t.Fatalf("persisted exact references rejected: %v", err)
	}
	if err := registry.ValidateResolvedInput("pagerduty.incident.snooze", templated); err == nil {
		t.Fatal("unresolved PagerDuty authority reached runtime")
	}
}

func TestPagerDutyActivePeriodUsesCalendarBoundAcrossDST(t *testing.T) {
	from, until, configured, valid := pagerDutyActivePeriod(map[string]any{
		"activeFrom":  "2026-10-15T00:00:00-04:00",
		"activeUntil": "2026-11-15T00:00:00-05:00",
		"timeZone":    "America/New_York",
	})
	if !configured || !valid || until.Sub(from) != 31*24*time.Hour+time.Hour {
		t.Fatalf("DST-spanning 31-day period: from=%v until=%v configured=%v valid=%v", from, until, configured, valid)
	}
	_, _, configured, valid = pagerDutyActivePeriod(map[string]any{
		"activeFrom":  "2026-10-15T00:00:00-04:00",
		"activeUntil": "2026-11-16T00:00:00-05:00",
		"timeZone":    "America/New_York",
	})
	if !configured || valid {
		t.Fatalf("32-day calendar period must fail closed: configured=%v valid=%v", configured, valid)
	}
	for name, timeZone := range map[string]any{
		"missing zone": nil,
		"invalid zone": "Not/AZone",
	} {
		_, _, configured, valid = pagerDutyActivePeriod(map[string]any{
			"activeFrom":  "2026-01-10T02:00:00Z",
			"activeUntil": "2026-01-10T04:00:00Z",
			"timeZone":    timeZone,
		})
		if !configured || valid {
			t.Fatalf("%s must invalidate even a short period: configured=%v valid=%v", name, configured, valid)
		}
	}
}

func TestPagerDutySimulatorRequiresDoubleLocalGate(t *testing.T) {
	t.Setenv("JANUSLY_LOCAL_STACK", "")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://simulator.invalid")
	if got := pagerDutyAPIBase("us"); got != "https://api.pagerduty.com" {
		t.Fatalf("single simulator flag redirected provider traffic: %s", got)
	}
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	if got := pagerDutyAPIBase("us"); got != "http://simulator.invalid/pagerduty" {
		t.Fatalf("double local gate did not enable simulator: %s", got)
	}
}

// The API-backed tools refuse to run without deps and refuse bad bounds
// before any egress.
func TestPagerDutyAPIToolGuards(t *testing.T) {
	result := executePagerDutyAPICall(context.Background(), "pagerduty.incident.get",
		map[string]any{"credential": "c", "requesterEmail": "a@b.co", "incidentId": "P1"}, nil)
	if result["ok"] != false {
		t.Fatalf("nil deps must fail closed: %+v", result)
	}
	gateCalls := 0
	deps := &IntegrationDeps{
		Gate: func(context.Context, string, string, string, int) (string, string) {
			gateCalls++
			return "token", ""
		},
		Fetch: func(context.Context, string, string, map[string]string, []byte, int) (int, string, string) {
			t.Fatal("bounds must be checked before egress")
			return 0, "", ""
		},
	}
	result = executePagerDutyAPICall(context.Background(), "pagerduty.incident.snooze",
		map[string]any{"credential": "c", "requesterEmail": "a@b.co", "incidentId": "P1", "durationSeconds": 5.0}, deps)
	if result["ok"] != false {
		t.Fatalf("snooze below 60s must fail: %+v", result)
	}
	if gateCalls != 0 {
		t.Fatalf("invalid snooze input resolved a credential or consumed a rate token: %d", gateCalls)
	}
	result = executePagerDutyAPICall(context.Background(), "pagerduty.incident.get",
		map[string]any{"credential": "c", "requesterEmail": "operator@example.com\r\nx-evil: yes", "incidentId": "P1"}, deps)
	if result["ok"] != false {
		t.Fatalf("header-injecting requester email must fail: %+v", result)
	}
	result = executePagerDutyAPICall(context.Background(), "pagerduty.incident.get",
		map[string]any{"credential": "c", "requesterEmail": "operator@example.com\x00", "incidentId": "P1"}, deps)
	if result["ok"] != false {
		t.Fatalf("control-byte requester email must fail: %+v", result)
	}
	result = executePagerDutyAPICall(context.Background(), "pagerduty.incident.get",
		map[string]any{"credential": "c", "requesterEmail": "a@b.co", "incidentId": "P1", "rateLimitPerMin": 1.5}, deps)
	if result["ok"] != false || gateCalls != 0 {
		t.Fatalf("fractional rate limit must fail before the gate: calls=%d result=%+v", gateCalls, result)
	}
}

func TestPagerDutyWorkflowRateLimitCanOnlyLowerTenantCeiling(t *testing.T) {
	t.Parallel()
	var observed []int
	deps := &IntegrationDeps{
		RateLimitPerMin: func(string, int) int { return 50 },
		Gate: func(_ context.Context, _, _, _ string, limit int) (string, string) {
			observed = append(observed, limit)
			return "token", ""
		},
		Fetch: func(context.Context, string, string, map[string]string, []byte, int) (int, string, string) {
			return 200, `{"incident":{"id":"P1","status":"triggered","assignments":[],"pending_actions":[]}}`, ""
		},
	}
	base := map[string]any{"credential": "c", "requesterEmail": "operator@example.com", "incidentId": "P1"}
	for _, requested := range []float64{100, 10} {
		input := maps.Clone(base)
		input["rateLimitPerMin"] = requested
		if result := executePagerDutyAPICall(context.Background(), "pagerduty.incident.get", input, deps); result["ok"] != true {
			t.Fatalf("rate limit %v: %+v", requested, result)
		}
	}
	if !slices.Equal(observed, []int{50, 10}) {
		t.Fatalf("workflow raised or lost tenant ceiling: %v", observed)
	}
}

func TestPagerDutyMutationReceiptsAreRequiredAndBounded(t *testing.T) {
	deadline := time.Now().UTC().Add(12 * time.Hour).Format(time.RFC3339Nano)
	deps := &IntegrationDeps{
		Gate: func(context.Context, string, string, string, int) (string, string) { return "token", "" },
		Fetch: func(_ context.Context, method, target string, _ map[string]string, body []byte, maxResponseBytes int) (int, string, string) {
			if maxResponseBytes != pagerDutyResponseMaxBytes {
				t.Fatalf("PagerDuty response cap=%d want %d", maxResponseBytes, pagerDutyResponseMaxBytes)
			}
			switch method {
			case "PUT":
				if target != "https://api.pagerduty.com/incidents" {
					t.Fatalf("acknowledge endpoint=%q", target)
				}
				var request map[string]json.RawMessage
				if err := json.Unmarshal(body, &request); err != nil || len(request) != 1 {
					t.Fatalf("acknowledge request envelope=%s err=%v", body, err)
				}
				var incidents []map[string]string
				if err := json.Unmarshal(request["incidents"], &incidents); err != nil || len(incidents) != 1 ||
					len(incidents[0]) != 3 || incidents[0]["id"] != "P1" ||
					incidents[0]["type"] != "incident_reference" || incidents[0]["status"] != "acknowledged" {
					t.Fatalf("acknowledge request incidents=%v err=%v", incidents, err)
				}
				return 200, `{"incidents":[{"id":"P1","status":"acknowledged"}]}`, ""
			case "POST":
				return 201, `{"incident":{"id":"P1","status":"acknowledged","pending_actions":[{"type":"unacknowledge","at":"` + deadline + `"}]}}`, ""
			default:
				return 500, "", "unexpected method"
			}
		},
	}
	base := map[string]any{"credential": "c", "requesterEmail": "operator@example.com", "incidentId": "P1"}
	if result := executePagerDutyAPICall(context.Background(), "pagerduty.incident.acknowledge", base, deps); result["ok"] != true {
		t.Fatalf("ack receipt: %+v", result)
	}
	snooze := maps.Clone(base)
	snooze["durationSeconds"] = 43_200.0
	if result := executePagerDutyAPICall(context.Background(), "pagerduty.incident.snooze", snooze, deps); result["ok"] != true || result["snoozeUntil"] != deadline {
		t.Fatalf("snooze receipt: %+v", result)
	}

	deps.Fetch = func(context.Context, string, string, map[string]string, []byte, int) (int, string, string) {
		return 200, `{"incident":{"id":"P1","status":"acknowledged"}}`, ""
	}
	if result := executePagerDutyAPICall(context.Background(), "pagerduty.incident.snooze", snooze, deps); result["ok"] != false {
		t.Fatalf("snooze without pending-action receipt must fail: %+v", result)
	}
	deps.Fetch = func(context.Context, string, string, map[string]string, []byte, int) (int, string, string) {
		wrongDeadline := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
		return 200, `{"incident":{"id":"P1","status":"acknowledged","pending_actions":[{"type":"unacknowledge","at":"` + wrongDeadline + `"}]}}`, ""
	}
	if result := executePagerDutyAPICall(context.Background(), "pagerduty.incident.snooze", snooze, deps); result["ok"] != false {
		t.Fatalf("snooze receipt with a different duration must fail: %+v", result)
	}
	for name, receipt := range map[string]string{
		"ack missing incidents": `{}`,
		"ack legacy singular":   `{"incident":{"id":"P1","status":"acknowledged"}}`,
		"ack empty list":        `{"incidents":[]}`,
		"ack wrong id":          `{"incidents":[{"id":"P2","status":"acknowledged"}]}`,
		"ack wrong status":      `{"incidents":[{"id":"P1","status":"triggered"}]}`,
		"ack multiple receipts": `{"incidents":[{"id":"P1","status":"acknowledged"},{"id":"P2","status":"acknowledged"}]}`,
		"ack malformed receipt": `{"incidents":["not-an-incident"]}`,
	} {
		deps.Fetch = func(context.Context, string, string, map[string]string, []byte, int) (int, string, string) {
			return 200, receipt, ""
		}
		if result := executePagerDutyAPICall(context.Background(), "pagerduty.incident.acknowledge", base, deps); result["ok"] != false {
			t.Fatalf("%s accepted: %+v", name, result)
		}
	}
}
