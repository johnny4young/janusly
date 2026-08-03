package zonedwindow

import (
	"testing"
	"time"
)

func TestParseLocalMinute(t *testing.T) {
	cases := map[string]struct {
		minute int
		ok     bool
	}{
		"09:00": {540, true}, "23:59": {1439, true}, "00:00": {0, true},
		" 09:30 ": {570, true},
		"24:00":   {0, false}, "9:00": {0, false}, "09:60": {0, false}, "": {0, false},
	}
	for input, expected := range cases {
		minute, ok := ParseLocalMinute(input)
		if ok != expected.ok || (ok && minute != expected.minute) {
			t.Fatalf("%q → (%d,%v), want (%d,%v)", input, minute, ok, expected.minute, expected.ok)
		}
	}
}

func TestZonedClockResolvesIANAZones(t *testing.T) {
	// 2026-01-07 is a Wednesday; 15:00 UTC = 10:00 in Bogota (UTC-5).
	at := time.Date(2026, 1, 7, 15, 0, 0, 0, time.UTC)
	clock, ok := ZonedClock(at, "America/Bogota")
	if !ok || clock.Day != 3 || clock.Minute != 600 {
		t.Fatalf("bogota clock: %+v %v", clock, ok)
	}
	if _, ok := ZonedClock(at, "Not/AZone"); ok {
		t.Fatal("invalid zone must report not-ok, not guess")
	}
	if _, ok := ZonedClock(at, ""); ok {
		t.Fatal("empty zone must report not-ok")
	}
}

func TestContainsMidnightCrossing(t *testing.T) {
	weekdays := []int{1, 2, 3, 4, 5}
	// Ordinary window: Wednesday 10:00 inside Mon-Fri 09:00-17:00.
	if !Contains(Clock{Day: 3, Minute: 600}, weekdays, 540, 1020) {
		t.Fatal("inside plain window")
	}
	// End is exclusive.
	if Contains(Clock{Day: 3, Minute: 1020}, weekdays, 540, 1020) {
		t.Fatal("end minute is exclusive")
	}
	// Midnight crossing 22:00-06:00 on Friday: Saturday 02:00 is the TAIL
	// of Friday's window even though Saturday is not listed.
	night := []int{5}
	if !Contains(Clock{Day: 6, Minute: 120}, night, 1320, 360) {
		t.Fatal("saturday 02:00 belongs to friday's overnight window")
	}
	// Sunday 02:00 does not: Saturday is not a listed opening day.
	if Contains(Clock{Day: 0, Minute: 120}, night, 1320, 360) {
		t.Fatal("sunday tail must not match")
	}
	// Friday 23:00 matches the head directly.
	if !Contains(Clock{Day: 5, Minute: 1380}, night, 1320, 360) {
		t.Fatal("friday 23:00 is inside the overnight window")
	}
}
