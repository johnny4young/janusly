//go:build integration

package agentsessions

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/agentsession"
	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/store"
)

func issueGated(t *testing.T, h ingestHarness, tn tenant, capture bool, gateTools ...string) agentclient.Issued {
	t.Helper()
	q := store.New(h.pool)
	held, _ := agentclient.CreatorPermissions(t.Context(), q, tn.org, tn.creator)
	issued, err := agentclient.Issue(t.Context(), q, uuid.NewString(), time.Now(), agentclient.IssueInput{
		OrgID: tn.org, CreatedBy: tn.creator, Name: "gated", Capabilities: []string{"report"},
		GateTools: gateTools, CaptureContent: capture,
	}, held)
	if err != nil {
		t.Fatal(err)
	}
	return issued
}

func (h ingestHarness) gateCall(t *testing.T, token, method, path string, body []byte) reply {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, h.base+path, strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	signed := body
	if method == http.MethodGet {
		signed = []byte(req.URL.Path)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set(hookwire.SignatureHeader, signedBy(token)(signed))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	out := reply{status: res.StatusCode, raw: string(raw)}
	_ = json.Unmarshal(raw, &out.body)
	return out
}

func gateBody(session, toolUse, tool string, content any) []byte {
	request := map[string]any{"sessionId": session, "toolUseId": toolUse, "tool": tool}
	if content != nil {
		request["content"] = map[string]any{"input": content}
	}
	raw, _ := json.Marshal(request)
	return raw
}

func (h ingestHarness) requested(t *testing.T, token, session, toolUse, tool string) reply {
	t.Helper()
	return h.send(t, token, wireEvent{eventType: hookwire.TypeToolRequested, data: map[string]any{
		"sessionId": session, "toolUseId": toolUse, "tool": tool, "toolKind": "mcp", "mcpServer": "stripe",
	}})
}

func TestGateOpensOnlyForGatedToolsAndAnswersTheDecision(t *testing.T) {
	h := newIngestHarness(t, false)
	tn := seedTenant(t, h.pool, "a")
	client := issueGated(t, h, tn, true, "mcp__stripe__*", "Bash")
	session := "gate-" + uuid.NewString()

	// The ingest tells the bridge which calls to hold.
	held := h.requested(t, client.Token, session, "t1", "mcp__stripe__create_refund")
	if held.status != http.StatusAccepted || held.body["gate"] != true || held.body["captureContent"] != true {
		t.Fatalf("gated tool.requested: %d %s", held.status, held.raw)
	}
	if free := h.requested(t, client.Token, session, "t0", "mcp__notion__search"); free.body["gate"] != nil {
		t.Fatalf("ungated tool flagged: %s", free.raw)
	}
	if res := h.gateCall(t, client.Token, "POST", hookwire.GatesPath, gateBody(session, "t0", "mcp__notion__search", nil)); res.status != http.StatusConflict {
		t.Fatalf("gate for an ungated tool: %d %s", res.status, res.raw)
	}
	if res := h.gateCall(t, client.Token, "POST", hookwire.GatesPath, gateBody("never-reported", "t1", "Bash", nil)); res.status != http.StatusNotFound {
		t.Fatalf("gate for an unknown session: %d %s", res.status, res.raw)
	}

	token := "jly_agent_" + strings.Repeat("S", 43)
	opened := h.gateCall(t, client.Token, "POST", hookwire.GatesPath,
		gateBody(session, "t1", "mcp__stripe__create_refund", map[string]any{"charge": "ch_1", "note": "auth " + token}))
	gateID, _ := opened.body["gateId"].(string)
	if opened.status != http.StatusOK || opened.body["decision"] != "pending" || gateID == "" {
		t.Fatalf("open: %d %s", opened.status, opened.raw)
	}
	again := h.gateCall(t, client.Token, "POST", hookwire.GatesPath, gateBody(session, "t1", "mcp__stripe__create_refund", nil))
	if again.body["gateId"] != gateID {
		t.Fatalf("a retried hook opened a second gate: %s", again.raw)
	}
	var content string
	if err := h.pool.QueryRow(t.Context(), `SELECT content::text FROM agent_session_gates WHERE id = $1`, gateID).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, "ch_1") || strings.Contains(content, token) {
		t.Fatalf("captured content must be scrubbed: %s", content)
	}

	// Input past the cap is stored as not captured, never cut off.
	h.requested(t, client.Token, session, "t-big", "mcp__stripe__create_refund")
	big := h.gateCall(t, client.Token, "POST", hookwire.GatesPath,
		gateBody(session, "t-big", "mcp__stripe__create_refund", map[string]any{"memo": strings.Repeat("x", 9000)}))
	var bigContent *string
	if err := h.pool.QueryRow(t.Context(), `SELECT content::text FROM agent_session_gates WHERE id = $1`, big.body["gateId"]).Scan(&bigContent); err != nil || bigContent != nil {
		t.Fatalf("oversized input was kept in part: %v %v", err, bigContent)
	}

	poll := hookwire.GatesPath + "/" + gateID + "/decision"
	if res := h.gateCall(t, client.Token, "GET", poll, nil); res.body["decision"] != "pending" {
		t.Fatalf("poll: %d %s", res.status, res.raw)
	}
	// A long poll answers as soon as a person decides.
	go func() {
		time.Sleep(300 * time.Millisecond)
		_, _ = h.pool.Exec(t.Context(), `UPDATE agent_session_gates SET status = 'denied', decided_by = 'someone', decided_at = now(), reason = 'not this customer' WHERE id = $1`, gateID)
	}()
	started := time.Now()
	decided := h.gateCall(t, client.Token, "GET", poll+"?wait=20", nil)
	if decided.body["decision"] != "deny" || decided.body["reason"] != "not this customer" || time.Since(started) > 5*time.Second {
		t.Fatalf("long poll: %s after %s", decided.raw, time.Since(started))
	}
}

