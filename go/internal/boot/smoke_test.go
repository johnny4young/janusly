package boot

import "testing"

// TestSmokeBuild establishes the test harness end to end (compile, run,
// -race). Real boot tests arrive with T-001.
func TestSmokeBuild(t *testing.T) {
	if got := 1 + 1; got != 2 {
		t.Fatalf("arithmetic broke: got %d", got)
	}
}
