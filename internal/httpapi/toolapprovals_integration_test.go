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

	"github.com/johnny4young/janusly/internal/engine"
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

func gateWorkflow(id string, gated bool) map[string]any {
	config := map[string]any{"tool": "text.uppercase", "input": map[string]any{"value": "page"}}
	if gated {
		config["requireApproval"] = true
	}
	return map[string]any{"id": id, "name": "Gate", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "tool", "config": config}}, "edges": []any{}}
}

func requireDropped(t *testing.T, what string, res apiResponse) {
	t.Helper()
	code, _ := res.body["code"].(string)
	if errBody, ok := res.body["error"].(map[string]any); ok {
		code, _ = errBody["code"].(string)
	}
	if res.status != http.StatusConflict || code != "tool_approval_dropped" {
		t.Fatalf("%s must refuse to drop the gate: %d %+v", what, res.status, res.body)
	}
}

// Once the saved workflow gates a tool step, no start, rerun, replay or swap
// may run that step without its gate.
func TestToolApprovalCannotBeDroppedThroughAnyStartOrReplay(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	id := fmt.Sprintf("wf-gate-%d", time.Now().UnixNano())

	v1 := h.call("POST", "/workflows/save", gateWorkflow(id, false), "")
	v1ID, _ := v1.body["versionId"].(string)
	oldRun := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": gateWorkflow(id, false)}, ""))
	h.waitRun(oldRun, "succeeded")
	if res := h.call("POST", "/workflows/save", gateWorkflow(id, true), ""); res.status != 200 {
		t.Fatalf("save gated version: %d %+v", res.status, res.body)
	}

	requireDropped(t, "an ad-hoc start", h.call("POST", "/v1/start", map[string]any{"workflow": gateWorkflow(id, false)}, ""))
	requireDropped(t, "an older saved version", h.call("POST", "/v1/start", map[string]any{"workflow": gateWorkflow(id, false), "workflowVersionId": v1ID}, ""))
	requireDropped(t, "a rerun of an older run", h.call("POST", "/runs/rerun", map[string]any{"sourceRunId": oldRun, "nodeId": "call"}, ""))
	requireDropped(t, "a Replay Lab run", h.call("POST", "/runs/replay-lab", map[string]any{"sourceRunId": oldRun}, ""))
	requireDropped(t, "a Replay Lab fork", h.call("POST", "/runs/replay-lab/fork", map[string]any{"sourceRunId": oldRun, "forkNodeId": "call"}, ""))

	gatedRun := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": gateWorkflow(id, true)}, ""))
	var approvalID, digest string
	for deadline := time.Now().Add(20 * time.Second); approvalID == "" && time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		_ = pool.QueryRow(ctx, `SELECT r.id, r.params_digest FROM tool_approval_requests r JOIN run_nodes n ON n.run_id = r.run_id
			WHERE r.run_id = $1 AND n.status = 'waiting'`, gatedRun).Scan(&approvalID, &digest)
	}
	decision := map[string]any{"approvalId": approvalID, "paramsDigest": digest, "decision": "deny"}
	if res := h.call("POST", "/runs/tool-approvals/decide", decision, ""); res.status != 403 || res.body["code"] != "tool_approval_self" {
		t.Fatalf("the starter decided: %d %+v", res.status, res.body)
	}
	if res := h.callAs("reviewer", "POST", "/runs/tool-approvals/decide", decision); res.status != 200 {
		t.Fatalf("deny: %d %+v", res.status, res.body)
	}
	h.waitRun(gatedRun, "failed")
	deadLetter, err := store.New(pool).FindOpenDeadLetterForNode(ctx, store.FindOpenDeadLetterForNodeParams{OrgID: h.org, RunID: gatedRun, NodeID: "call"})
	if err != nil {
		t.Fatal(err)
	}
	unflagged := gateWorkflow(id, false)
	requireDropped(t, "a dead-letter replay", h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": deadLetter, "suggestedWorkflow": unflagged}, ""))
	requireDropped(t, "a v1 dead-letter replay", h.call("POST", "/v1/dlq/replay", map[string]any{"deadLetterId": deadLetter, "suggestedWorkflow": unflagged}, ""))
	requireDropped(t, "a fix validation", h.call("POST", "/dlq/validate-fix", map[string]any{"deadLetterId": deadLetter, "suggestedWorkflow": unflagged}, ""))
	row, err := store.New(pool).GetDeadLetter(ctx, store.GetDeadLetterParams{ID: deadLetter, OrgID: h.org})
	if err != nil {
		t.Fatal(err)
	}
	cluster := h.call("POST", "/dlq/cluster-apply", map[string]any{
		"clusterSignature": engine.DeadLetterSignature(row), "deadLetterIds": []string{deadLetter}, "suggestedWorkflow": unflagged,
	}, "")
	if cluster.body["replayed"] != float64(0) || !strings.Contains(fmt.Sprint(cluster.body["errors"]), "requires tool approval") {
		t.Fatalf("cluster apply dropped the gate: %d %+v", cluster.status, cluster.body)
	}

	// A plain redrive records its operator, who then cannot approve the new request.
	if res := h.callAs("operator", "POST", "/runs/redrive", map[string]any{"runId": gatedRun, "nodeId": "call"}); res.status != 200 {
		t.Fatalf("redrive: %d %+v", res.status, res.body)
	}
	var requesters string
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		_ = pool.QueryRow(ctx, `SELECT array_to_string(requester_ids, ',') FROM tool_approval_requests
			WHERE run_id = $1 AND consumed_at IS NULL`, gatedRun).Scan(&requesters)
		if requesters != "" {
			break
		}
	}
	if !strings.Contains(requesters, "operator") || !strings.Contains(requesters, "api-tester") {
		t.Fatalf("the redriver may approve the call it re-ran: %q", requesters)
	}
}
