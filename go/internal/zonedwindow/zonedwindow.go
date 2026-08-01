// Timezone-aware weekday/time-of-day window matching (reference
// packages/engine/src/zoned-window.ts).
//
// The two hard parts of "is this instant inside a recurring local window" —
// resolving an instant to a wall clock in an IANA zone, and windows that
// cross midnight — live here once so callers cannot drift apart.
//
// Used by:
//   - internal/tools/timewindow.go — the generic `time.window` tool, which
//     REJECTS malformed configuration (a decision primitive must never
//     answer from bad input).
//   - internal/tools/pagerduty.go — the PagerDuty off-hours evaluator,
//     which deliberately treats malformed configuration as "inside working
//     hours" so a broken policy can never authorize a mutation.
//
// Those two fail postures are opposite ON PURPOSE. This module stays
// neutral: it validates and reports, and each caller decides what invalid
// means. The IANA database is embedded (time/tzdata) so zone resolution
// never depends on the container image.
package zonedwindow

import (
	"regexp"
	"time"
	_ "time/tzdata"
)

// Clock is a wall clock inside a target zone: weekday (0=Sunday) + minutes
// since local midnight.
type Clock struct {
	Day    int
	Minute int
}

var localMinutePattern = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)

// ParseLocalMinute parses `HH:MM` (24h) into minutes since midnight; the
// second return is false when malformed.
func ParseLocalMinute(value string) (int, bool) {
	match := localMinutePattern.FindStringSubmatch(trimSpace(value))
	if match == nil {
		return 0, false
	}
	hour := int(match[1][0]-'0')*10 + int(match[1][1]-'0')
	minute := int(match[2][0]-'0')*10 + int(match[2][1]-'0')
	return hour*60 + minute, true
}

func trimSpace(value string) string {
	start, end := 0, len(value)
	for start < end && (value[start] == ' ' || value[start] == '\t') {
		start++
	}
	for end > start && (value[end-1] == ' ' || value[end-1] == '\t') {
		end--
	}
	return value[start:end]
}

// ZonedClock resolves an instant to its wall clock in `timeZone`. The
// second return is false for an unknown/invalid zone, so callers choose
// the failure semantics rather than this module choosing for them.
func ZonedClock(at time.Time, timeZone string) (Clock, bool) {
	location, err := time.LoadLocation(timeZone)
	if err != nil || timeZone == "" {
		return Clock{}, false
	}
	local := at.In(location)
	return Clock{
		Day:    int(local.Weekday()),
		Minute: local.Hour()*60 + local.Minute(),
	}, true
}

// Contains is true when `clock` falls inside the window bounded by
// `startMinute` (inclusive) and `endMinute` (exclusive) on one of `days`.
//
// A window whose end is before its start crosses midnight: it opens on a
// listed day and closes on the following calendar day, so the tail is
// matched against the PREVIOUS day's membership. `start == end` is
// rejected upstream — it is ambiguous between an empty window and a full
// day.
func Contains(clock Clock, days []int, startMinute, endMinute int) bool {
	includes := func(day int) bool {
		for _, candidate := range days {
			if candidate == day {
				return true
			}
		}
		return false
	}
	if startMinute < endMinute {
		return includes(clock.Day) && clock.Minute >= startMinute && clock.Minute < endMinute
	}
	previousDay := (clock.Day + 6) % 7
	return (includes(clock.Day) && clock.Minute >= startMinute) ||
		(includes(previousDay) && clock.Minute < endMinute)
}
