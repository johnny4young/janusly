// time.window — the ONE zone-aware weekday/time-of-day decision primitive
// (reference the source contract). Zone resolution and
// midnight-crossing matching come from internal/zonedwindow, shared with
// the PagerDuty off-hours evaluator. The BIAS stays here: this tool
// REJECTS malformed configuration (an unknown zone or unparseable window
// errors so the node fails loudly and lands in recovery, instead of
// silently reporting `false`, which a caller could read as either "act" or
// "skip"). That is the deliberate opposite of the defensive
// IsWithinPagerDutyWorkingHours helper, which absorbs bad policy data as
// "working hours". The executable PagerDuty policy separately validates its
// complete window first, so invalid data fails closed in both inside and
// outside modes. Don't unify the helper biases.
package tools

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/zonedwindow"
)

// timeWindowMax bounds windows per call — enough for a weekly schedule
// with splits.
const timeWindowMax = 14

const (
	minUnixMillisecond = int64(-62_135_596_800_000) // 0001-01-01T00:00:00Z
	maxUnixMillisecond = int64(253_402_300_799_999) // 9999-12-31T23:59:59.999Z
)

type localWindow struct {
	days  []int
	start string
	end   string
}

// parseEpochValue accepts an ISO-8601/RFC3339 string or a numeric epoch in
// milliseconds — the contract's toEpochMs contract.
func parseEpochValue(value any) (time.Time, error) {
	if milliseconds, ok := boundedWholeNumber(value, minUnixMillisecond, maxUnixMillisecond); ok {
		return time.UnixMilli(milliseconds).UTC(), nil
	}
	switch typed := value.(type) {
	case string:
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z0700", "2006-01-02"} {
			if parsed, err := time.Parse(layout, typed); err == nil {
				return parsed, nil
			}
		}
		return time.Time{}, fmt.Errorf("Invalid date/time: %s", typed) //nolint:staticcheck // contract message is the wire contract
	default:
		return time.Time{}, fmt.Errorf("Invalid date/time: %v", value) //nolint:staticcheck // contract message is the wire contract
	}
}

func parseTimeWindows(raw any) ([]localWindow, error) {
	items, ok := arrayItems(raw)
	if !ok || len(items) == 0 || len(items) > timeWindowMax {
		return nil, fmt.Errorf("time.window requires 1..%d windows", timeWindowMax)
	}
	windows := make([]localWindow, 0, len(items))
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("time.window windows must be objects")
		}
		rawDays, ok := arrayItems(entry["days"])
		if !ok || len(rawDays) == 0 || len(rawDays) > 7 {
			return nil, fmt.Errorf("time.window days must list 1..7 weekdays (0=Sunday..6=Saturday)")
		}
		days := make([]int, 0, len(rawDays))
		for _, rawDay := range rawDays {
			day, ok := boundedWholeNumber(rawDay, 0, 6)
			if !ok {
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

func validateTimeWindowDefinition(input map[string]any, options InputValidationOptions) error {
	if !options.AllowWholeTemplates {
		return nil
	}
	if raw, present := input["timeZone"]; present && !isDeferredWholeTemplate(raw, options) {
		value, _ := raw.(string)
		if value == "" || value != strings.TrimSpace(value) {
			return fmt.Errorf("timeZone must be a canonical IANA time zone")
		}
		if _, err := time.LoadLocation(value); err != nil {
			return fmt.Errorf("Invalid IANA time zone: %s", value) //nolint:staticcheck // contract message is intentionally stable
		}
	}
	if raw, present := input["windows"]; present && !validatePagerDutyWindows(raw, options) {
		return fmt.Errorf("time.window requires 1..%d valid, unambiguous windows", timeWindowMax)
	}
	if raw, present := input["at"]; present && raw != nil && !isDeferredWholeTemplate(raw, options) {
		if _, err := parseEpochValue(raw); err != nil {
			return err
		}
	}
	return nil
}

func timeWindowTools() []Definition {
	return []Definition{
		{
			Name:         "time.now",
			Description:  "Return the current UTC instant for an explicit action-time policy check.",
			Required:     []string{},
			Optional:     []string{},
			Fields:       []Field{},
			InputExample: map[string]any{},
			Execute: func(_ context.Context, _ map[string]any) (map[string]any, error) {
				now := time.Now().UTC()
				iso := now.Format(time.RFC3339Nano)
				return map[string]any{"at": iso, "iso": iso, "epochMs": now.UnixMilli()}, nil
			},
		},
		{
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
				{Name: "at", Type: "json", AcceptedTypes: []string{"string", "number"}},
			},
			InputExample: map[string]any{
				"timeZone": "America/Bogota",
				"windows":  []any{map[string]any{"days": []any{1.0, 2.0, 3.0, 4.0, 5.0}, "start": "09:00", "end": "17:00"}},
			},
			Validate: validateTimeWindowDefinition,
			Execute:  executeTimeWindow,
		},
	}
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
	// see the file header for why this helper bias differs from PagerDuty's
	// defensive matching helper.
	clock, ok := zonedwindow.ZonedClock(at, timeZone)
	if !ok {
		return nil, fmt.Errorf("Invalid IANA time zone: %s", timeZone) //nolint:staticcheck // contract message is the wire contract
	}

	var matched map[string]any
	for _, window := range windows {
		start, startOK := zonedwindow.ParseLocalMinute(window.start)
		end, endOK := zonedwindow.ParseLocalMinute(window.end)
		if !startOK || !endOK {
			return nil, fmt.Errorf("Invalid window time (expected 24h HH:MM): %s-%s", window.start, window.end) //nolint:staticcheck // contract message is the wire contract
		}
		if start == end {
			return nil, fmt.Errorf("Ambiguous window %s-%s: start and end must differ", window.start, window.end) //nolint:staticcheck // contract message is the wire contract
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
