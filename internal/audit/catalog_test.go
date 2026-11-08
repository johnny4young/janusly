package audit

import "testing"

func TestAuditCatalogPinned(t *testing.T) {
	// Manual pause and resume add two contract actions to the prior 152.
	const want = 154
	if got := len(knownActions); got != want {
		t.Fatalf("contract catalog must pin at %d, got %d", want, got)
	}
	for _, action := range []Action{
		"workflow.saved",
		"org.role.created",
		"workflow.paused",
		"workflow.resumed",
	} {
		if !knownActions[action] {
			t.Errorf("expected contract action missing: %q", action)
		}
		if !IsKnown(action) {
			t.Errorf("contract action must validate: %q", action)
		}
	}
	for _, action := range []Action{
		"made.up.action",
		"workflow.pause",
		"workflow.resume",
	} {
		if IsKnown(action) {
			t.Errorf("unknown action must not validate: %q", action)
		}
	}
}
