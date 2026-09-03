package engine

import (
	"testing"
	"time"
)

// An idle worker must back off toward the cap and snap back the moment
// work (or a wake-up) appears: LISTEN is the latency path, polling is
// only the lost-notification fallback.
func TestIdlePollIntervalBacksOffAndCaps(t *testing.T) {
	poll := 250 * time.Millisecond
	if got := idlePollInterval(poll, 0); got != poll {
		t.Fatalf("a fresh worker must poll at the configured interval, got %v", got)
	}
	if got := idlePollInterval(poll, 1); got != 500*time.Millisecond {
		t.Fatalf("first idle round: %v", got)
	}
	if got := idlePollInterval(poll, 3); got != 2*time.Second {
		t.Fatalf("third idle round: %v", got)
	}
	for _, idle := range []int{4, 10, 1_000} {
		if got := idlePollInterval(poll, idle); got != idlePollBackoffMax {
			t.Fatalf("idle=%d must clamp to the cap, got %v", idle, got)
		}
	}
	// A slow configured poll is never made faster by the backoff.
	slow := 5 * time.Second
	if got := idlePollInterval(slow, 0); got != slow {
		t.Fatalf("configured interval must win when slower than the cap, got %v", got)
	}
}
