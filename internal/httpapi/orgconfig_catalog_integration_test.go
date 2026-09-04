//go:build integration

package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/orgconfig"
)

// The closed catalog and the config surface end to end: layered GET with
// provenance, the validation ladder on POST (unknown key, type, range,
// enum, secret-shaped value), tenant-layer precedence after a write, and
// the admin gate.
//
// The count is a ratchet, not a ceiling. The Go baseline carried 69 reference
// keys plus run-event archival and weekly digest, then retired four controls
// that did not represent executable capabilities: provider selection,
// generation mode, the retired alternate-provider model, and the unused per-surface model map;
// governed agent-write consent adds one real executable control; the fictitious
// embedding-provider selector was then retired because only Ollama's protocol
// is implemented. Dead-letter retention adds one real executable control.
func TestOrgConfigCatalogSurface(t *testing.T) {
	if len(orgconfig.Definitions) != 68 {
		t.Fatalf("catalog must pin at 68 definitions, got %d", len(orgconfig.Definitions))
	}
	for _, key := range []string{"ai.anthropic.model", "http.timeoutMs", "runs.requireSavedWorkflow",
		"mcp.writeConsent", "retention.deletedWorkflowsDays", "onboarding.enabled"} {
		if orgconfig.Get(key) == nil {
			t.Fatalf("expected reference key missing: %s", key)
		}
	}
	if orgconfig.Get("memory.embeddingProvider") != nil {
		t.Fatal("catalog must not advertise an embedding provider the runtime cannot speak")
	}
	// The catalog itself must never admit a credential-shaped name.
	for _, def := range orgconfig.Definitions {
		if orgconfig.ForbiddenNamePattern.MatchString(def.Key) {
			t.Fatalf("catalog key looks like a credential: %s", def.Key)
		}
	}

	h := newAPIHarness(t)
	pool := testPool(t)

	// Fresh org: the full catalog with default/env provenance, no tenant rows.
	fresh := h.call("GET", "/org/config", nil, "")
	entries := fresh.body["config"].([]any)
	if len(entries) != len(orgconfig.Definitions) {
		t.Fatalf("GET must list the full catalog: %d", len(entries))
	}
	for _, raw := range entries {
		entry := raw.(map[string]any)
		if entry["source"] == "tenant" {
			t.Fatalf("fresh org cannot have tenant rows: %+v", entry)
		}
	}

	// Validation ladder.
	reject := func(body map[string]any, wantFragment string) {
		t.Helper()
		res := h.call("POST", "/org/config", body, "")
		if res.status != 400 {
			t.Fatalf("must 400: %+v", res.body)
		}
		message, _ := res.body["error"].(string)
		if !strings.Contains(message, wantFragment) {
			t.Fatalf("message %q must carry %q", message, wantFragment)
		}
	}
	reject(map[string]any{"key": "made.up", "value": 1}, "Unknown org config key")
	reject(map[string]any{"key": "http.timeoutMs", "value": "fast"}, "must be a finite number")
	reject(map[string]any{"key": "http.timeoutMs", "value": float64(0)}, "must be >=")
	reject(map[string]any{"key": "email.provider", "value": "grok"}, "must be one of")
	reject(map[string]any{"key": "email.from", "value": "sk-ant-secret123"}, "must not contain secret-like values")
	reject(map[string]any{"key": "email.provider", "value": "   "}, "non-empty")

	// A valid write lands as the tenant layer and audits.
	ok := h.call("POST", "/org/config", map[string]any{"key": "http.timeoutMs", "value": float64(5000)}, "")
	if ok.status != 200 || ok.body["source"] != "tenant" || ok.body["value"] != float64(5000) {
		t.Fatalf("upsert: %+v", ok.body)
	}
	after := h.call("GET", "/org/config", nil, "")
	var seen bool
	for _, raw := range after.body["config"].([]any) {
		entry := raw.(map[string]any)
		if entry["key"] == "http.timeoutMs" {
			seen = true
			if entry["value"] != float64(5000) || entry["source"] != "tenant" || entry["updatedAt"] == nil {
				t.Fatalf("tenant layer must win with provenance: %+v", entry)
			}
		}
	}
	if !seen {
		t.Fatal("updated key missing from list")
	}
	var audited int
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'org.config.updated'
		  AND metadata @> '{"key":"http.timeoutMs"}'`, h.org).Scan(&audited)
	if audited != 1 {
		t.Fatalf("config update must audit: %d", audited)
	}

	// Idempotent re-write updates in place (the (org,key) unique holds).
	if res := h.call("POST", "/org/config", map[string]any{"key": "http.timeoutMs", "value": float64(6000)}, ""); res.status != 200 {
		t.Fatalf("re-upsert: %+v", res.body)
	}
	var rows int
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM org_configs
		WHERE org_id = $1 AND key = 'http.timeoutMs'`, h.org).Scan(&rows)
	if rows != 1 {
		t.Fatalf("upsert must keep one row: %d", rows)
	}

	// The write gate is admin; a viewer still READS effective settings.
	seedMemberRow(t, pool, h.org, "u-cfg-viewer", "cfg@x.com", "viewer")
	viewerHeaders := map[string]string{"x-user-id": "u-cfg-viewer"}
	if res := h.callWithHeaders("GET", "/org/config", nil, "", viewerHeaders); res.status != 200 {
		t.Fatalf("viewer read: %d", res.status)
	}
	if res := h.callWithHeaders("POST", "/org/config", map[string]any{
		"key": "http.timeoutMs", "value": float64(1000),
	}, "", viewerHeaders); res.status != 403 {
		t.Fatalf("viewer write must 403: %d %+v", res.status, res.body)
	}
}

