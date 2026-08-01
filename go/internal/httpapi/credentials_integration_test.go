//go:build integration

package httpapi

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/secretstore"
)

// The credential loop by wire: create (managed + legacy), the no-echo
// projection, blast-radius preview, rotation under ifMatch CAS with old
// version revoked, expiry set/clear, delete, and the health snapshot —
// with the secret value never appearing in any response.
func TestCredentialRoutes(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	suffix := fmt.Sprint(time.Now().UnixNano())
	secretValue := "sk-live-NEVER-ON-THE-WIRE-" + suffix

	// Validation ladder: missing fields, both sources, bad env name, past expiry.
	if res := h.call("POST", "/credentials", map[string]any{"name": "x"}, ""); res.status != 400 {
		t.Fatalf("missing kind must 400: %d", res.status)
	}
	if res := h.call("POST", "/credentials", map[string]any{
		"name": "x", "kind": "http", "secretValue": "v", "secretRef": "REF",
	}, ""); res.status != 400 || res.body["code"] != "credentials_fields_required" {
		t.Fatalf("both sources must 400: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/credentials", map[string]any{
		"name": "x", "kind": "http", "secretRef": "not a var!",
	}, ""); res.status != 400 || res.body["code"] != "credentials_invalid_secret_ref" {
		t.Fatalf("bad env name must 400: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/credentials", map[string]any{
		"name": "x", "kind": "http", "secretValue": "v", "expiresAt": "2000-01-01T00:00:00Z",
	}, ""); res.status != 400 || res.body["code"] != "credentials_invalid_expiry" {
		t.Fatalf("past expiry must 400: %d %+v", res.status, res.body)
	}

	// Managed + legacy create; duplicate name → 409.
	res := h.call("POST", "/credentials", map[string]any{
		"name": "api-token", "kind": "http", "secretValue": secretValue,
	}, "")
	if res.status != 200 {
		t.Fatalf("create managed: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/credentials", map[string]any{
		"name": "legacy-token", "kind": "http", "secretRef": "LEGACY_ENV_NAME",
	}, ""); res.status != 200 {
		t.Fatalf("create legacy: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/credentials", map[string]any{
		"name": "api-token", "kind": "http", "secretValue": "other",
	}, ""); res.status != 409 {
		t.Fatalf("duplicate name must 409: %d", res.status)
	}

	// The list NEVER echoes refs or values — storage bit only.
	_, rawList := h.rawGet(t, "/credentials")
	listBody := string(rawList)
	if strings.Contains(listBody, secretValue) || strings.Contains(listBody, "LEGACY_ENV_NAME") ||
		strings.Contains(listBody, "janusly-secret://") {
		t.Fatalf("list leaked secret material: %s", listBody)
	}
	if !strings.Contains(listBody, `"storage":"managed"`) || !strings.Contains(listBody, `"storage":"environment"`) {
		t.Fatalf("storage projection missing: %s", listBody)
	}

	// A workflow referencing the credential feeds the blast radius.
	wfID := "wf-cred-" + suffix
	_ = h.call("POST", "/workflows/save", map[string]any{
		"id": wfID, "name": "Cred", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "tool", "config": map[string]any{
			"tool": "text.uppercase", "credential": "api-token", "input": map[string]any{"value": "x"},
		}}},
		"edges": []any{},
	}, "")
	res = h.call("POST", "/credentials/api-token/bulk-update", map[string]any{"dryRun": true}, "")
	if res.status != 200 || res.body["affectedCount"] != float64(1) {
		t.Fatalf("preview: %d %+v", res.status, res.body)
	}
	ifMatch := res.body["updatedAt"].(string)

	// Rotation: no ifMatch → 400; stale → 409; good token swaps the ref
	// and REVOKES the prior version.
	var oldRef string
	_ = pool.QueryRow(ctx, `SELECT secret_ref FROM credentials WHERE org_id = $1 AND name = 'api-token'`,
		h.org).Scan(&oldRef)
	if res = h.call("POST", "/credentials/api-token/bulk-update", map[string]any{
		"newSecretValue": "rotated-" + suffix,
	}, ""); res.status != 400 || res.body["code"] != "credentials_if_match_required" {
		t.Fatalf("missing ifMatch: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/credentials/api-token/bulk-update", map[string]any{
		"newSecretValue": "rotated-" + suffix, "ifMatch": "2001-01-01T00:00:00Z",
	}, ""); res.status != 409 {
		t.Fatalf("stale ifMatch must 409: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/credentials/api-token/bulk-update", map[string]any{
		"newSecretValue": "rotated-" + suffix, "ifMatch": ifMatch,
	}, ""); res.status != 200 || res.body["affectedCount"] != float64(1) {
		t.Fatalf("rotate: %d %+v", res.status, res.body)
	}
	var revokedAt *time.Time
	rowID := secretstore.ParseCredentialSecretRef(oldRef)
	_ = pool.QueryRow(ctx, `SELECT revoked_at FROM credential_secret_versions WHERE id = $1`, rowID).Scan(&revokedAt)
	if revokedAt == nil {
		t.Fatal("rotation must revoke the prior version")
	}

	// Expiry: omitted field refused; set then clear explicitly.
	if res = h.call("POST", "/credentials/api-token/expiry", map[string]any{}, ""); res.status != 400 ||
		res.body["code"] != "credentials_expiry_required" {
		t.Fatalf("omitted expiry must 400: %d %+v", res.status, res.body)
	}
	future := time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	if res = h.call("POST", "/credentials/api-token/expiry", map[string]any{"expiresAt": future}, ""); res.status != 200 {
		t.Fatalf("set expiry: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/credentials/api-token/expiry", map[string]any{"expiresAt": nil}, ""); res.status != 200 ||
		res.body["expiresAt"] != nil {
		t.Fatalf("clear expiry: %d %+v", res.status, res.body)
	}

	// Health: the managed credential resolves, references listed; no refs echoed.
	res = h.call("GET", "/credentials/health", nil, "")
	if res.status != 200 {
		t.Fatalf("health: %d", res.status)
	}
	healthEntries := res.body["credentials"].([]any)
	var apiTokenEntry map[string]any
	for _, raw := range healthEntries {
		entry := raw.(map[string]any)
		if entry["name"] == "api-token" {
			apiTokenEntry = entry
		}
	}
	if apiTokenEntry == nil || apiTokenEntry["secretRefPresent"] != true {
		t.Fatalf("health entry: %+v", apiTokenEntry)
	}
	refs := apiTokenEntry["referencingWorkflowIds"].([]any)
	if len(refs) != 1 || refs[0] != wfID {
		t.Fatalf("health references: %+v", refs)
	}

	// Delete revokes the current version and 404s the second time.
	var currentRef string
	_ = pool.QueryRow(ctx, `SELECT secret_ref FROM credentials WHERE org_id = $1 AND name = 'api-token'`,
		h.org).Scan(&currentRef)
	if res = h.call("DELETE", "/credentials/api-token", nil, ""); res.status != 200 {
		t.Fatalf("delete: %d %+v", res.status, res.body)
	}
	if res = h.call("DELETE", "/credentials/api-token", nil, ""); res.status != 404 {
		t.Fatalf("double delete must 404: %d", res.status)
	}
	var currentRevoked *time.Time
	_ = pool.QueryRow(ctx, `SELECT revoked_at FROM credential_secret_versions WHERE id = $1`,
		secretstore.ParseCredentialSecretRef(currentRef)).Scan(&currentRevoked)
	if currentRevoked == nil {
		t.Fatal("delete must revoke the managed version")
	}

	// Audit trail: created ×2 + bulk_updated + expiry ×2 + revoked.
	var audits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action LIKE 'credential.%'`,
		h.org).Scan(&audits)
	if audits < 6 {
		t.Fatalf("credential audits: %d", audits)
	}
}

// T-161: the readiness badge surfaces credential_missing warns from the
// same org-aware resolver — missing row, unresolvable secret, missing
// MCP alias — and a registered+resolvable credential clears them.
func TestCredentialReadiness(t *testing.T) {
	h := newAPIHarness(t)
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	suffix := fmt.Sprint(time.Now().UnixNano())

	workflowDoc := map[string]any{
		"id": "wf-ready-" + suffix, "name": "Ready", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "call", "type": "tool", "config": map[string]any{
				"tool": "text.uppercase", "credential": "missing-cred", "input": map[string]any{"value": "x"},
			}},
			map[string]any{"id": "mcp", "type": "mcp_tool", "config": map[string]any{
				"connectionAlias": "ghost-alias", "tool": "x",
			}},
		},
		"edges": []any{map[string]any{"from": "call", "to": "mcp"}},
	}
	issuesFor := func() []any {
		res := h.call("POST", "/workflows/readiness", map[string]any{"workflow": workflowDoc}, "")
		if res.status != 200 {
			t.Fatalf("readiness: %d %+v", res.status, res.body)
		}
		return res.body["issues"].([]any)
	}
	countCredentialMissing := func(issues []any) int {
		count := 0
		for _, raw := range issues {
			if raw.(map[string]any)["code"] == "credential_missing" {
				count++
			}
		}
		return count
	}
	// Missing credential row + missing MCP alias → two warns.
	firstIssues := issuesFor()
	if got := countCredentialMissing(firstIssues); got != 2 {
		t.Fatalf("expected 2 credential_missing, got %d: %+v", got, firstIssues)
	}
	// Registered but UNRESOLVABLE (legacy env ref not set) → still warns.
	if res := h.call("POST", "/credentials", map[string]any{
		"name": "missing-cred", "kind": "http", "secretRef": "UNSET_ENV_" + suffix,
	}, ""); res.status != 200 {
		t.Fatalf("register: %d", res.status)
	}
	if got := countCredentialMissing(issuesFor()); got != 2 {
		t.Fatalf("unresolvable ref must still warn: %d", got)
	}
	// Resolvable managed value clears the credential warn (alias remains).
	ifMatchRes := h.call("POST", "/credentials/missing-cred/bulk-update", map[string]any{"dryRun": true}, "")
	if res := h.call("POST", "/credentials/missing-cred/bulk-update", map[string]any{
		"newSecretValue": "resolves-now", "ifMatch": ifMatchRes.body["updatedAt"],
	}, ""); res.status != 200 {
		t.Fatalf("rotate to managed: %d %+v", res.status, res.body)
	}
	if got := countCredentialMissing(issuesFor()); got != 1 {
		t.Fatalf("resolvable credential must clear its warn: %d", got)
	}
}
