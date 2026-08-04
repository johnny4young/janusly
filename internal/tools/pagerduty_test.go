package tools

import (
	"context"
	"maps"
	"testing"
	"time"
)

// The deterministic policy ladder — exact reason order from the contract —
// plus the ABSORBING bias: malformed working-hours policy reads as working
// time, so it can never authorize a mutation. (The opposite, rejecting bias
// is tested on time.window.)
func TestPagerDutyPolicyEvaluate(t *testing.T) {
	registry := NewRegistry()
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
			"eventType":  "incident.triggered",
			"occurredAt": "2026-01-10T03:00:00Z", // Saturday 03:00 UTC — off-hours
			"receivedAt": "2026-01-10T03:00:05Z",
			"incident":   incident(nil), "pagerDutyUserId": "PUSER1",
			"timeZone": "UTC", "workingHours": workingHours,
		}
		maps.Copy(input, overrides)
		result, err := registry.Execute(context.Background(), "pagerduty.policy.evaluate", input)
		if err != nil {
			t.Fatalf("policy.evaluate must never error: %v", err)
		}
		return result
	}

	if result := evaluate(nil); result["shouldAct"] != true || result["reason"] != "matched" {
		t.Fatalf("matched case: %+v", result)
	}
	ladder := map[string]map[string]any{
		"event_not_actionable": {"eventType": "incident.annotated"},
		"incident_resolved":    {"incident": incident(map[string]any{"status": "resolved"})},
		"user_not_assigned":    {"pagerDutyUserId": "PUSER9"},
		"service_filtered":     {"serviceIds": []any{"POTHER"}},
		"urgency_filtered":     {"urgencies": []any{"low"}},
		// Wednesday 10:00 UTC is inside Mon-Fri 09:00-17:00.
		"event_in_working_hours": {"occurredAt": "2026-01-07T10:00:00Z"},
		"received_in_working_hours": {
			"receivedAt": "2026-01-07T10:00:00Z",
		},
		"invalid_runtime_input": {"incident": map[string]any{"status": "nonsense"}},
	}
	for reason, overrides := range ladder {
		if result := evaluate(overrides); result["shouldAct"] != false || result["reason"] != reason {
			t.Fatalf("%s: %+v", reason, result)
		}
	}

	// ABSORBING bias: unknown zone / malformed clock / empty days are all
	// treated as WORKING HOURS — the off-hours automation never fires.
	for name, overrides := range map[string]map[string]any{
		"bad zone":   {"timeZone": "Not/AZone"},
		"bad clock":  {"workingHours": []any{map[string]any{"days": weekdays, "start": "9am", "end": "17:00"}}},
		"empty days": {"workingHours": []any{map[string]any{"days": []any{}, "start": "09:00", "end": "17:00"}}},
	} {
		result := evaluate(overrides)
		if result["shouldAct"] != false || result["reason"] != "event_in_working_hours" {
			t.Fatalf("absorbing bias (%s): %+v", name, result)
		}
	}
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

// The API-backed tools refuse to run without deps and refuse bad bounds
// before any egress.
func TestPagerDutyAPIToolGuards(t *testing.T) {
	result := executePagerDutyAPICall(context.Background(), "pagerduty.incident.get",
		map[string]any{"credential": "c", "requesterEmail": "a@b.co", "incidentId": "P1"}, nil)
	if result["ok"] != false {
		t.Fatalf("nil deps must fail closed: %+v", result)
	}
	deps := &IntegrationDeps{
		Gate: func(context.Context, string, string, string, int) (string, string) { return "token", "" },
		Fetch: func(context.Context, string, string, map[string]string, []byte) (int, string, string) {
			t.Fatal("bounds must be checked before egress")
			return 0, "", ""
		},
	}
	result = executePagerDutyAPICall(context.Background(), "pagerduty.incident.snooze",
		map[string]any{"credential": "c", "requesterEmail": "a@b.co", "incidentId": "P1", "durationSeconds": 5.0}, deps)
	if result["ok"] != false {
		t.Fatalf("snooze below 60s must fail: %+v", result)
	}
}
