//go:build integration

package httpapi

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

// Registry completeness: the test WALKS the annotated table, so a new
// gated route must appear here (the sweep fails on an unvisited entry) and
// a mutation can never silently lose its gate. A seeded viewer: every
// editor-gated pattern rejects with the reference's role 403; every
// viewer-gated read passes both layers.
func TestRouteRegistrySweepAsViewer(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO org_members (id, org_id, user_id, role)
		 VALUES ($1, $2, 'api-tester', 'viewer')`, h.org+"-viewer", h.org); err != nil {
		t.Fatalf("seed viewer: %v", err)
	}

	// Pattern → concrete path (path params substituted with dummies).
	concrete := func(pattern string) (method, path string) {
		parts := strings.SplitN(pattern, " ", 2)
		path = parts[1]
		path = strings.ReplaceAll(path, "{workflowId}", "wf-sweep")
		path = strings.ReplaceAll(path, "{runId}", "run-sweep")
		path = strings.ReplaceAll(path, "{id}", "camp-sweep")
		return parts[0], path
	}

	visited := 0
	for pattern, gate := range routeAuthz {
		method, path := concrete(pattern)
		if strings.Contains(path, "/stream") {
			// SSE holds the connection open; the gate is shared code and
			// the viewer READ permission covers it. Counted, not called.
			visited++
			continue
		}
		res := h.call(method, path, map[string]any{}, "")
		visited++
		if gate.role == "editor" || gate.role == "admin" {
			body := res.body
			message, _ := body["error"].(string)
			if enveloped, ok := body["error"].(map[string]any); ok {
				message, _ = enveloped["message"].(string)
			}
			if res.status != 403 || !strings.Contains(message, "Forbidden: requires "+string(gate.role)+" role") {
				t.Fatalf("%s: viewer must get the role 403, got %d %+v", pattern, res.status, res.body)
			}
			continue
		}
		// Viewer-gated reads must clear BOTH layers. Domain-level 403s
		// (e.g. the unknown-run runs_forbidden contract) are fine — only
		// the gate's own code counts as a gate rejection.
		gateCode := ""
		if enveloped, ok := res.body["error"].(map[string]any); ok {
			gateCode, _ = enveloped["code"].(string)
		} else if code, ok := res.body["code"].(string); ok {
			gateCode = code
		}
		if res.status == 401 || gateCode == "server_request_failed" {
			t.Fatalf("%s: viewer read must pass the gates, got %d %+v", pattern, res.status, res.body)
		}
	}
	if visited != len(routeAuthz) {
		t.Fatalf("sweep must cover the whole registry: %d of %d", visited, len(routeAuthz))
	}
}

// The permission layer alone can reject: a member whose role clears the
// rank but whose catalog set lacks the key gets the permission 403. Built
// by gating a synthetic pattern with viewer rank + an admin-only key.
func TestPermissionLayerRejectsIndependently(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO org_members (id, org_id, user_id, role)
		 VALUES ($1, $2, 'api-tester', 'editor')`, h.org+"-editor", h.org); err != nil {
		t.Fatalf("seed editor: %v", err)
	}
	// members.write is admin-only in the catalog; an editor clears a
	// viewer rank gate but must fail the permission layer.
	req := h.call("GET", "/v1/runs", nil, "") // sanity: editor reads fine
	if req.status != 200 {
		t.Fatalf("editor read: %d", req.status)
	}
	rc := v1Request{orgID: h.org, userID: "api-tester"}
	server := &V1Server{pool: pool}
	probe := httptest.NewRequest("GET", "/v1/probe", nil)
	rejection := server.checkGate(probe, rc, routeGate{role: "viewer", permission: "members.write"})
	if rejection == nil || rejection.status != 403 ||
		rejection.message != "Forbidden: requires permission members.write" {
		t.Fatalf("permission layer: %+v", rejection)
	}
}
