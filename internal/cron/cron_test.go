package cron

import (
	"testing"
	"time"
)

func TestParseRejections(t *testing.T) {
	for _, expression := range []string{
		"", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *",
		"*/0 * * * *", "5-1 * * * *", "a * * * *", "* * 32 * *", "* * * 13 *", "* * * * 7",
	} {
		if _, err := Parse(expression); err == nil {
			t.Fatalf("%q must be rejected", expression)
		}
	}
}

func TestNext(t *testing.T) {
	base := time.Date(2026, 8, 1, 10, 30, 45, 0, time.UTC) // Saturday
	cases := map[string]time.Time{
		"* * * * *":    time.Date(2026, 8, 1, 10, 31, 0, 0, time.UTC),
		"*/15 * * * *": time.Date(2026, 8, 1, 10, 45, 0, 0, time.UTC),
		"0 3 * * *":    time.Date(2026, 8, 2, 3, 0, 0, 0, time.UTC),
		"0 9 * * 1":    time.Date(2026, 8, 3, 9, 0, 0, 0, time.UTC), // next Monday
		"0 0 1 * *":    time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), // first of month
		"30 6 * 12 *":  time.Date(2026, 12, 1, 6, 30, 0, 0, time.UTC),
		"0 12 15 * 1":  time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC), // OR: Monday wins before the 15th
	}
	for expression, expected := range cases {
		schedule, err := Parse(expression)
		if err != nil {
			t.Fatalf("%q: %v", expression, err)
		}
		next, err := schedule.Next(base)
		if err != nil || !next.Equal(expected) {
			t.Fatalf("%q: got %v want %v (%v)", expression, next, expected, err)
		}
	}
	// An impossible date errors instead of spinning.
	schedule, _ := Parse("0 0 30 2 *")
	if _, err := schedule.Next(base); err == nil {
		t.Fatal("Feb 30 must error")
	}
}
