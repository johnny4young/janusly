package cron

import (
	"testing"
	"time"
)

// The 5-field cron parser eats operator input — it must NEVER
// panic, and an accepted schedule must NEVER produce an impossible or
// non-advancing fire time.
func FuzzCronParse(f *testing.F) {
	for _, seed := range []string{
		"* * * * *", "0 3 * * *", "*/15 * * * *", "0 0 1 1 0",
		"59 23 31 12 6", "60 24 32 13 7", "-1 * * * *", "*/0 * * * *",
		"a b c d e", "", "     ", "0,15,30,45 */2 1-15 * 1-5",
		"* * * * * *", "1-60 * * * *", "snowman * * * *", "0 0 30 2 *",
	} {
		f.Add(seed)
	}
	from := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	f.Fuzz(func(t *testing.T, expression string) {
		schedule, err := Parse(expression) // must never panic
		if err != nil || schedule == nil {
			return
		}
		next, err := schedule.Next(from) // must never panic
		if err != nil {
			return // "no fire inside the horizon" is a clean answer
		}
		if !next.After(from) {
			t.Fatalf("Next must advance: %v -> %v (%q)", from, next, expression)
		}
		if next.Second() != 0 || next.Nanosecond() != 0 {
			t.Fatalf("cron fires are minute-aligned: %v (%q)", next, expression)
		}
		// The chain keeps advancing (no fixpoint loops).
		following, err := schedule.Next(next)
		if err == nil && !following.After(next) {
			t.Fatalf("chained Next must advance: %v -> %v (%q)", next, following, expression)
		}
	})
}
