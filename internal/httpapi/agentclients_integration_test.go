//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestAgentClientRoutesArePeopleOnlyAndShowTheTokenOnce(t *testing.T) {
	t.Setenv("JANUSLY_API_SERVICE_TOKEN", "svc-agent-routes-token")
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	users := map[string]string{"admin": "admin-" + suffix, "editor": "editor-" + suffix,
		"peer": "peer-" + suffix, "viewer": "viewer-" + suffix}
	roles := map[string]string{"admin": "admin", "editor": "editor", "peer": "editor", "viewer": "viewer"}
	for key, user := range users {
		if _, err := pool.Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`,
			"m-"+user, h.org, user, roles[key]); err != nil {
			t.Fatal(err)
		}
	}
	as := func(key string) map[string]string { return map[string]string{"x-user-id": users[key]} }
	body := map[string]any{"name": "Claude Code", "capabilities": []string{"operate"},
		"scope": map[string]any{"tags": []string{"billing"}}, "expiresInDays": 7}

	if res := h.callWithHeaders("POST", "/agent-clients", body, "", as("viewer")); res.status != 403 {
		t.Fatalf("viewer created an agent client: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/agent-clients", body, "", map[string]string{
		"x-user-id": users["editor"], "Authorization": "Bearer svc-agent-routes-token",
	}); res.status != 403 || res.body["code"] != "person_required" {
		t.Fatalf("service token created an agent client: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/agent-clients", map[string]any{"name": "x", "owner": "someone"}, "", as("editor")); res.status != 400 {
		t.Fatalf("unknown body field accepted: %d", res.status)
	}

	created := h.callWithHeaders("POST", "/agent-clients", body, "", as("editor"))
	if created.status != 201 || created.headers.Get("Cache-Control") != "no-store" {
		t.Fatalf("create: %d %v %v", created.status, created.headers, created.body)
	}
	token, _ := created.body["token"].(string)
	client, _ := created.body["client"].(map[string]any)
	if !strings.HasPrefix(token, "jly_agent_") || client == nil || !strings.HasSuffix(token, client["tokenLast4"].(string)) {
		t.Fatalf("create response: %v", created.body)
	}
	if fmt.Sprint(client["capabilities"]) != "[read operate]" || client["status"] != "active" || client["createdBy"] != users["editor"] {
		t.Fatalf("created client view: %v", client)
	}
	clientID := client["id"].(string)

	listed := h.callWithHeaders("GET", "/agent-clients", nil, "", as("viewer"))
	raw, _ := json.Marshal(listed.body)
	if listed.status != 200 || !strings.Contains(string(raw), clientID) ||
		strings.Contains(string(raw), token) || strings.Contains(string(raw), "token\"") || strings.Contains(string(raw), "igest") {
		t.Fatalf("list leaked the token or lost the client: %d %s", listed.status, raw)
	}

	for _, other := range []string{"peer", "admin"} {
		if res := h.callWithHeaders("POST", "/agent-clients/"+clientID+"/rotate", nil, "", as(other)); res.status != 403 || res.body["code"] != "agent_client_not_owned" {
			t.Fatalf("%s rotated someone else's client and would hold its token: %d %v", other, res.status, res.body)
		}
	}
	rotated := h.callWithHeaders("POST", "/agent-clients/"+clientID+"/rotate", map[string]any{"expiresInDays": 3}, "", as("editor"))
	if rotated.status != 200 || rotated.headers.Get("Cache-Control") != "no-store" || rotated.body["token"] == token || !strings.HasPrefix(fmt.Sprint(rotated.body["token"]), "jly_agent_") {
		t.Fatalf("rotate: %d %v", rotated.status, rotated.body)
	}
	if res := h.callWithHeaders("POST", "/agent-clients/"+clientID+"/revoke", nil, "", as("admin")); res.status != 200 ||
		res.body["client"].(map[string]any)["status"] != "revoked" {
		t.Fatalf("admin revoke: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/agent-clients/"+clientID+"/revoke", nil, "", as("editor")); res.status != 409 {
		t.Fatalf("second revoke: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/agent-clients/"+clientID+"/rotate", nil, "", as("editor")); res.status != 409 {
		t.Fatalf("rotating a revoked client: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/agent-clients/"+clientID+"/revoke", nil, "other-org-"+suffix, as("admin")); res.status != 403 && res.status != 404 {
		t.Fatalf("another organization reached the client: %d %v", res.status, res.body)
	}

	var audited int
	var metadata string
	if err := pool.QueryRow(t.Context(), `SELECT count(*), coalesce(string_agg(metadata::text, ' '), '')
		FROM audit_logs WHERE org_id = $1 AND target_id = $2 AND action LIKE 'agent_client.%'`, h.org, clientID).Scan(&audited, &metadata); err != nil {
		t.Fatal(err)
	}
	if audited != 3 || strings.Contains(metadata, "jly_agent_") {
		t.Fatalf("lifecycle audit: %d rows, metadata %s", audited, metadata)
	}
}
