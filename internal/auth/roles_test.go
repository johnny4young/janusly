package auth

import "testing"

func TestResolveRoleFromMembershipUsesAlreadyResolvedBuiltin(t *testing.T) {
	role, err := ResolveRoleFromMembership(t.Context(), nil, "org", "editor", ModeSupabase)
	if err != nil {
		t.Fatalf("resolve role: %v", err)
	}
	if role == nil || role.Name != "editor" || role.InheritsFrom != RoleEditor {
		t.Fatalf("unexpected role: %+v", role)
	}
}

func TestResolveRoleFromMembershipKeepsDevOnlyFallback(t *testing.T) {
	role, err := ResolveRoleFromMembership(t.Context(), nil, "org", "", ModeDevHeaders)
	if err != nil {
		t.Fatalf("resolve dev fallback: %v", err)
	}
	if role == nil || role.InheritsFrom != RoleAdmin {
		t.Fatalf("unexpected dev fallback: %+v", role)
	}

	role, err = ResolveRoleFromMembership(t.Context(), nil, "org", "", ModeSupabase)
	if err != nil {
		t.Fatalf("resolve production role: %v", err)
	}
	if role != nil {
		t.Fatalf("provider identity without membership must fail closed: %+v", role)
	}
}
