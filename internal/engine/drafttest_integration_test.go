//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

// The worker honors a stand-in only on a validation run: the same envelope on a
// production run, or on an approval, still reaches the executor.
func TestDraftStandInReplacesExecutionOnlyInValidationRuns(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"id":"wf-stand-in","nodes":[{"id":"fetch","type":"noop","config":{}},{"id":"gate","type":"approval","config":{}}],"edges":[]}`
	pins := map[string]any{
		"fetch": map[string]any{"kind": "mocked", "output": map[string]any{"v": "stand-in"}},
		"gate":  map[string]any{"kind": "mocked", "output": map[string]any{"v": "stand-in"}},
	}
	cases := []struct{ mode, node, want string }{
		{"", "fetch", "executed"},
		{"validation", "fetch", "stand-in"},
		{"validation", "gate", "executed"},
	}
	for _, tc := range cases {
		runID := org + "-stand-in-" + tc.mode + "-" + tc.node
		input, _ := json.Marshal(map[string]any{"workflow": json.RawMessage(doc), "input": map[string]any{}, "draftTest": map[string]any{"pins": pins}})
		if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json, replay_mode)
			VALUES ($1, $2, $1, 'running', $3, NULLIF($4, ''))`, runID, org, input, tc.mode); err != nil {
			t.Fatalf("seed run: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO run_nodes (id, run_id, node_id, status, attempts, started_at)
			VALUES ($1, $2, $3, 'running', 1, now())`, runID+"-node", runID, tc.node); err != nil {
			t.Fatalf("seed node: %v", err)
		}
		var calls atomic.Int32
		execute := func(context.Context, ClaimedNode, domain.Node, *domain.Workflow, map[string]any) (any, error) {
			calls.Add(1)
			return map[string]any{"v": "executed"}, nil
		}
		eng.executeClaim(ctx, ClaimedNode{RowID: runID + "-node", RunID: runID, NodeID: tc.node, Attempt: 1, OrgID: org}, execute, quietLogger())
		var state string
		if err := pool.QueryRow(ctx, `SELECT state_json::text FROM run_nodes WHERE run_id=$1 AND node_id=$2`, runID, tc.node).Scan(&state); err != nil {
			t.Fatalf("read node: %v", err)
		}
		if !strings.Contains(state, tc.want) || (tc.want == "executed") != (calls.Load() == 1) {
			t.Fatalf("mode %q node %s: want %s, calls=%d state=%s", tc.mode, tc.node, tc.want, calls.Load(), state)
		}
	}
}

// Only production outcomes may move the routing reward a router reads.
func TestReplayRunsLeaveRoutingStatsUntouched(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	for _, tc := range []struct {
		mode string
		fail bool
		want int
	}{{"", false, 1}, {"", true, 1}, {"validation", false, 0}, {"validation", true, 0}} {
		nodeID := fmt.Sprintf("step-%s-%t", tc.mode, tc.fail)
		runID := org + "-routing-" + nodeID
		doc := `{"id":"wf-routing","nodes":[{"id":"` + nodeID + `","type":"noop","config":{}}],"edges":[]}`
		input, _ := json.Marshal(map[string]any{"workflow": json.RawMessage(doc), "input": map[string]any{}})
		if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json, replay_mode)
			VALUES ($1, $2, $1, 'running', $3, NULLIF($4, ''))`, runID, org, input, tc.mode); err != nil {
			t.Fatalf("seed run: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO run_nodes (id, run_id, node_id, status, attempts, started_at)
			VALUES ($1, $2, $3, 'running', 1, now())`, runID+"-node", runID, nodeID); err != nil {
			t.Fatalf("seed node: %v", err)
		}
		execute := func(context.Context, ClaimedNode, domain.Node, *domain.Workflow, map[string]any) (any, error) {
			if tc.fail {
				return nil, errors.New("boom")
			}
			return map[string]any{}, nil
		}
		eng.executeClaim(ctx, ClaimedNode{RowID: runID + "-node", RunID: runID, NodeID: nodeID, Attempt: 1, OrgID: org}, execute, quietLogger())
		var rows int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM routing_stats WHERE org_id=$1 AND node_id=$2`, org, nodeID).Scan(&rows); err != nil {
			t.Fatalf("read routing stats: %v", err)
		}
		if rows != tc.want {
			t.Fatalf("mode %q fail=%t: routing rows %d, want %d", tc.mode, tc.fail, rows, tc.want)
		}
	}
}
