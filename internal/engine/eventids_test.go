package engine

import "testing"

// Same-millisecond events of one run must keep their write order.
func TestEventIDsAscendInGenerationOrder(t *testing.T) {
	previous := newEventID()
	for range 10_000 {
		next := newEventID()
		if next <= previous {
			t.Fatalf("event id %s generated after %s sorts before it", next, previous)
		}
		previous = next
	}
}
