package memorypolicy

import "testing"

func TestPolicyCoversEveryKind(t *testing.T) {
	all := Kinds()
	if len(all) != 7 {
		t.Fatalf("kind count = %d, want 7", len(all))
	}
	for _, kind := range all {
		defaults, ok := DefaultRetentionDays(kind)
		if !ok || defaults <= 0 {
			t.Fatalf("missing default for %q", kind)
		}
		maximum, ok := MaximumRetentionDays(kind)
		if !ok || maximum < defaults {
			t.Fatalf("invalid maximum for %q: default=%d maximum=%d", kind, defaults, maximum)
		}
	}
	all[0] = "mutated"
	if IsKind("mutated") || !IsKind("recovery_rationale") {
		t.Fatal("Kinds must return a defensive copy")
	}
}
