package boot

import "testing"

// TestSmokeBuild establishes the test harness end to end (compile, run,
// -race).
func TestSmokeBuild(t *testing.T) {
	if got := 1 + 1; got != 2 {
		t.Fatalf("arithmetic broke: got %d", got)
	}
}
