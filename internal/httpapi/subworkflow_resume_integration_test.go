//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/store"
)

// A child whose last step is a human decision, answered over HTTP or
// expired by its deadline, hands off to its waiting parent right away; this
// harness runs no subworkflow reconciler to fall back on.
func TestSubworkflowParentSettlesWhenAHumanStepEndsTheChild(t *testing.T) {
	for _, tc := range []struct {
		name, path, node, want string
		input                  map[string]any
	}{
		{name: "approval", path: "/v1/resume", want: "succeeded",
			node: `{"id":"last","type":"approval","config":{"message":"Ship it?"}}`},
		{name: "human_form", path: "/resume", want: "succeeded", input: map[string]any{"amount": float64(42)},
			node: `{"id":"last","type":"human_form","config":{"title":"Amount","schema":{"type":"object","properties":{"amount":{"type":"number"}},"required":["amount"]}}}`},
		{name: "approval timeout", want: "failed",
			node: `{"id":"last","type":"approval","config":{"decisionTimeoutMs":150,"onTimeout":"fail"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newAPIHarness(t)
			pool := testPool(t)
			ctx := t.Context()
			q := store.New(pool)

			childID := fmt.Sprintf("wf-child-%s-%d", strings.ReplaceAll(tc.name, " ", "-"), time.Now().UnixNano())
			childDoc := `{"id":"` + childID + `","name":"child","dslVersion":"1.0","nodes":[` + tc.node + `],"edges":[],
				"outputs":{"amount":"{{context.last.output.amount}}"}}`
			if err := q.InsertWorkflow(ctx, store.InsertWorkflowParams{ID: childID, OrgID: h.org, Name: childID}); err != nil {
				t.Fatalf("insert workflow: %v", err)
			}
			if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
				ID: childID + "-v1", OrgID: h.org, WorkflowID: childID, Version: 1, DagJson: json.RawMessage(childDoc),
			}); err != nil {
				t.Fatalf("insert version: %v", err)
			}

			started := h.call("POST", "/v1/start", map[string]any{"workflow": map[string]any{
				"id": "wf-parent-" + childID, "name": "parent", "dslVersion": "1.0",
				"nodes": []any{map[string]any{"id": "call", "type": "subworkflow", "config": map[string]any{"workflowId": childID}}},
				"edges": []any{},
			}}, "")
			parentRunID := extractRunID(t, started)

			var childRunID string
			deadline := time.Now().Add(15 * time.Second)
			for childRunID == "" {
				_ = pool.QueryRow(ctx, `SELECT r.id FROM runs r JOIN run_nodes n ON n.run_id = r.id
					WHERE r.parent_run_id = $1 AND n.node_id = 'last' AND n.status = 'waiting'`, parentRunID).Scan(&childRunID)
				if time.Now().After(deadline) {
					t.Fatalf("child of %s never paused", parentRunID)
				}
				time.Sleep(30 * time.Millisecond)
			}
			if tc.path != "" {
				body := map[string]any{"runId": childRunID, "nodeId": "last", "input": tc.input}
				if tc.name == "human_form" {
					body["resumeToken"] = waitFormToken(t, pool, ctx, childRunID, "last")
				}
				if res := h.call("POST", tc.path, body, ""); res.status != 200 {
					t.Fatalf("resume: %d %+v", res.status, res.body)
				}
			}

			var parentStatus, callState string
			var marker *time.Time
			deadline = time.Now().Add(5 * time.Second)
			for parentStatus != tc.want {
				if time.Now().After(deadline) {
					t.Fatalf("parent stayed %q after the child finished", parentStatus)
				}
				time.Sleep(30 * time.Millisecond)
				_ = pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, parentRunID).Scan(&parentStatus)
			}
			_ = pool.QueryRow(ctx, `SELECT parent_notification_after FROM runs WHERE id = $1`, childRunID).Scan(&marker)
			_ = pool.QueryRow(ctx, `SELECT state_json::text FROM run_nodes WHERE run_id = $1 AND node_id = 'call'`, parentRunID).Scan(&callState)
			if marker != nil {
				t.Fatalf("handoff marker still armed: %v", marker)
			}
			if tc.name == "human_form" && !strings.Contains(callState, `"amount": 42`) {
				t.Fatalf("parent must receive the child output: %s", callState)
			}
		})
	}
}
