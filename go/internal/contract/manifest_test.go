package contract

import "testing"

// The manifest is pure data the generator trusts — every entry
// carries a method, a versioned path, and a response shape; no
// duplicates hide behind reorderings.
func TestManifestInvariants(t *testing.T) {
	if len(Routes) == 0 {
		t.Fatal("the v1 manifest must not be empty")
	}
	seen := map[string]bool{}
	for _, route := range Routes {
		if route.Method == "" || route.Path == "" || route.Summary == "" {
			t.Fatalf("manifest entry incomplete: %+v", route)
		}
		if route.Path[0] != '/' {
			t.Fatalf("path must be absolute: %q", route.Path)
		}
		key := route.Method + " " + route.Path
		if seen[key] {
			t.Fatalf("duplicate manifest entry %s", key)
		}
		seen[key] = true
		if route.Response == nil {
			t.Fatalf("%s has no response shape", key)
		}
	}
}
