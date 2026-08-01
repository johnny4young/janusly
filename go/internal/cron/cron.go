// Minimal five-field cron (minute hour day-of-month month day-of-week)
// for the schedule node's due clock. Supports `*`, numbers, ranges (a-b),
// steps (*/n, a-b/n), and comma lists — the subset the reference's
// validateCronExpression accepts from operators; month/weekday NAMES are
// deliberately out (authoring stays numeric). Day-of-month and
// day-of-week combine with OR when both are restricted, matching classic
// cron. All times are UTC.
package cron

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Schedule is a parsed expression.
type Schedule struct {
	minute, hour, dayOfMonth, month, dayOfWeek map[int]bool
	domRestricted, dowRestricted               bool
}

type fieldSpec struct {
	name     string
	min, max int
}

var fieldSpecs = []fieldSpec{
	{"minute", 0, 59}, {"hour", 0, 23}, {"day-of-month", 1, 31},
	{"month", 1, 12}, {"day-of-week", 0, 6},
}

// Parse validates and compiles a five-field expression.
func Parse(expression string) (*Schedule, error) {
	fields := strings.Fields(strings.TrimSpace(expression))
	if len(fields) != 5 {
		return nil, fmt.Errorf("cron expression must have 5 fields (minute hour day month weekday)")
	}
	sets := make([]map[int]bool, 5)
	restricted := make([]bool, 5)
	for index, field := range fields {
		spec := fieldSpecs[index]
		values, isWildcard, err := parseField(field, spec)
		if err != nil {
			return nil, err
		}
		sets[index] = values
		restricted[index] = !isWildcard
	}
	return &Schedule{
		minute: sets[0], hour: sets[1], dayOfMonth: sets[2], month: sets[3],
		dayOfWeek: sets[4], domRestricted: restricted[2], dowRestricted: restricted[4],
	}, nil
}

func parseField(field string, spec fieldSpec) (map[int]bool, bool, error) {
	values := map[int]bool{}
	isWildcard := true
	for _, part := range strings.Split(field, ",") {
		rangePart, step := part, 1
		if slash := strings.Index(part, "/"); slash >= 0 {
			rangePart = part[:slash]
			parsed, err := strconv.Atoi(part[slash+1:])
			if err != nil || parsed < 1 {
				return nil, false, fmt.Errorf("invalid cron step in %s field: %q", spec.name, part)
			}
			step = parsed
		}
		low, high := spec.min, spec.max
		switch {
		case rangePart == "*":
			// full range
		case strings.Contains(rangePart, "-"):
			bounds := strings.SplitN(rangePart, "-", 2)
			a, errA := strconv.Atoi(bounds[0])
			b, errB := strconv.Atoi(bounds[1])
			if errA != nil || errB != nil || a > b {
				return nil, false, fmt.Errorf("invalid cron range in %s field: %q", spec.name, part)
			}
			low, high = a, b
			isWildcard = false
		default:
			value, err := strconv.Atoi(rangePart)
			if err != nil {
				return nil, false, fmt.Errorf("invalid cron value in %s field: %q", spec.name, part)
			}
			low, high = value, value
			isWildcard = false
		}
		if step > 1 {
			isWildcard = false
		}
		if low < spec.min || high > spec.max {
			return nil, false, fmt.Errorf("%s field out of range %d-%d: %q", spec.name, spec.min, spec.max, part)
		}
		for value := low; value <= high; value += step {
			values[value] = true
		}
	}
	if len(values) == 0 {
		return nil, false, fmt.Errorf("empty %s field", spec.name)
	}
	return values, isWildcard, nil
}

// matchesDay implements classic cron's OR between restricted day fields.
func (s *Schedule) matchesDay(t time.Time) bool {
	domMatch := s.dayOfMonth[t.Day()]
	dowMatch := s.dayOfWeek[int(t.Weekday())]
	if s.domRestricted && s.dowRestricted {
		return domMatch || dowMatch
	}
	return domMatch && dowMatch
}

// Next returns the first UTC instant strictly after `after` that matches.
// Bounded to four years of scanning so a impossible date (Feb 30) errors
// out instead of spinning.
func (s *Schedule) Next(after time.Time) (time.Time, error) {
	t := after.UTC().Truncate(time.Minute).Add(time.Minute)
	limit := after.UTC().AddDate(4, 0, 0)
	for t.Before(limit) {
		if !s.month[int(t.Month())] {
			t = time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, 1, 0)
			continue
		}
		if !s.matchesDay(t) {
			t = t.Truncate(24 * time.Hour).Add(24 * time.Hour)
			continue
		}
		if !s.hour[t.Hour()] {
			t = t.Truncate(time.Hour).Add(time.Hour)
			continue
		}
		if !s.minute[t.Minute()] {
			t = t.Add(time.Minute)
			continue
		}
		return t, nil
	}
	return time.Time{}, fmt.Errorf("cron expression never fires within 4 years")
}

// Validate reports whether an expression parses and can fire.
func Validate(expression string) error {
	schedule, err := Parse(expression)
	if err != nil {
		return err
	}
	_, err = schedule.Next(time.Now())
	return err
}
