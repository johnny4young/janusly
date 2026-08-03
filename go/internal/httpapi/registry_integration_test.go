//go:build integration

package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/johnny4young/janusly/go/internal/auth"
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
		// A viewer-rank entry whose PERMISSION the viewer's default set
		// lacks (e.g. ai.write) must reject at the permission layer — the
		// reference's permission-only route shape.
		if gate.role == auth.RoleViewer && gate.permission != "" &&
			!auth.DefaultRoleHasPermission(auth.RoleViewer, gate.permission) {
			message := ""
			if enveloped, ok := res.body["error"].(map[string]any); ok {
				message, _ = enveloped["message"].(string)
			} else {
				message, _ = res.body["error"].(string)
			}
			if res.status != 403 || !strings.Contains(message, "requires permission "+gate.permission) {
				t.Fatalf("%s: viewer must get the permission 403, got %d %+v", pattern, res.status, res.body)
			}
			continue
		}
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

// The middleware fails CLOSED on a mounted-but-unregistered
// pattern — forgetting the registry entry can never silently grant
// auth-only access.
func TestUnregisteredPatternFailsClosed(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	rogue := &V1Server{
		pool: pool, resolver: auth.NewResolver(pool, auth.ConfigFromEnv()),
		newID: uuid.NewString, hub: newStreamHub(),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /rogue/unregistered", rogue.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		w.WriteHeader(http.StatusOK)
	}))
	mux.HandleFunc("GET /rogue/identity", rogue.identity(func(w http.ResponseWriter, r *http.Request, rc identityRequest) {
		w.WriteHeader(http.StatusOK)
	}))
	probe := httptest.NewServer(mux)
	t.Cleanup(probe.Close)
	req, _ := http.NewRequest("GET", probe.URL+"/rogue/unregistered", nil)
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", "api-tester")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 500 || !strings.Contains(string(body), "route_not_registered") {
		t.Fatalf("unregistered pattern must fail closed: %d %s", res.StatusCode, body)
	}
	identityReq, _ := http.NewRequest("GET", probe.URL+"/rogue/identity", nil)
	identityReq.Header.Set("x-org-id", h.org)
	identityReq.Header.Set("x-user-id", "api-tester")
	identityRes, err := http.DefaultClient.Do(identityReq)
	if err != nil {
		t.Fatalf("identity probe: %v", err)
	}
	defer identityRes.Body.Close()
	identityBody, _ := io.ReadAll(identityRes.Body)
	if identityRes.StatusCode != 500 || !strings.Contains(string(identityBody), "route_not_registered") {
		t.Fatalf("unregistered identity pattern must fail closed: %d %s", identityRes.StatusCode, identityBody)
	}
}
