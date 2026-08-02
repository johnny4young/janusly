package packs

import "testing"

// T-532: the boot validation IS the contract — every embedded pack
// parsed, workflow-valid, unique; the accessors behave.
func TestCatalogBootInvariants(t *testing.T) {
	all := List()
	if len(all) == 0 {
		t.Fatal("the embedded catalog must not be empty")
	}
	seen := map[string]bool{}
	for _, pack := range all {
		if pack.ID == "" || pack.Name == "" || pack.NodeCount == 0 {
			t.Fatalf("pack invariants: %+v", pack)
		}
		if seen[pack.ID] {
			t.Fatalf("duplicate pack id %s", pack.ID)
		}
		seen[pack.ID] = true
		if len(pack.SamplePayloads) == 0 {
			t.Fatalf("pack %s has no sample payloads", pack.ID)
		}
		if got := Get(pack.ID); got == nil || got.ID != pack.ID {
			t.Fatalf("Get(%s) must return the pack", pack.ID)
		}
	}
	if Get("no-such-pack") != nil {
		t.Fatal("unknown id must return nil")
	}
}
