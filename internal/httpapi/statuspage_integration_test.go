//go:build integration

package httpapi

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Public status pages: admin mints an unguessable token, the page reads
// without authentication and shows aggregates only, rotation kills the
// old link, revocation kills the page, and unknown tokens answer a
// uniform 404.
func TestWorkflowStatusPageLifecycle(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-status-" + suffix
	if res := h.call("POST", "/v1/workflows/save", map[string]any{
		"id": wfID, "name": "Refund pipeline " + suffix, "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}, ""); res.status != 200 {
		t.Fatalf("save workflow: %+v", res.body)
	}

	// Disabled by default.
	if res := h.call("GET", "/workflows/"+wfID+"/status-page", nil, ""); res.status != 200 || res.body["enabled"] != false {
		t.Fatalf("default must be disabled: %d %+v", res.status, res.body)
	}

	// Mint. The token is 64 hex chars and the path embeds it.
	minted := h.call("POST", "/workflows/"+wfID+"/status-page", nil, "")
	token, _ := minted.body["token"].(string)
	if minted.status != 200 || len(token) != 64 {
		t.Fatalf("mint: %d %+v", minted.status, minted.body)
	}

	// Another org's admin cannot reach the workflow at all.
	if res := h.call("POST", "/workflows/"+wfID+"/status-page", nil, "org-intruder-"+suffix); res.status != http.StatusNotFound {
		t.Fatalf("cross-org mint must 404, got %d", res.status)
	}

	// Seed one terminal run linked through a saved version so the page
	// has aggregates to show.
	var versionID string
	if err := pool.QueryRow(ctx, `SELECT id FROM workflow_versions
		WHERE org_id = $1 AND workflow_id = $2 ORDER BY version DESC LIMIT 1`, h.org, wfID).Scan(&versionID); err != nil {
		t.Fatalf("version lookup: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
		VALUES ($1, $2, 'succeeded', '{}', $3)`, "run-status-"+suffix, h.org, versionID); err != nil {
		t.Fatalf("seed run: %v", err)
	}

	// The public page needs NO auth headers and shows name + aggregates,
	// never run ids.
	fetch := func(tok string) (int, string) {
		res, err := http.Get(h.server.URL + "/public/status/" + tok)
		if err != nil {
			t.Fatalf("public fetch: %v", err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(raw)
	}
	status, page := fetch(token)
	if status != 200 || !strings.Contains(page, "Refund pipeline "+suffix) {
		t.Fatalf("public page: %d %.200s", status, page)
	}
	if !strings.Contains(page, "Operational") {
		t.Fatalf("one success must read operational: %.300s", page)
	}
	if strings.Contains(page, "run-status-"+suffix) || strings.Contains(page, h.org) {
		t.Fatal("the public page must not leak run ids or tenant ids")
	}

	// Unknown / malformed tokens: uniform 404.
	if status, _ := fetch(strings.Repeat("0", 64)); status != http.StatusNotFound {
		t.Fatalf("unknown token must 404, got %d", status)
	}
	if status, _ := fetch(strings.Repeat("z", 64)); status != http.StatusNotFound {
		t.Fatalf("non-hex token must 404, got %d", status)
	}
	if status, _ := fetch("abc123"); status != http.StatusNotFound {
		t.Fatalf("short token must 404, got %d", status)
	}

	// Rotation invalidates the old link.
	rotated := h.call("POST", "/workflows/"+wfID+"/status-page", nil, "")
	newToken, _ := rotated.body["token"].(string)
	if newToken == token {
		t.Fatal("rotation must change the token")
	}
	if status, _ := fetch(token); status != http.StatusNotFound {
		t.Fatalf("rotated-away token must die, got %d", status)
	}

	// Revocation kills the page and the admin read reports disabled.
	if res := h.call("DELETE", "/workflows/"+wfID+"/status-page", nil, ""); res.status != 200 {
		t.Fatalf("revoke: %d %+v", res.status, res.body)
	}
	if status, _ := fetch(newToken); status != http.StatusNotFound {
		t.Fatalf("revoked page must 404, got %d", status)
	}
	if res := h.call("GET", "/workflows/"+wfID+"/status-page", nil, ""); res.body["enabled"] != false {
		t.Fatalf("after revoke: %+v", res.body)
	}
}
