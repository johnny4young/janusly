package executors

import (
	"context"
	"testing"
	"time"
)

// Time-grammar cases port waiting-time.ts + iso-duration.ts semantics; all
// clocks are injected — no sleeps.

func TestParseISODurationTable(t *testing.T) {
	cases := []struct {
		text string
		want float64
		nil_ bool
	}{
		{"PT1S", 1000, false},
		{"PT0.5S", 500, false},
		{"PT2M", 120_000, false},
		{"P1D", 86_400_000, false},
		{"P1Y2M3DT4H5M6S", 365*86_400_000 + 2*30*86_400_000 + 3*86_400_000 + 4*3_600_000 + 5*60_000 + 6*1000, false},
		{"P", 0, true},
		{"PT", 0, true},
		{"5 minutes", 0, true},
		{"-PT5S", 0, true},
	}
	for _, tc := range cases {
		got := ParseISODuration(tc.text)
		if tc.nil_ {
			if got != nil {
				t.Fatalf("%s must be rejected, got %v", tc.text, *got)
			}
			continue
		}
		if got == nil || *got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.text, got, tc.want)
		}
	}
}

func TestParseAbsoluteInstantValidation(t *testing.T) {
	valid := ParseAbsoluteInstant("2026-08-01T09:30:00Z")
	if valid == nil || !valid.Equal(time.Date(2026, 8, 1, 9, 30, 0, 0, time.UTC)) {
		t.Fatalf("Z instant broken: %v", valid)
	}
	offset := ParseAbsoluteInstant("2026-08-01T09:30:00+05:00")
	if offset == nil || !offset.Equal(time.Date(2026, 8, 1, 4, 30, 0, 0, time.UTC)) {
		t.Fatalf("offset instant broken: %v", offset)
	}
	fraction := ParseAbsoluteInstant("2026-08-01T09:30:00.5Z")
	if fraction == nil || fraction.Nanosecond() != int(500*time.Millisecond) {
		t.Fatalf("left-aligned fraction broken: %v", fraction)
	}
	leap := ParseAbsoluteInstant("2024-02-29T00:00Z")
	if leap == nil {
		t.Fatal("leap day must parse")
	}
	for _, invalid := range []string{
		"2026-08-01T09:30:00",       // no timezone — ambiguous
		"2026-02-30T00:00Z",         // impossible day
		"2023-02-29T00:00Z",         // not a leap year
		"2026-08-01T24:00Z",         // hour out of range
		"2026-08-01T09:30:00+25:00", // offset out of range
		"tomorrow",
	} {
		if ParseAbsoluteInstant(invalid) != nil {
			t.Fatalf("%s must be rejected", invalid)
		}
	}
}

func TestResolveWaitUntilScheduleContract(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	both := map[string]any{"duration": "PT5S", "until": "2030-01-01T00:00:00Z"}
	if _, err := resolveWaitUntilSchedule(both, now); err == nil ||
		err.Error() != "wait_until accepts either config.duration or config.until, not both" {
		t.Fatalf("conflict message parity broken: %v", err)
	}
	if _, err := resolveWaitUntilSchedule(map[string]any{}, now); err == nil ||
		err.Error() != "wait_until requires config.duration or config.until" {
		t.Fatalf("missing message parity broken: %v", err)
	}
	duration, err := resolveWaitUntilSchedule(map[string]any{"duration": "PT2M"}, now)
	if err != nil || duration.delayMs != 120_000 || duration.source != "duration" ||
		!duration.wakeAt.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("duration schedule broken: %+v err %v", duration, err)
	}
	past, err := resolveWaitUntilSchedule(map[string]any{"until": "2020-01-01T00:00:00Z"}, now)
	if err != nil || past.delayMs != 0 || past.source != "until" {
		t.Fatalf("a past instant must resume immediately: %+v err %v", past, err)
	}
	var configErr *ConfigError
	_, err = resolveWaitUntilSchedule(map[string]any{"duration": "PT0S"}, now)
	if !isConfigError(err, &configErr) || configErr.Code != "wait_until_non_positive_duration" {
		t.Fatalf("non-positive duration code broken: %v", err)
	}
}

func isConfigError(err error, target **ConfigError) bool {
	if err == nil {
		return false
	}
	ce, ok := err.(*ConfigError)
	if !ok {
		return false
	}
	*target = ce
	return true
}

