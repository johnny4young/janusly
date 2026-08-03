//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/auth"
)

// Security review, executable half.

// The editor sweep completes the per-rank authz matrix (the viewer sweep
// covers the bottom rank): every admin-gated pattern rejects an editor
// with the role 403; editor/viewer patterns pass the rank layer and only
// reject when the PERMISSION sits outside the editor default set.
func TestRouteRegistrySweepAsEditor(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO org_members (id, org_id, user_id, role)
		 VALUES ($1, $2, 'api-tester', 'editor')`, h.org+"-editor", h.org); err != nil {
		t.Fatalf("seed editor: %v", err)
	}
	concrete := func(pattern string) (method, path string) {
		parts := strings.SplitN(pattern, " ", 2)
		path = parts[1]
		for _, pair := range [][2]string{
			{"{workflowId}", "wf-sweep"}, {"{runId}", "run-sweep"}, {"{id}", "sweep-id"},
			{"{name}", "sweep-name"}, {"{alias}", "sweep-alias"}, {"{toolName}", "sweep-tool"},
			{"{version}", "1"}, {"{rolloutId}", "ro-sweep"}, {"{decision}", "promote"},
			{"{action}", "acknowledge"},
		} {
			path = strings.ReplaceAll(path, pair[0], pair[1])
		}
		return parts[0], path
	}
	message := func(res apiResponse) string {
		if enveloped, ok := res.body["error"].(map[string]any); ok {
			text, _ := enveloped["message"].(string)
			return text
		}
		text, _ := res.body["error"].(string)
		return text
	}
	visited := 0
	for pattern, gate := range routeAuthz {
		method, path := concrete(pattern)
		visited++
		if strings.Contains(path, "/stream") {
			continue // SSE holds the connection; shared gate code covers it
		}
		res := h.call(method, path, map[string]any{}, "")
		switch {
		case gate.role == auth.RoleAdmin:
			if res.status != 403 || !strings.Contains(message(res), "requires admin role") {
				t.Fatalf("%s: editor must get the admin 403, got %d %+v", pattern, res.status, res.body)
			}
		case gate.permission != "" && !auth.DefaultRoleHasPermission(auth.RoleEditor, gate.permission):
			if res.status != 403 || !strings.Contains(message(res), "requires permission "+gate.permission) {
				t.Fatalf("%s: editor must get the permission 403, got %d %+v", pattern, res.status, res.body)
			}
		default:
			// Both layers must clear; only domain-level outcomes remain.
			if res.status == 401 || strings.Contains(message(res), "Forbidden: requires") {
				t.Fatalf("%s: editor must pass the gates, got %d %+v", pattern, res.status, res.body)
			}
		}
	}
	if visited != len(routeAuthz) {
		t.Fatalf("sweep must cover the whole registry: %d of %d", visited, len(routeAuthz))
	}
}

// End-to-end scrub: a secret-shaped value planted in node config and run
// input must NEVER surface through the read surfaces — run detail, DLQ
// detail (which carries the exact failed snapshots for replay), the DLQ
// list, or the audit trail. Key-redaction happens at the persistence
// chokepoint; this test reads the WIRE, not the tables.
func TestSecretScrubEndToEnd(t *testing.T) {
	h := newAPIHarness(t)
	secret := "sk-abcdefghijklmnopqrstuvwxyz0123456789"
	suffix := fmt.Sprint(time.Now().UnixNano())

	workflow := map[string]any{
		"id": "scrub-" + suffix, "name": "Scrub e2e", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "boom", "type": "http", "config": map[string]any{
				"url":     "http://127.0.0.1:1/unreachable",
				"headers": map[string]any{"authorization": "Bearer " + secret},
				"apiKey":  secret,
				"retry":   map[string]any{"maxAttempts": 1},
			}},
		},
		"edges": []any{},
	}
	res := h.call("POST", "/start", map[string]any{
		"workflow": workflow,
		"input":    map[string]any{"password": secret, "note": "plain"},
	}, "")
	if res.status != 200 {
		t.Fatalf("start: %d %+v", res.status, res.body)
	}
	runID := res.body["runId"].(string)
	h.waitRun(runID, "failed")

	fetchRaw := func(path string) string {
		t.Helper()
		req, _ := http.NewRequest("GET", h.server.URL+path, nil)
		req.Header.Set("x-org-id", h.org)
		req.Header.Set("x-user-id", "api-tester")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("fetch %s: %v", path, err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		return string(raw)
	}

	deadline := time.Now().Add(10 * time.Second)
	deadLetterID := ""
	for deadLetterID == "" {
		list := h.call("GET", "/v1/dlq", nil, "")
		if rows, ok := list.body["data"].([]any); ok && len(rows) > 0 {
			deadLetterID = rows[0].(map[string]any)["id"].(string)
		}
		if time.Now().After(deadline) {
			t.Fatal("dead letter never landed")
		}
		time.Sleep(100 * time.Millisecond)
	}

	// The chokepoint-covered surfaces (dead-letter snapshots, node
	// state/error, audit metadata) must never carry the raw value. NOTE the
	// deliberate exception, shared with the reference: `runs.inputJson` is
	// NOT in the safe-persist chokepoint — a hardcoded secret in node
	// config persists verbatim there (replay needs the doc). The sanctioned
	// posture is `{{secret.X}}` templates plus the production readiness
	// gate, asserted below; the residual risk is documented in
	// SECURITY-REVIEW.md and flagged to the reference repo.
	surfaces := map[string]string{
		"dlq list":   fetchRaw("/v1/dlq"),
		"dlq detail": fetchRaw("/dlq?id=" + deadLetterID),
		"audit":      fetchRaw("/audit?limit=100"),
	}
	for name, body := range surfaces {
		if strings.Contains(body, secret) {
			t.Fatalf("%s leaks the planted secret", name)
		}
	}
	// Positive control: redaction happened (the keys exist, values masked),
	// and non-sensitive content survives.
	if !strings.Contains(surfaces["dlq detail"], "[redacted]") {
		t.Fatalf("dlq detail must carry redaction sentinels: %s", surfaces["dlq detail"][:min(400, len(surfaces["dlq detail"]))])
	}
	if !strings.Contains(fetchRaw("/v1/run?runId="+runID), "plain") {
		t.Fatal("non-sensitive input must survive")
	}

	// The REAL defense for hardcoded secrets: production mode refuses to
	// start the workflow at all (readiness rule: secret-shaped field
	// values must be {{secret.X}} / {{env.X}} references).
	t.Setenv("JANUSLY_PRODUCTION_MODE", "true")
	res = h.call("POST", "/start", map[string]any{"workflow": workflow}, "")
	if res.status != 422 {
		t.Fatalf("production mode must reject hardcoded secrets: %d %+v", res.status, res.body)
	}
}
