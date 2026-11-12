//go:build integration

package httpapi

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// Each request tells the caller whether they may decide it and the refusal
// the decide route would give, so the screen offers nothing the API denies.
func TestPublishRequestViewerMatchesTheDecideRoute(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	creator, peer, viewer := "creator-"+suffix, "peer-"+suffix, "viewer-"+suffix
	for user, role := range map[string]string{creator: "editor", peer: "editor", viewer: "viewer"} {
		if _, err := pool.Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`,
			"m-"+user, h.org, user, role); err != nil {
			t.Fatal(err)
		}
	}
	clientID := "publisher-" + suffix
	if _, err := pool.Exec(t.Context(), `INSERT INTO agent_clients (id, org_id, name, capabilities, token_digest, token_last4, created_by, expires_at)
		VALUES ($1, $2, 'Claude Code', ARRAY['read','publish'], sha256(convert_to($1, 'UTF8')), 'abcd', $3, now() + interval '1 day')`,
		clientID, h.org, creator); err != nil {
		t.Fatal(err)
	}
	as := func(user string) map[string]string { return map[string]string{"x-user-id": user} }
	seed := publishRequestSeed{t: t, h: h, agent: "agent:" + clientID, onBehalfOf: creator,
		workflowID: "wf-viewer-" + suffix, document: makeLinearWorkflow("wf-viewer-" + suffix),
		digest: strings.Repeat("a", 64), suffix: "viewer-" + suffix}
	requestID := seed.insert()

	refusal := func(user string) any {
		t.Helper()
		res := h.callWithHeaders("GET", "/v1/publish-requests?status=pending", nil, "", as(user))
		if res.status != 200 {
			t.Fatalf("list as %s: %d %v", user, res.status, res.body)
		}
		for _, raw := range res.body["data"].(map[string]any)["requests"].([]any) {
			request := raw.(map[string]any)
			if request["id"] == requestID {
				if request["requesterName"] != "Claude Code" || request["workflowName"] != "API linear" {
					t.Fatalf("names: %v", request)
				}
				return request["viewer"].(map[string]any)["refusal"]
			}
		}
		t.Fatalf("pending list as %s lost the request: %v", user, res.body)
		return nil
	}
	if got := refusal(peer); got != nil {
		t.Fatalf("a peer editor may decide: %v", got)
	}
	if got := refusal(creator); got != nil {
		t.Fatalf("without the second-person policy the creator may decide: %v", got)
	}
	if got := refusal(viewer); got != "permission" {
		t.Fatalf("a viewer is refused for permission: %v", got)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'agents.publishRequiresSecondPerson', 'true', 'agents', 'test', 'boolean')`, "cfg-"+suffix, h.org); err != nil {
		t.Fatal(err)
	}
	if got := refusal(creator); got != "second_person" {
		t.Fatalf("with a second person required the creator is refused: %v", got)
	}
	if res := h.callWithHeaders("POST", "/v1/publish-requests/"+requestID+"/approve", nil, "", as(creator)); res.status != 403 {
		t.Fatalf("the decide route must agree with the screen: %d %v", res.status, res.body)
	}

	// A receipt past its lifetime reads as stale, and approving it says so.
	if _, err := pool.Exec(t.Context(), `UPDATE draft_qualifications SET created_at = now() - interval '25 hours' WHERE org_id = $1 AND draft_id = $2`,
		h.org, "draft-viewer-"+suffix); err != nil {
		t.Fatal(err)
	}
	detail := h.callWithHeaders("GET", "/v1/publish-requests/"+requestID, nil, "", as(peer))
	if got := detail.body["data"].(map[string]any)["request"].(map[string]any)["viewer"]; fmt.Sprint(got) != "map[canDecide:false refusal:stale]" {
		t.Fatalf("a stale receipt must read as stale: %v", got)
	}
	if res := h.callWithHeaders("POST", "/v1/publish-requests/"+requestID+"/approve", nil, "", as(peer)); res.status != 409 ||
		res.body["error"].(map[string]any)["code"] != "publish_request_stale" {
		t.Fatalf("approving a stale request: %d %v", res.status, res.body)
	}

	// A rejection keeps its reason for the agent and the screen.
	if res := h.callWithHeaders("POST", "/v1/publish-requests/"+requestID+"/reject",
		map[string]any{"reason": strings.Repeat("x", 501)}, "", as(peer)); res.status != 400 {
		t.Fatalf("an oversized reason: %d %v", res.status, res.body)
	}
	rejected := h.callWithHeaders("POST", "/v1/publish-requests/"+requestID+"/reject",
		map[string]any{"reason": "  Needs a retry limit  "}, "", as(peer))
	view := rejected.body["data"].(map[string]any)["request"].(map[string]any)
	if rejected.status != 200 || view["status"] != "rejected" || view["decisionReason"] != "Needs a retry limit" ||
		fmt.Sprint(view["viewer"]) != "map[canDecide:false refusal:settled]" {
		t.Fatalf("rejection: %d %v", rejected.status, rejected.body)
	}
	var stored string
	if err := pool.QueryRow(t.Context(), `SELECT decision_reason FROM publish_requests WHERE org_id = $1 AND id = $2`, h.org, requestID).Scan(&stored); err != nil ||
		stored != "Needs a retry limit" {
		t.Fatalf("stored reason: %q %v", stored, err)
	}

	// Past its expiry a pending request lists and reads as expired.
	seed.suffix, seed.digest, seed.expiresIn = "expired-"+suffix, strings.Repeat("b", 64), "-1 minute"
	seed.workflowID = "wf-expired-" + suffix
	expired := seed.insert()
	listed := func(status string) string {
		res := h.callWithHeaders("GET", "/v1/publish-requests?status="+status, nil, "", as(peer))
		return fmt.Sprint(res.body["data"])
	}
	if strings.Contains(listed("pending"), expired) || !strings.Contains(listed("expired"), expired) {
		t.Fatalf("an expired pending request must filter as expired")
	}
	if res := h.callWithHeaders("GET", "/v1/publish-requests/"+expired, nil, "other-org-"+suffix, as(peer)); res.status != 404 {
		t.Fatalf("another organization read the request: %d %v", res.status, res.body)
	}
}

