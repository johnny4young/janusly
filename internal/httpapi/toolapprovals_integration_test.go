//go:build integration

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

func (h *apiHarness) callAs(user, method, path string, body any) apiResponse {
	h.t.Helper()
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest(method, h.server.URL+path, bytes.NewReader(raw))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", user)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	var parsed map[string]any
	_ = json.NewDecoder(res.Body).Decode(&parsed)
	return apiResponse{status: res.StatusCode, headers: res.Header, body: parsed}
}

func gateWorkflow(id string, nodes ...map[string]any) map[string]any {
	items := make([]any, 0, len(nodes))
	for _, node := range nodes {
		items = append(items, node)
	}
	return map[string]any{"id": id, "name": "Gate", "dslVersion": "1.0", "nodes": items, "edges": []any{}}
}

func uppercaseStep(id, value string) map[string]any {
	return map[string]any{"id": id, "type": "tool", "config": map[string]any{"tool": "text.uppercase", "input": map[string]any{"value": value}}}
}

func (h *apiHarness) waitApproval(ctx context.Context, pool *pgxpool.Pool, runID string) (string, string) {
	h.t.Helper()
	var approvalID, digest string
	for deadline := time.Now().Add(20 * time.Second); approvalID == "" && time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		_ = pool.QueryRow(ctx, `SELECT r.id, r.params_digest FROM tool_approval_requests r JOIN run_nodes n ON n.run_id = r.run_id AND n.node_id = r.node_id
			WHERE r.run_id = $1 AND r.consumed_at IS NULL AND n.status = 'waiting'`, runID).Scan(&approvalID, &digest)
	}
	if approvalID == "" {
		h.t.Fatalf("run %s never asked for approval", runID)
	}
	return approvalID, digest
}

// The org policy gates the tool by name: renaming the step, adding a decoy or
// replaying with a moved call still waits for a person who did not cause it.
func TestToolApprovalPolicyGatesTheCallWhateverTheDocument(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	if res := h.call("POST", "/org/config", map[string]any{"key": "tools.approvalRequired", "value": "text.uppercase"}, ""); res.status != 200 {
		t.Fatalf("set policy: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/org/config", map[string]any{"key": "tools.approvalRequired", "value": "Not A Tool"}, ""); res.status != 400 {
		t.Fatalf("a malformed policy was stored: %d %+v", res.status, res.body)
	}
	id := fmt.Sprintf("wf-policy-%d", time.Now().UnixNano())
	runID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": gateWorkflow(id, uppercaseStep("call", "page"))}, ""))
	approvalID, digest := h.waitApproval(ctx, pool, runID)
	decision := map[string]any{"approvalId": approvalID, "paramsDigest": digest, "decision": "deny"}
	if res := h.call("POST", "/runs/tool-approvals/decide", decision, ""); res.status != 403 || res.body["code"] != "tool_approval_self" {
		t.Fatalf("the starter decided: %d %+v", res.status, res.body)
	}
	if res := h.callAs("reviewer", "POST", "/runs/tool-approvals/decide", decision); res.status != 200 {
		t.Fatalf("deny: %d %+v", res.status, res.body)
	}
	h.waitRun(runID, "failed")
	deadLetter, err := store.New(pool).FindOpenDeadLetterForNode(ctx, store.FindOpenDeadLetterForNodeParams{OrgID: h.org, RunID: runID, NodeID: "call"})
	if err != nil {
		t.Fatal(err)
	}

	// A fix that leaves a decoy and moves the call onto the failing step still waits.
	decoyFix := gateWorkflow(id, uppercaseStep("decoy", "noop"), uppercaseStep("call", "snooze all"))
	if res := h.callAs("operator", "POST", "/dlq/replay", map[string]any{"deadLetterId": deadLetter, "suggestedWorkflow": decoyFix}); res.status != 200 {
		t.Fatalf("replay: %d %+v", res.status, res.body)
	}
	next, _ := h.waitApproval(ctx, pool, runID)
	var requesters, output string
	if err := pool.QueryRow(ctx, `SELECT array_to_string(r.requester_ids, ','), coalesce(n.state_json #>> '{output}', '')
		FROM tool_approval_requests r JOIN run_nodes n ON n.run_id = r.run_id AND n.node_id = r.node_id WHERE r.id = $1`, next).Scan(&requesters, &output); err != nil {
		t.Fatal(err)
	}
	if output != "" || !strings.Contains(requesters, "operator") || !strings.Contains(requesters, "api-tester") {
		t.Fatalf("the moved call ran or its redriver may approve it: output=%q requesters=%q", output, requesters)
	}
}