func TestApprovalMetadataShape(t *testing.T) {
	out, err := Registry()["approval"](context.Background(), Input{
		RunID: "r1", NodeID: "gate",
		Config: map[string]any{"message": "  Ship it?  ", "assignee": "ops"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	waiting, ok := out.(Waiting)
	if !ok || waiting.Reason != "Waiting for human approval" || waiting.WakeAt != nil {
		t.Fatalf("approval must wait indefinitely: %+v", out)
	}
	if waiting.Metadata["kind"] != "approval" || waiting.Metadata["title"] != "Ship it?" ||
		waiting.Metadata["resumeToken"] != "r1:gate" || waiting.Metadata["assignee"] != "ops" {
		t.Fatalf("metadata parity broken: %+v", waiting.Metadata)
	}

	titled, _ := Registry()["approval"](context.Background(), Input{
		RunID: "r1", NodeID: "gate",
		Config: map[string]any{"title": "Explicit", "message": "fallback"},
	})
	if titled.(Waiting).Metadata["title"] != "Explicit" {
		t.Fatal("config.title must win over config.message")
	}
}

func TestHumanFormInitialValuesContract(t *testing.T) {
	untitledConfig := map[string]any{
		"schema": map[string]any{
			"type":       "object",
			"properties": map[string]any{"note": map[string]any{"type": "string"}},
		},
	}
	untitled, err := executeHumanForm(context.Background(), Input{Config: untitledConfig})
	if err != nil || untitled.(Waiting).Metadata["title"] != "Human input required" {
		t.Fatalf("default title parity broken: %+v err %v", untitled, err)
	}

	config := map[string]any{
		"title": " Review response ",
		"schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"summary":  map[string]any{"type": "string"},
				"approved": map[string]any{"type": "boolean"},
			},
			"required": []any{"summary"},
		},
		"initialValues": map[string]any{"summary": "AI draft", "approved": false},
	}
	out, err := executeHumanForm(context.Background(), Input{Config: config})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	waiting := out.(Waiting)
	if waiting.Reason != "Waiting for form submission" || waiting.Metadata["title"] != "Review response" {
		t.Fatalf("waiting wire: %+v", waiting)
	}
	initial := waiting.Metadata["initialValues"].(map[string]any)
	if initial["summary"] != "AI draft" || initial["approved"] != false {
		t.Fatalf("initial values missing: %+v", initial)
	}

	config["initialValues"] = map[string]any{"summary": float64(42)}
	if _, err := executeHumanForm(context.Background(), Input{Config: config}); err == nil ||
		err.Error() != "human_form.initialValues invalid: $.summary must be string, got number" {
		t.Fatalf("invalid initial values: %v", err)
	}
}

func TestWebhookMetadataShape(t *testing.T) {
	out, err := Registry()["webhook"](context.Background(), Input{RunID: "r1", NodeID: "trigger"})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	waiting, ok := out.(Waiting)
	if !ok || waiting.Reason != "Waiting for external webhook resume" || waiting.WakeAt != nil {
		t.Fatalf("webhook must wait indefinitely: %+v", out)
	}
	if waiting.Metadata["kind"] != "webhook" || waiting.Metadata["resumeToken"] != "r1:trigger" {
		t.Fatalf("metadata parity broken: %+v", waiting.Metadata)
	}
}

func TestApprovalDeadlineMetadata(t *testing.T) {
	relative, err := Registry()["approval"](context.Background(), Input{
		RunID: "r1", NodeID: "gate",
		Config: map[string]any{"message": "x", "decisionTimeoutMs": float64(60000)},
	})
	if err != nil {
		t.Fatalf("relative deadline: %v", err)
	}
	relativeWaiting := relative.(Waiting)
	if relativeWaiting.WakeAt != nil || relativeWaiting.Metadata["decisionTimeoutMs"] != int64(60_000) ||
		relativeWaiting.Metadata["onTimeout"] != "fail" {
		t.Fatalf("relative deadline must start at checkpoint: %+v", relativeWaiting)
	}
	if _, present := relativeWaiting.Metadata["deadlineAt"]; present {
		t.Fatalf("executor must not materialize the relative clock: %+v", relativeWaiting.Metadata)
	}

	absolute, err := Registry()["approval"](context.Background(), Input{
		RunID: "r1", NodeID: "gate",
		Config: map[string]any{
			"until": "2099-01-02T03:04:05Z", "onTimeout": "escalate",
			"assignee": " tier-1 ", "escalateTo": " tier-2 ",
		},
	})
	if err != nil {
		t.Fatalf("absolute deadline: %v", err)
	}
	absoluteWaiting := absolute.(Waiting)
	wantWake := time.Date(2099, 1, 2, 3, 4, 5, 0, time.UTC)
	if absoluteWaiting.WakeAt == nil || !absoluteWaiting.WakeAt.Equal(wantWake) ||
		absoluteWaiting.Metadata["deadlineAt"] != "2099-01-02T03:04:05.000Z" ||
		absoluteWaiting.Metadata["onTimeout"] != "escalate" ||
		absoluteWaiting.Metadata["assignee"] != "tier-1" ||
		absoluteWaiting.Metadata["escalateTo"] != "tier-2" {
		t.Fatalf("absolute escalation metadata broken: %+v", absoluteWaiting)
	}
}
