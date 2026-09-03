//go:build integration

package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// The roles surface end to end: create ladder, live effect on the gates,
// built-in override with the admin floor, and the delete ladder.
func TestRolesCrudAndOverrides(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()

	// Catalog surface: 41 keys + the mandatory floor.
	catalog := h.call("GET", "/org/permissions/catalog", nil, "")
	if rows := catalog.body["catalog"].([]any); len(rows) != 41 {
		t.Fatalf("catalog: %d", len(rows))
	}
	floor := catalog.body["mandatoryAdminPermissions"].([]any)
	if len(floor) != 2 {
		t.Fatalf("floor: %v", floor)
	}

	// Create ladder: bad name, built-in name, bad permission key, success.
	if res := h.call("POST", "/org/roles", map[string]any{"name": "Bad Name!"}, ""); res.body["code"] != "roles_name_invalid" {
		t.Fatalf("name grammar: %+v", res.body)
	}
	if res := h.call("POST", "/org/roles", map[string]any{"name": "admin"}, ""); res.body["code"] != "roles_builtin_name" {
		t.Fatalf("builtin name: %+v", res.body)
	}
	if res := h.call("POST", "/org/roles", map[string]any{
		"name": "auditor", "grantedPermissions": []any{"made.up"},
	}, ""); res.body["code"] != "roles_permissions_invalid" {
		t.Fatalf("bad key: %+v", res.body)
	}
	created := h.call("POST", "/org/roles", map[string]any{
		"name": "auditor", "inheritsFrom": "viewer",
		"grantedPermissions": []any{"dlq.read", "runs.read"},
	}, "")
	if created.status != 200 || created.body["name"] != "auditor" {
		t.Fatalf("create: %+v", created.body)
	}
	if res := h.call("POST", "/org/roles", map[string]any{"name": "auditor"}, ""); res.status != 409 {
		t.Fatalf("duplicate: %+v", res.body)
	}

	// LIVE effect through the real gates: an auditor member can read the
	// DLQ but NOT the workflows list (override replaces defaults).
	seedMemberRow(t, pool, h.org, "u-auditor", "aud@x.com", "auditor")
	asAuditor := func(method, path string) apiResponse {
		return h.callWithHeaders(method, path, nil, "", map[string]string{"x-user-id": "u-auditor"})
	}
	if res := asAuditor("GET", "/v1/dlq"); res.status != 200 {
		t.Fatalf("auditor dlq read: %d %+v", res.status, res.body)
	}
	denied := asAuditor("GET", "/v1/workflows")
	deniedMessage := ""
	if enveloped, ok := denied.body["error"].(map[string]any); ok {
		deniedMessage, _ = enveloped["message"].(string)
	}
	if denied.status != 403 || !strings.Contains(deniedMessage, "requires permission workflows.read") {
		t.Fatalf("replace semantics through the gate: %d %+v", denied.status, denied.body)
	}

	// Built-in override: inheritsFrom immutable; the admin floor coerces.
	if res := h.call("POST", "/org/roles/admin", map[string]any{"inheritsFrom": "viewer"}, ""); res.body["code"] != "roles_inherits_immutable" {
		t.Fatalf("immutable: %+v", res.body)
	}
	override := h.call("POST", "/org/roles/admin", map[string]any{
		"grantedPermissions": []any{"workflows.read"},
	}, "")
	grants := override.body["grantedPermissions"].([]any)
	if len(grants) != 3 { // workflows.read + the two coerced floor keys
		t.Fatalf("floor must coerce: %v", grants)
	}
	var coercedMeta int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1
		AND action = 'org.permissions.override_set' AND metadata ? 'coerced'`, h.org).Scan(&coercedMeta)
	if coercedMeta != 1 {
		t.Fatalf("coerced keys must audit: %d", coercedMeta)
	}

	// Delete ladder: custom with members → 409 with membersAffected at the
	// top level; delete of the built-in name reverts the override; custom
	// without members deletes.
	inUse := h.call("DELETE", "/org/roles/auditor", nil, "")
	if inUse.status != 409 || inUse.body["code"] != "role_in_use" || inUse.body["membersAffected"] != float64(1) {
		t.Fatalf("role_in_use: %+v", inUse.body)
	}
	reverted := h.call("DELETE", "/org/roles/admin", nil, "")
	if reverted.status != 200 || reverted.body["reverted"] != true {
		t.Fatalf("revert: %+v", reverted.body)
	}
	if res := h.call("DELETE", "/members?userId=u-auditor", nil, ""); res.status != 200 {
		t.Fatalf("remove member: %+v", res.body)
	}
	if res := h.call("DELETE", "/org/roles/auditor", nil, ""); res.status != 200 {
		t.Fatalf("delete after members gone: %+v", res.body)
	}
	if res := h.call("DELETE", "/org/roles/editor", nil, ""); res.status != 404 || res.body["code"] != "roles_override_not_found" {
		t.Fatalf("no-override revert: %+v", res.body)
	}
}

func TestBuiltInRolesReportTheirEffectiveGrant(t *testing.T) {
	h := newAPIHarness(t)

	assertBuiltins := func(stage string) {
		t.Helper()
		res := h.call("GET", "/org/roles", nil, "")
		if res.status != http.StatusOK {
			t.Fatalf("%s list roles: %d %+v", stage, res.status, res.body)
		}
		roles, ok := res.body["roles"].([]any)
		if !ok {
			t.Fatalf("%s roles missing: %+v", stage, res.body)
		}
		seen := map[string][]any{}
		for _, raw := range roles {
			role := raw.(map[string]any)
			if !role["isBuiltin"].(bool) {
				continue
			}
			granted, ok := role["grantedPermissions"].([]any)
			if !ok {
				t.Fatalf("%s built-in %v reported an ambiguous grant: %+v", stage, role["name"], role)
			}
			seen[role["name"].(string)] = granted
		}
		if len(seen["viewer"]) == 0 || len(seen["editor"]) == 0 || len(seen["admin"]) == 0 {
			t.Fatalf("%s built-in defaults missing: %+v", stage, seen)
		}
		contains := func(values []any, key string) bool {
			for _, value := range values {
				if value == key {
					return true
				}
			}
			return false
		}
		if contains(seen["viewer"], "workflows.write") || !contains(seen["editor"], "workflows.write") {
			t.Fatalf("%s built-in grants are not effective defaults: %+v", stage, seen)
		}
	}

	assertBuiltins("virtual")
	// A description-only built-in override persists a null grant. Its read
	// contract must still expose the effective defaults, not an empty set.
	if res := h.call("POST", "/org/roles/editor", map[string]any{"description": "Default editor"}, ""); res.status != http.StatusOK {
		t.Fatalf("create description-only override: %d %+v", res.status, res.body)
	}
	assertBuiltins("null override")
}
