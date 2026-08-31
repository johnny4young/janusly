package auth

import (
	"slices"
	"testing"
)

// The catalog is CLOSED: exactly 41 keys, every default role a built-in,
// and the anchor cases from the contract's own matrix hold.
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

	// Anchor rows against the contract matrix.
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
	viewer := DefaultPermissionsForRole(RoleViewer)
	editor := DefaultPermissionsForRole(RoleEditor)
	if len(viewer) == 0 || len(editor) <= len(viewer) {
		t.Fatalf("effective built-in grants are incomplete: viewer=%v editor=%v", viewer, editor)
	}
	if !DefaultRoleHasPermission(RoleEditor, "workflows.write") || slices.Contains(viewer, "workflows.write") || !slices.Contains(editor, "workflows.write") {
		t.Fatalf("effective built-in grants drifted: viewer=%v editor=%v", viewer, editor)
	}
}

// The self-lockout floor: overriding the built-in admin force-includes the
// two mandatory keys; a custom admin-ranked role is NOT coerced.
func TestCoerceAdminFloor(t *testing.T) {
	merged, coerced := CoerceAdminFloor("admin", []string{"workflows.read"})
	want := map[string]bool{"workflows.read": true, "org.permissions.write": true, "members.write": true}
	if len(merged) != 3 || len(coerced) != 2 {
		t.Fatalf("floor: merged=%v coerced=%v", merged, coerced)
	}
	for _, key := range merged {
		if !want[key] {
			t.Fatalf("unexpected key %q", key)
		}
	}

	// Already present: nothing coerced (idempotent).
	merged, coerced = CoerceAdminFloor("admin", []string{"org.permissions.write", "members.write"})
	if len(coerced) != 0 || len(merged) != 2 {
		t.Fatalf("idempotent floor: %v %v", merged, coerced)
	}

	// billing-admin (custom, admin-ranked) is deliberately untouched.
	merged, coerced = CoerceAdminFloor("billing-admin", []string{"org.config.write"})
	if len(coerced) != 0 || len(merged) != 1 {
		t.Fatalf("custom admin must not be coerced: %v %v", merged, coerced)
	}
}
