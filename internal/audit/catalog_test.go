package audit

import "testing"

func TestAuditCatalogPinned(t *testing.T) {
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