func TestMemoryConsentTransitionSchedulesPurgeAndAudits(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	h := newAPIHarness(t)
	pool := testPool(t)

	if res := h.call("POST", "/org/config", map[string]any{
		"key": "memory.enabled", "value": true,
	}, ""); res.status != 200 {
		t.Fatalf("grant memory consent: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/org/config", map[string]any{
		"key": "memory.enabled", "value": false,
	}, ""); res.status != 200 {
		t.Fatalf("revoke memory consent: %d %+v", res.status, res.body)
	}

	status := h.call("GET", "/memory/consent-status", nil, "")
	purge, ok := status.body["purge"].(map[string]any)
	if status.status != 200 || status.body["tenantEnabled"] != false || !ok || purge["status"] != "scheduled" {
		t.Fatalf("revocation must expose a scheduled purge: %d %+v", status.status, status.body)
	}
	scheduledFor, ok := purge["scheduledFor"].(string)
	if !ok {
		t.Fatalf("scheduled purge needs a deadline: %+v", purge)
	}
	deadline, err := time.Parse(time.RFC3339, scheduledFor)
	if err != nil || !deadline.After(time.Now()) {
		t.Fatalf("scheduled deadline must be future RFC3339: %q %v", scheduledFor, err)
	}

	for _, transition := range []struct {
		action         string
		previous, next bool
	}{
		{"memory.consent.granted", false, true},
		{"memory.consent.revoked", true, false},
	} {
		var count int
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
			WHERE org_id = $1 AND action = $2 AND target_type = 'org_config'
			  AND target_id = 'memory.enabled'
			  AND metadata @> jsonb_build_object('previousValue', $3::boolean, 'newValue', $4::boolean)`,
			h.org, transition.action, transition.previous, transition.next).Scan(&count); err != nil || count != 1 {
			t.Fatalf("%s audit: count=%d err=%v", transition.action, count, err)
		}
	}

	if res := h.call("POST", "/org/config", map[string]any{
		"key": "memory.enabled", "value": true,
	}, ""); res.status != 200 {
		t.Fatalf("re-grant memory consent: %d %+v", res.status, res.body)
	}
	status = h.call("GET", "/memory/consent-status", nil, "")
	purge, _ = status.body["purge"].(map[string]any)
	if status.body["tenantEnabled"] != true || purge["status"] != "none" {
		t.Fatalf("re-grant must cancel due-clock purge: %+v", status.body)
	}
	var cancelled int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'memory.consent.granted'
		  AND metadata @> '{"previousValue":false,"newValue":true,"pendingPurgeCancelled":true}'::jsonb`,
		h.org).Scan(&cancelled); err != nil || cancelled != 1 {
		t.Fatalf("grant audits must record due-clock cancellation: count=%d err=%v", cancelled, err)
	}
	var noPending int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'memory.consent.granted'
		  AND metadata @> '{"previousValue":false,"newValue":true,"pendingPurgeCancelled":false}'::jsonb`,
		h.org).Scan(&noPending); err != nil || noPending != 1 {
		t.Fatalf("initial grant must not invent a pending purge: count=%d err=%v", noPending, err)
	}
}

// Layer precedence for one key, driven through the pure resolver: tenant
// row wins, invalid tenant row falls to env, invalid env falls to default.
func TestOrgConfigLayerPrecedence(t *testing.T) {
	env := func(overrides map[string]string) func(string) (string, bool) {
		return func(key string) (string, bool) { v, ok := overrides[key]; return v, ok }
	}
	rows := map[string][]byte{"http.timeoutMs": []byte("2000")}
	value, source := orgconfig.ResolveValue("http.timeoutMs",
		rawMap(rows), env(map[string]string{"JANUSLY_HTTP_TIMEOUT_MS": "9000"}))
	if value != float64(2000) || source != "tenant" {
		t.Fatalf("tenant layer must win: %v %s", value, source)
	}
	// Below-minimum tenant row falls through to env.
	rows["http.timeoutMs"] = []byte("0")
	value, source = orgconfig.ResolveValue("http.timeoutMs",
		rawMap(rows), env(map[string]string{"JANUSLY_HTTP_TIMEOUT_MS": "9000"}))
	if value != float64(9000) || source != "env" {
		t.Fatalf("invalid row must fall to env: %v %s", value, source)
	}
	// Malformed env falls through to the catalog default.
	value, source = orgconfig.ResolveValue("http.timeoutMs",
		rawMap(rows), env(map[string]string{"JANUSLY_HTTP_TIMEOUT_MS": "soon"}))
	if value != float64(30000) || source != "default" {
		t.Fatalf("invalid env must fall to default: %v %s", value, source)
	}
}

func rawMap(rows map[string][]byte) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(rows))
	for k, v := range rows {
		out[k] = json.RawMessage(v)
	}
	return out
}
