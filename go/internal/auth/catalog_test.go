package auth

import "testing"

// The catalog is CLOSED: exactly 41 keys, every default role a built-in,
// and the anchor cases from the reference's own matrix hold.
func TestPermissionCatalogPinned(t *testing.T) {
	if len(PermissionCatalog) != 41 {
		t.Fatalf("catalog must hold exactly 41 keys, got %d", len(PermissionCatalog))
	}
	categories := map[string]bool{}
	for _, entry := range PermissionCatalog {
		if entry.Key == "" || len(entry.DefaultRoles) == 0 {
			t.Fatalf("malformed entry: %+v", entry)
		}
		for role := range entry.DefaultRoles {
			if !IsBuiltinRole(string(role)) {
				t.Fatalf("%s grants a non-built-in role %q", entry.Key, role)
			}
		}
		categories[entry.Category] = true
	}
	if len(categories) != 20 {
		t.Fatalf("20 active categories expected, got %d", len(categories))
	}

	// Anchor rows against the reference matrix.
	anchors := []struct {
		key    string
		role   Role
		expect bool
	}{
		{"workflows.read", RoleViewer, true},
		{"workflows.write", RoleViewer, false},
		{"workflows.write", RoleEditor, true},
		{"runs.start", RoleEditor, true},
		{"runs.cancel", RoleViewer, false},
		{"dlq.replay", RoleEditor, true},
		{"members.write", RoleAdmin, true},
		{"members.write", RoleEditor, false},
		{"org.permissions.write", RoleAdmin, true},
	}
	for _, anchor := range anchors {
		if got := DefaultRoleHasPermission(anchor.role, anchor.key); got != anchor.expect {
			t.Fatalf("%s for %s: got %v want %v", anchor.key, anchor.role, got, anchor.expect)
		}
	}
	if IsPermission("made.up") {
		t.Fatal("unknown keys must not validate")
	}
}
