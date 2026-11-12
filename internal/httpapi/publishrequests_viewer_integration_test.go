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
	if got := refusal(peer); got != "stale" {
		t.Fatalf("the list must agree with the detail on a stale receipt: %v", got)
	}
	if res := h.callWithHeaders("POST", "/v1/publish-requests/"+requestID+"/approve", nil, "", as(peer)); res.status != 409 ||
		res.body["error"].(map[string]any)["code"] != "publish_request_stale" {
		t.Fatalf("approving a stale request: %d %v", res.status, res.body)
	}

	// A reason the column cannot store is refused before anything happens.
	for _, bad := range []string{strings.Repeat("x", 501), "ok\u0000", "bell\u0007"} {
		if res := h.callWithHeaders("POST", "/v1/publish-requests/"+requestID+"/reject",
			map[string]any{"reason": bad}, "", as(peer)); res.status != 400 || res.body["error"].(map[string]any)["code"] != "invalid_reason" {
			t.Fatalf("reason %q: %d %v", bad, res.status, res.body)
		}
	}
	// A rejection keeps its reason for the agent and the screen.
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
		t.Helper()
		res := h.callWithHeaders("GET", "/v1/publish-requests?status="+status, nil, "", as(peer))
		if res.status != 200 {
			t.Fatalf("list %s: %d %v", status, res.status, res.body)
		}
		return fmt.Sprint(res.body["data"])
	}
	if strings.Contains(listed("pending"), expired) || !strings.Contains(listed("expired"), expired) {
		t.Fatalf("an expired pending request must filter as expired")
	}
	if res := h.callWithHeaders("GET", "/v1/publish-requests/"+expired, nil, "other-org-"+suffix, as(peer)); res.status != 404 {
		t.Fatalf("another organization read the request: %d %v", res.status, res.body)
	}
}

// A reason the column refuses never lets an approval publish without its
// decision and audit record.
func TestPublishRequestApprovalRefusesAnUnstorableReason(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	workflowID := "wf-nul-" + suffix
	requestID := publishRequestSeed{t: t, h: h, agent: "agent:none-" + suffix, onBehalfOf: "someone", workflowID: workflowID,
		document: makeLinearWorkflow(workflowID), digest: strings.Repeat("9", 64), suffix: "nul-" + suffix}.insert()
	if res := h.call("POST", "/v1/publish-requests/"+requestID+"/approve", map[string]any{"reason": "fine\u0000"}, ""); res.status != 400 {
		t.Fatalf("approval with a NUL reason: %d %v", res.status, res.body)
	}
	var versions int
	if err := testPool(t).QueryRow(t.Context(), `SELECT count(*) FROM workflow_versions WHERE org_id = $1 AND workflow_id = $2`,
		h.org, workflowID).Scan(&versions); err != nil || versions != 0 {
		t.Fatalf("a refused approval published %d versions (%v)", versions, err)
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
		map[string]any{"id": "query", "type": "tool", "config": map[string]any{
			"tool": "db.query", "credential": "WAREHOUSE", "input": map[string]any{"sql": "select 1"},
			"headers": map[string]any{"X-Literal": "literal-value-never-shown"},
		}},
	}
	draft["edges"] = []any{map[string]any{"from": "shape", "to": "post"}, map[string]any{"from": "post", "to": "page"},
		map[string]any{"from": "page", "to": "query"}}
	draft["name"] = "Renamed by the agent"
	requestID := publishRequestSeed{t: t, h: h, agent: "agent:none-" + suffix, onBehalfOf: "someone",
		workflowID: "wf-effects-" + suffix, baseVersionID: saved.body["data"].(map[string]any)["versionId"].(string),
		document: draft, digest: strings.Repeat("c", 64), suffix: "effects-" + suffix, reasons: "{writes,steps_removed,outputs_removed}"}.insert()

	res := h.call("GET", "/v1/publish-requests/"+requestID, nil, "")
	if res.status != 200 {
		t.Fatalf("detail: %d %v", res.status, res.body)
	}
	data := res.body["data"].(map[string]any)
	effects := fmtJSON(data["effects"])
	for _, want := range []string{`"kind":"step","nodeId":"post"`, `"target":"api.example.com"`, `"refunds_token"`, `"nodeId":"page"`, `"SLACK_HOOK"`,
		`"tool":"slack.post"`, `"WAREHOUSE"`} {
		if !strings.Contains(effects, want) {
			t.Fatalf("effects miss %s: %s", want, effects)
		}
	}
	if strings.Contains(effects, "shape") || strings.Contains(effects, "literal-value") || strings.Contains(effects, "Bearer") {
		t.Fatalf("effects carry a pure step or a configured value: %s", effects)
	}
	request := data["request"].(map[string]any)
	if request["workflowName"] != "API linear" || request["proposedName"] != "Renamed by the agent" {
		t.Fatalf("the live name leads and a rename shows apart: %v %v", request["workflowName"], request["proposedName"])
	}
	if changes := fmtJSON(data["changes"]); changes != `{"outputsRemoved":["verdict"],"stepsRemoved":["done"],"triggersChanged":[]}` {
		t.Fatalf("changes: %s", changes)
	}
	if got := fmt.Sprint(request["viewer"]); got != "map[canDecide:true refusal:<nil>]" {
		t.Fatalf("without the second-person policy the creator lookup is not needed: %s", got)
	}
}

// Outputs that name a secret keep a draft from publishing alone; the detail
// says so instead of reporting that nothing reaches out.
func TestPublishRequestDetailNamesSecretOutputs(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	draft := makeLinearWorkflow("wf-outputs-" + suffix)
	draft["outputs"] = map[string]any{"token": "{{secret.api_token}}"}
	requestID := publishRequestSeed{t: t, h: h, agent: "agent:none-" + suffix, onBehalfOf: "someone",
		workflowID: "wf-outputs-" + suffix, document: draft, digest: strings.Repeat("8", 64), suffix: "outputs-" + suffix,
		reasons: "{first_publish,outbound}"}.insert()
	res := h.call("GET", "/v1/publish-requests/"+requestID, nil, "")
	effects := fmtJSON(res.body["data"].(map[string]any)["effects"])
	if !strings.Contains(effects, `"kind":"outputs"`) || !strings.Contains(effects, `"api_token"`) {
		t.Fatalf("secret outputs must show as an effect: %s", effects)
	}
}

// A step named like the outputs entry still reads as a step that writes.
func TestPublishRequestEffectsKeepStepsApartFromOutputs(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	draft := makeLinearWorkflow("wf-disguise-" + suffix)
	draft["nodes"] = append(draft["nodes"].([]any), map[string]any{"id": "/outputs", "type": "http", "config": map[string]any{
		"url": "https://evil.example.com/pay", "method": "POST",
	}})
	requestID := publishRequestSeed{t: t, h: h, agent: "agent:none-" + suffix, onBehalfOf: "someone",
		workflowID: "wf-disguise-" + suffix, document: draft, digest: strings.Repeat("7", 64), suffix: "disguise-" + suffix,
		reasons: "{first_publish,outbound}"}.insert()
	res := h.call("GET", "/v1/publish-requests/"+requestID, nil, "")
	effects := fmtJSON(res.body["data"].(map[string]any)["effects"])
	if !strings.Contains(effects, `"kind":"step","nodeId":"/outputs"`) || !strings.Contains(effects, `"writes":true`) || strings.Contains(effects, `"kind":"outputs"`) {
		t.Fatalf("a step must never read as outputs: %s", effects)
	}
}
