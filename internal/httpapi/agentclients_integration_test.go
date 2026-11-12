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

func seedAgentClientCreator(t *testing.T, h *apiHarness, role string) map[string]string {
	t.Helper()
	user := fmt.Sprintf("%s-%d", role, time.Now().UnixNano())
	if _, err := testPool(t).Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`,
		"m-"+user, h.org, user, role); err != nil {
		t.Fatal(err)
	}
	return map[string]string{"x-user-id": user}
}

// Rotation never revives an expired client: its token and expiry stay as they were.
func TestAgentClientRotationRefusesAnExpiredClient(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	as := seedAgentClientCreator(t, h, "editor")
	created := h.callWithHeaders("POST", "/agent-clients", map[string]any{"name": "expired", "capabilities": []string{"read"}}, "", as)
	if created.status != 201 {
		t.Fatalf("create: %d %v", created.status, created.body)
	}
	clientID := created.body["client"].(map[string]any)["id"].(string)
	pool := testPool(t)
	if _, err := pool.Exec(t.Context(), `UPDATE agent_clients SET token_issued_at = now() - interval '10 days',
		expires_at = now() - interval '1 day' WHERE org_id = $1 AND id = $2`, h.org, clientID); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err := pool.QueryRow(t.Context(), `SELECT expires_at FROM agent_clients WHERE id = $1`, clientID).Scan(&before); err != nil {
		t.Fatal(err)
	}

	rotated := h.callWithHeaders("POST", "/agent-clients/"+clientID+"/rotate", map[string]any{"expiresInDays": 30}, "", as)
	if rotated.status != 409 || rotated.body["code"] != "agent_client_expired" || rotated.body["token"] != nil {
		t.Fatalf("rotating an expired client: %d %v", rotated.status, rotated.body)
	}
	var after time.Time
	if err := pool.QueryRow(t.Context(), `SELECT expires_at FROM agent_clients WHERE id = $1`, clientID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !after.Equal(before) {
		t.Fatalf("a refused rotation moved the expiry: %s -> %s", before, after)
	}
}

// The client list pages by an opaque cursor, newest first.
func TestAgentClientListPagesByCursor(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	as := seedAgentClientCreator(t, h, "editor")
	var ids []string
	for i := range 3 {
		created := h.callWithHeaders("POST", "/agent-clients", map[string]any{"name": fmt.Sprintf("client %d", i), "capabilities": []string{"read"}}, "", as)
		if created.status != 201 {
			t.Fatalf("create %d: %d %v", i, created.status, created.body)
		}
		ids = append(ids, created.body["client"].(map[string]any)["id"].(string))
	}
	page := func(query string) ([]string, any) {
		t.Helper()
		res := h.callWithHeaders("GET", "/agent-clients"+query, nil, "", as)
		if res.status != 200 {
			t.Fatalf("list %s: %d %v", query, res.status, res.body)
		}
		var got []string
		for _, client := range res.body["clients"].([]any) {
			got = append(got, client.(map[string]any)["id"].(string))
		}
		return got, res.body["nextCursor"]
	}

	first, cursor := page("?limit=2")
	if fmt.Sprint(first) != fmt.Sprint([]string{ids[2], ids[1]}) {
		t.Fatalf("first page: %v, want %v", first, []string{ids[2], ids[1]})
	}
	next, ok := cursor.(string)
	if !ok || next == "" || strings.Contains(next, ids[1]) {
		t.Fatalf("first page cursor must be opaque: %v", cursor)
	}
	second, end := page("?limit=2&cursor=" + next)
	if fmt.Sprint(second) != fmt.Sprint([]string{ids[0]}) || end != nil {
		t.Fatalf("second page: %v next=%v", second, end)
	}
	if all, more := page(""); len(all) != 3 || more != nil {
		t.Fatalf("default page: %v next=%v", all, more)
	}
	for _, bad := range []string{"?cursor=not-a-cursor", "?limit=0", "?limit=abc"} {
		if res := h.callWithHeaders("GET", "/agent-clients"+bad, nil, "", as); res.status != 400 {
			t.Fatalf("list %s: %d %v", bad, res.status, res.body)
		}
	}
}

// The list says what the caller could grant and whether each creator still
// stands behind their client; the detail stays inside the organization and
// shows only this client's calls and requests.
func TestAgentClientListAndDetailFollowTheCreator(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	editor := seedAgentClientCreator(t, h, "editor")
	viewer := seedAgentClientCreator(t, h, "viewer")
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(t.Context(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	create := func(name string, capabilities ...string) string {
		t.Helper()
		res := h.callWithHeaders("POST", "/v1/agent-clients", map[string]any{"name": name, "capabilities": capabilities}, "", editor)
		if res.status != 201 {
			t.Fatalf("create %s: %d %v", name, res.status, res.body)
		}
		return res.body["data"].(map[string]any)["client"].(map[string]any)["id"].(string)
	}
	kept, demoted, removed := create("kept", "read"), create("demoted", "propose"), create("removed", "read")
	other := create("other", "read")
	exec(`UPDATE agent_clients SET created_by = $3 WHERE org_id = $1 AND id = $2`, h.org, demoted, viewer["x-user-id"])
	exec(`UPDATE agent_clients SET created_by = 'left-the-org' WHERE org_id = $1 AND id = $2`, h.org, removed)

	listed := h.callWithHeaders("GET", "/v1/agent-clients", nil, "", viewer)
	if listed.status != 200 {
		t.Fatalf("viewer list: %d %v", listed.status, listed.body)
	}
	data := listed.body["data"].(map[string]any)
	for _, raw := range data["capabilities"].([]any) {
		entry := raw.(map[string]any)
		if entry["name"] == "propose" && (entry["grantable"] != false || fmt.Sprint(entry["missingPermissions"]) != "[workflows.write]") {
			t.Fatalf("a viewer must see why propose is not grantable: %v", entry)
		}
		if entry["name"] == "read" && entry["grantable"] != true {
			t.Fatalf("a viewer holds every read permission: %v", entry)
		}
	}
	states := map[string]string{}
	for _, raw := range data["clients"].([]any) {
		client := raw.(map[string]any)
		access := client["creatorAccess"].(map[string]any)
		states[client["id"].(string)] = fmt.Sprint(access["state"], " ", access["missingPermissions"])
	}
	if states[kept] != "member []" || states[demoted] != "reduced [workflows.write]" || states[removed] != "removed []" {
		t.Fatalf("creator states: %v", states)
	}

	agent := "agent:" + kept
	for _, client := range []string{kept, other} {
		meta, _ := json.Marshal(map[string]any{"allowed": client == kept,
			"denial": "MCP writes are disabled at the process level", "agentClient": map[string]any{"id": client}})
		exec(`INSERT INTO audit_logs (id, org_id, user_id, action, target_type, target_id, metadata)
			VALUES (gen_random_uuid()::text, $1, $2, 'mcp.tool.invoked', 'mcp_tool', 'runs.list', $3)`, h.org, "agent:"+client, meta)
	}
	document, _ := json.Marshal(makeLinearWorkflow("agent-detail-" + h.org))
	exec(`INSERT INTO workflow_drafts (id, org_id, workflow_id, document, digest, created_by)
		VALUES ($1, $2, $3, $4, repeat('d', 64), $5)`, "draft-detail-"+h.org, h.org, "agent-detail-"+h.org, document, agent)
	exec(`INSERT INTO draft_qualifications (id, org_id, draft_id, digest, status, checks, fixture_runs, created_by, completed_at)
		VALUES ($1, $2, $3, repeat('d', 64), 'passed', '[]', '[]', $4, now())`, "qual-detail-"+h.org, h.org, "draft-detail-"+h.org, agent)
	exec(`INSERT INTO publish_requests (id, org_id, workflow_id, draft_id, qualification_id, reasons, requested_by, on_behalf_of, drafted_by, expires_at)
		VALUES ($1, $2, $3, $4, $5, '{writes}', $6, $7, $6, now() + interval '1 day')`,
		"pub-detail-"+h.org, h.org, "agent-detail-"+h.org, "draft-detail-"+h.org, "qual-detail-"+h.org, agent, editor["x-user-id"])

	viewed := h.callWithHeaders("GET", "/v1/agent-clients/"+kept, nil, "", viewer)
	if viewed.status != 200 || viewed.body["data"].(map[string]any)["recentCalls"] != nil {
		t.Fatalf("a viewer who did not create the client must not read its audit-derived calls: %d %v", viewed.status, viewed.body)
	}
	if requests, _ := viewed.body["data"].(map[string]any)["openRequests"].([]any); len(requests) != 1 {
		t.Fatalf("a viewer with workflows.read sees the open requests: %v", viewed.body)
	}
	detail := h.callWithHeaders("GET", "/v1/agent-clients/"+kept, nil, "", editor)
	if detail.status != 200 {
		t.Fatalf("creator detail: %d %v", detail.status, detail.body)
	}
	body := detail.body["data"].(map[string]any)
	calls := body["recentCalls"].([]any)
	if len(calls) != 1 || calls[0].(map[string]any)["allowed"] != true || strings.Contains(fmt.Sprint(body), "process level") {
		t.Fatalf("detail must show only this client's calls: %v", calls)
	}
	if requests := body["openRequests"].([]any); len(requests) != 1 || requests[0].(map[string]any)["id"] != "pub-detail-"+h.org {
		t.Fatalf("detail must show this agent's open request: %v", requests)
	}
	if caps := body["capabilities"].([]any); len(caps) != 1 || !strings.Contains(fmt.Sprint(caps[0]), "workflows.list") {
		t.Fatalf("detail capabilities: %v", caps)
	}
	admin := seedAgentClientCreator(t, h, "admin")
	if res := h.callWithHeaders("GET", "/v1/agent-clients/"+kept, nil, "", admin); len(fmt.Sprint(res.body["data"].(map[string]any)["recentCalls"])) < 3 {
		t.Fatalf("an admin reads the calls of someone else's client: %v", res.body)
	}
	demotedDetail := h.callWithHeaders("GET", "/v1/agent-clients/"+demoted, nil, "", viewer).body["data"].(map[string]any)
	for _, raw := range demotedDetail["capabilities"].([]any) {
		entry := raw.(map[string]any)
		if entry["name"] == "propose" && fmt.Sprint(entry["missingPermissions"]) != "[workflows.write]" {
			t.Fatalf("a reduced capability must name what the creator lost: %v", entry)
		}
	}
	if res := h.callWithHeaders("GET", "/v1/agent-clients/"+kept, nil, "other-org-"+h.org, nil); res.status != 404 {
		t.Fatalf("another organization read the client: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("GET", "/v1/agent-clients/missing", nil, "", viewer); res.status != 404 {
		t.Fatalf("unknown client: %d %v", res.status, res.body)
	}
}