// The detail lists what each outbound step reaches and the credentials it
// names, never a value, and what a change removes from production.
func TestPublishRequestDetailShowsEffectsAndChanges(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	live := makeLinearWorkflow("wf-effects-" + suffix)
	live["outputs"] = map[string]any{"verdict": "{{context.shape.output.verdict}}"}
	saved := h.call("POST", "/v1/workflows/save", live, "")
	if saved.status != 200 {
		t.Fatalf("save: %d %v", saved.status, saved.body)
	}
	draft := makeLinearWorkflow("wf-effects-" + suffix)
	draft["nodes"] = []any{
		map[string]any{"id": "shape", "type": "transform", "config": map[string]any{"mapping": map[string]any{"verdict": "ok"}}},
		map[string]any{"id": "post", "type": "http", "config": map[string]any{
			"url": "https://api.example.com/v1/refunds", "method": "POST",
			"headers": map[string]any{"Authorization": "Bearer {{secret.refunds_token}}"},
		}},
		map[string]any{"id": "page", "type": "tool", "config": map[string]any{
			"tool": "slack.post", "input": map[string]any{"credential": "SLACK_HOOK", "text": "done"},
		}},
	}
	draft["edges"] = []any{map[string]any{"from": "shape", "to": "post"}, map[string]any{"from": "post", "to": "page"}}
	requestID := publishRequestSeed{t: t, h: h, agent: "agent:none-" + suffix, onBehalfOf: "someone",
		workflowID: "wf-effects-" + suffix, baseVersionID: saved.body["data"].(map[string]any)["versionId"].(string),
		document: draft, digest: strings.Repeat("c", 64), suffix: "effects-" + suffix, reasons: "{writes,steps_removed,outputs_removed}"}.insert()

	res := h.call("GET", "/v1/publish-requests/"+requestID, nil, "")
	if res.status != 200 {
		t.Fatalf("detail: %d %v", res.status, res.body)
	}
	data := res.body["data"].(map[string]any)
	effects := fmtJSON(data["effects"])
	for _, want := range []string{`"nodeId":"post"`, `"target":"api.example.com"`, `"refunds_token"`, `"nodeId":"page"`, `"SLACK_HOOK"`, `"tool":"slack.post"`} {
		if !strings.Contains(effects, want) {
			t.Fatalf("effects miss %s: %s", want, effects)
		}
	}
	if strings.Contains(effects, "shape") {
		t.Fatalf("a pure step is not an effect: %s", effects)
	}
	if changes := fmtJSON(data["changes"]); changes != `{"outputsRemoved":["verdict"],"stepsRemoved":["done"],"triggersChanged":[]}` {
		t.Fatalf("changes: %s", changes)
	}
	if got := fmt.Sprint(data["request"].(map[string]any)["viewer"]); got != "map[canDecide:true refusal:<nil>]" {
		t.Fatalf("without the second-person policy the creator lookup is not needed: %s", got)
	}
}
