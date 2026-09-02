package tools

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// The time.window tool: correct matching plus the REJECTING bias — a
// decision primitive never answers from malformed configuration. (The
// opposite, absorbing bias lives in the PagerDuty evaluator's tests.)
func TestTimeWindowTool(t *testing.T) {
	registry := NewRegistry()
	execute := func(input map[string]any) (map[string]any, error) {
		return registry.Execute(context.Background(), "time.window", input)
	}
	weekdays := []any{1.0, 2.0, 3.0, 4.0, 5.0}
	windows := []any{map[string]any{"days": weekdays, "start": "09:00", "end": "17:00"}}

	// 2026-01-07T15:00Z is Wednesday 10:00 in Bogota — inside the window.
	result, err := execute(map[string]any{
		"timeZone": "America/Bogota", "windows": windows, "at": "2026-01-07T15:00:00Z",
	})
	if err != nil || result["inWindow"] != true || result["localTime"] != "10:00" || result["localDay"] != 3 {
		t.Fatalf("in-window: %+v %v", result, err)
	}
	if result["matchedWindow"] == nil {
		t.Fatal("matched window must be surfaced")
	}
	// Saturday is off-hours.
	result, err = execute(map[string]any{
		"timeZone": "America/Bogota", "windows": windows, "at": "2026-01-10T15:00:00Z",
	})
	if err != nil || result["inWindow"] != false || result["matchedWindow"] != nil {
		t.Fatalf("off-hours: %+v %v", result, err)
	}
	// Numeric epoch-ms input is accepted.
	if result, err = execute(map[string]any{
		"timeZone": "UTC", "windows": windows, "at": 1767798000000.0, // 2026-01-07T15:00:00Z
	}); err != nil || result["inWindow"] != true {
		t.Fatalf("epoch input: %+v %v", result, err)
	}

	// The rejecting bias: bad zone, bad clock, ambiguous window all ERROR.
	if _, err = execute(map[string]any{"timeZone": "Not/AZone", "windows": windows}); err == nil ||
		!strings.Contains(err.Error(), "Invalid IANA time zone") {
		t.Fatalf("invalid zone must error: %v", err)
	}
	if _, err = execute(map[string]any{"timeZone": "UTC", "windows": []any{
		map[string]any{"days": weekdays, "start": "9am", "end": "17:00"},
	}}); err == nil || !strings.Contains(err.Error(), "Invalid window time") {
		t.Fatalf("invalid clock must error: %v", err)
	}
	if _, err = execute(map[string]any{"timeZone": "UTC", "windows": []any{
		map[string]any{"days": weekdays, "start": "09:00", "end": "09:00"},
	}}); err == nil || !strings.Contains(err.Error(), "Ambiguous window") {
		t.Fatalf("ambiguous window must error: %v", err)
	}
	if _, err = execute(map[string]any{"timeZone": "UTC", "windows": []any{}}); err == nil {
		t.Fatal("empty windows must error")
	}
	if _, err = execute(map[string]any{"timeZone": "UTC", "windows": windows, "at": "not-a-date"}); err == nil {
		t.Fatal("unparseable at must error")
	}
}

func TestTimeNowToolReturnsParseableCurrentInstant(t *testing.T) {
	before := time.Now().UTC().Add(-time.Second)
	result, err := NewRegistry().Execute(context.Background(), "time.now", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now().UTC().Add(time.Second)
	at, parseErr := time.Parse(time.RFC3339Nano, fmt.Sprint(result["at"]))
	if parseErr != nil || at.Before(before) || at.After(after) || result["iso"] != result["at"] ||
		result["epochMs"] != at.UnixMilli() {
		t.Fatalf("time.now result=%+v parseErr=%v", result, parseErr)
	}
}