func TestGateIsolationLimitsAndDefaults(t *testing.T) {
	h := newIngestHarness(t, false)
	a, b := seedTenant(t, h.pool, "a"), seedTenant(t, h.pool, "b")
	owner := issueGated(t, h, a, false, "Bash")
	peer := issueGated(t, h, a, false, "Bash")
	foreign := issueGated(t, h, b, false, "Bash")
	session := "gate-" + uuid.NewString()
	h.requested(t, owner.Token, session, "t1", "Bash")
	opened := h.gateCall(t, owner.Token, "POST", hookwire.GatesPath, gateBody(session, "t1", "Bash", nil))
	gateID, _ := opened.body["gateId"].(string)
	if gateID == "" {
		t.Fatalf("open: %s", opened.raw)
	}
	poll := hookwire.GatesPath + "/" + gateID + "/decision"

	// Another client, in the same organization or another, never reads the gate.
	for name, token := range map[string]string{"peer": peer.Token, "another organization": foreign.Token} {
		if res := h.gateCall(t, token, "GET", poll, nil); res.status != http.StatusNotFound {
			t.Fatalf("%s read the gate: %d %s", name, res.status, res.raw)
		}
		if res := h.gateCall(t, token, "POST", hookwire.GatesPath, gateBody(session, "t1", "Bash", nil)); res.status != http.StatusNotFound {
			t.Fatalf("%s opened a gate on the session: %d %s", name, res.status, res.raw)
		}
	}
	// A client that does not capture content cannot send any.
	if res := h.gateCall(t, owner.Token, "POST", hookwire.GatesPath, gateBody(session, "t2", "Bash", map[string]any{"command": "ls"})); res.status != http.StatusBadRequest || res.body["code"] != "agent_gate_content_refused" {
		t.Fatalf("content without capture: %d %s", res.status, res.raw)
	}
	// A request signed over another path is refused.
	req, _ := http.NewRequestWithContext(t.Context(), "GET", h.base+poll, nil)
	req.Header.Set("Authorization", "Bearer "+owner.Token)
	req.Header.Set(hookwire.SignatureHeader, signedBy(owner.Token)([]byte(hookwire.GatesPath+"/other/decision")))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signature over another path: %d", res.StatusCode)
	}

	// A decision answers only the call it was made for, and only for a moment.
	h.requested(t, owner.Token, session, "t-bound", "Bash")
	bound := h.gateCall(t, owner.Token, "POST", hookwire.GatesPath, gateBody(session, "t-bound", "Bash", nil))
	boundID, _ := bound.body["gateId"].(string)
	if _, err := h.pool.Exec(t.Context(), `UPDATE agent_session_gates SET status = 'approved', decided_by = 'someone', decided_at = now() WHERE id = $1`, boundID); err != nil {
		t.Fatal(err)
	}
	if res := h.gateCall(t, owner.Token, "POST", hookwire.GatesPath, gateBody(session, "t-bound", "Bash", nil)); res.body["decision"] != "allow" {
		t.Fatalf("fresh approval of the same call: %s", res.raw)
	}
	other := gateBody(session, "t-bound", "Bash", nil)
	other = []byte(strings.Replace(string(other), `"tool":"Bash"`, `"tool":"Bash","mcpServer":"evil"`, 1))
	if res := h.gateCall(t, owner.Token, "POST", hookwire.GatesPath, other); res.body["decision"] != "ask" {
		t.Fatalf("an approval answered a different call: %s", res.raw)
	}
	if _, err := h.pool.Exec(t.Context(), `UPDATE agent_session_gates SET decided_at = now() - interval '3 minutes' WHERE id = $1`, boundID); err != nil {
		t.Fatal(err)
	}
	for _, res := range []reply{
		h.gateCall(t, owner.Token, "POST", hookwire.GatesPath, gateBody(session, "t-bound", "Bash", nil)),
		h.gateCall(t, owner.Token, "GET", hookwire.GatesPath+"/"+boundID+"/decision", nil),
	} {
		if res.body["decision"] != "ask" {
			t.Fatalf("an old approval still allowed: %s", res.raw)
		}
	}

	// An unanswered gate expires to "ask", never "allow".
	if _, err := h.pool.Exec(t.Context(), `UPDATE agent_session_gates SET expires_at = now() - interval '1 second' WHERE id = $1`, gateID); err != nil {
		t.Fatal(err)
	}
	if res := h.gateCall(t, owner.Token, "GET", poll+"?wait=20", nil); res.body["decision"] != "ask" {
		t.Fatalf("expired gate: %s", res.raw)
	}

	// Past the open-gate cap the answer is "ask" and nothing is stored.
	for i := range agentsession.MaxOpenGatesPerClient {
		id := fmt.Sprint("cap-", i)
		if res := h.gateCall(t, owner.Token, "POST", hookwire.GatesPath, gateBody(session, id, "Bash", nil)); res.body["decision"] != "pending" {
			t.Fatalf("gate %d: %s", i, res.raw)
		}
	}
	over := h.gateCall(t, owner.Token, "POST", hookwire.GatesPath, gateBody(session, "one-too-many", "Bash", nil))
	if over.status != http.StatusOK || over.body["decision"] != "ask" || over.body["gateId"] != nil {
		t.Fatalf("21st gate: %d %s", over.status, over.raw)
	}
}
