// time.window — the ONE zone-aware weekday/time-of-day decision primitive
// (reference packages/engine/src/tools/time.ts). Zone resolution and
// midnight-crossing matching come from internal/zonedwindow, shared with
// the PagerDuty off-hours evaluator. The BIAS stays here: this tool
// REJECTS malformed configuration (an unknown zone or unparseable window
// errors so the node fails loudly and lands in recovery, instead of
// silently reporting `false`, which a caller could read as either "act" or
// "skip"). That is the deliberate opposite of
// IsWithinPagerDutyWorkingHours, which absorbs bad policy data as
// "working hours" so it can never authorize a mutation. Don't unify them.
package tools

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/johnny4young/janusly/go/internal/zonedwindow"
)

// timeWindowMax bounds windows per call — enough for a weekly schedule
// with splits.
const timeWindowMax = 14

type localWindow struct {
	days  []int
	start string
	end   string
}

// parseEpochValue accepts an ISO-8601/RFC3339 string or a numeric epoch in
// milliseconds — the reference's toEpochMs contract.
func parseEpochValue(value any) (time.Time, error) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return time.Time{}, fmt.Errorf("Invalid date/time: %v", typed) //nolint:staticcheck // reference message is the wire contract
		}
		return time.UnixMilli(int64(typed)).UTC(), nil
	case string:
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z0700", "2006-01-02"} {
			if parsed, err := time.Parse(layout, typed); err == nil {
				return parsed, nil
			}
		}
		return time.Time{}, fmt.Errorf("Invalid date/time: %s", typed) //nolint:staticcheck // reference message is the wire contract
	default:
		return time.Time{}, fmt.Errorf("Invalid date/time: %v", value) //nolint:staticcheck // reference message is the wire contract
	}
}

func parseTimeWindows(raw any) ([]localWindow, error) {
	items, ok := raw.([]any)
	if !ok || len(items) == 0 || len(items) > timeWindowMax {
		return nil, fmt.Errorf("time.window requires 1..%d windows", timeWindowMax)
	}
	windows := make([]localWindow, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("time.window windows must be objects")
		}
		rawDays, ok := entry["days"].([]any)
		if !ok || len(rawDays) == 0 || len(rawDays) > 7 {
			return nil, fmt.Errorf("time.window days must list 1..7 weekdays (0=Sunday..6=Saturday)")
		}
		days := make([]int, 0, len(rawDays))
		for _, rawDay := range rawDays {
			day, ok := rawDay.(float64)
			if !ok || day != math.Trunc(day) || day < 0 || day > 6 {
				return nil, fmt.Errorf("time.window days must list 1..7 weekdays (0=Sunday..6=Saturday)")
			}
			days = append(days, int(day))
		}
		start, _ := entry["start"].(string)
		end, _ := entry["end"].(string)
		windows = append(windows, localWindow{days: days, start: start, end: end})
	}
	return windows, nil
}

func timeWindowTools() []Definition {
	return []Definition{{
		Name: "time.window",
		Description: "Check whether an instant falls inside recurring local time windows (e.g. business hours) " +
			"in an IANA time zone. `days` uses 0=Sunday..6=Saturday; `start`/`end` are 24h `HH:MM` local times " +
			"and a window whose end precedes its start crosses midnight. Omit `at` for now. " +
			"Returns `inWindow` plus the matched window.",
		Required: []string{"timeZone", "windows"},
		Optional: []string{"at"},
		Fields: []Field{
			{Name: "timeZone", Type: "string", Required: true},
			{Name: "windows", Type: "array", Required: true},
			{Name: "at", Type: "string"},
		},
		InputExample: map[string]any{
			"timeZone": "America/Bogota",
			"windows":  []any{map[string]any{"days": []any{1.0, 2.0, 3.0, 4.0, 5.0}, "start": "09:00", "end": "17:00"}},
		},
		Execute: executeTimeWindow,
	}}
}

func executeTimeWindow(_ context.Context, input map[string]any) (map[string]any, error) {
	timeZone, _ := input["timeZone"].(string)
	if timeZone == "" {
		return nil, fmt.Errorf("time.window requires timeZone")
	}
	windows, err := parseTimeWindows(input["windows"])
	if err != nil {
		return nil, err
	}
	at := time.Now().UTC()
	if rawAt, present := input["at"]; present && rawAt != nil {
		at, err = parseEpochValue(rawAt)
		if err != nil {
			return nil, err
		}
	}

	// A decision primitive must never answer from malformed configuration —
	// see the file header for why this bias is the opposite of the
	// PagerDuty evaluator's.
	clock, ok := zonedwindow.ZonedClock(at, timeZone)
	if !ok {
		return nil, fmt.Errorf("Invalid IANA time zone: %s", timeZone) //nolint:staticcheck // reference message is the wire contract
	}

	var matched map[string]any
	for _, window := range windows {
		start, startOK := zonedwindow.ParseLocalMinute(window.start)
		end, endOK := zonedwindow.ParseLocalMinute(window.end)
		if !startOK || !endOK {
			return nil, fmt.Errorf("Invalid window time (expected 24h HH:MM): %s-%s", window.start, window.end) //nolint:staticcheck // reference message is the wire contract
		}
		if start == end {
			return nil, fmt.Errorf("Ambiguous window %s-%s: start and end must differ", window.start, window.end) //nolint:staticcheck // reference message is the wire contract
		}
		if matched == nil && zonedwindow.Contains(clock, window.days, start, end) {
			daysAny := make([]any, 0, len(window.days))
			for _, day := range window.days {
				daysAny = append(daysAny, day)
			}
			matched = map[string]any{"days": daysAny, "start": window.start, "end": window.end}
		}
	}

	result := map[string]any{
		"inWindow":  matched != nil,
		"at":        at.UTC().Format("2006-01-02T15:04:05.000Z"),
		"timeZone":  timeZone,
		"localDay":  clock.Day,
		"localTime": fmt.Sprintf("%02d:%02d", clock.Minute/60, clock.Minute%60),
	}
	if matched != nil {
		result["matchedWindow"] = matched
	} else {
		result["matchedWindow"] = nil
	}
	return result, nil
}
