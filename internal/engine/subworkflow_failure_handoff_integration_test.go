//go:build integration

package engine

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
)

// A child failed outside the executor (its stalled node reaped, or its
// snapshot rejected at claim) hands off to the waiting parent right away,
// with no reconciler sweep to fall back on.
func TestSubworkflowParentSettlesWhenTheChildFailsOutsideTheExecutor(t *testing.T) {
	for _, tc := range []struct {
		name string
		fail func(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, org, childRunID string)
	}{
		{name: "stalled node reaped", fail: func(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, _, childRunID string) {
			if _, err := pool.Exec(ctx, `UPDATE run_nodes SET status='running', started_at = now() - interval '2 hours'
				WHERE run_id=$1 AND node_id='work' AND status='queued'`, childRunID); err != nil {
				t.Fatalf("stall child node: %v", err)
			}
			if reaped, _ := eng.ReapStalledNodes(ctx, time.Hour, 50, quietLogger()); reaped < 1 {
				t.Fatalf("expected the stalled child node reaped, got %d", reaped)
			}
		}},
		{name: "incompatible snapshot", fail: func(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, org, childRunID string) {
			if _, err := pool.Exec(ctx, `UPDATE runs
				SET input_json = jsonb_set(input_json, '{workflow,nodes,0,type}', '"unsupported"')
				WHERE id=$1`, childRunID); err != nil {
				t.Fatalf("seed incompatible snapshot: %v", err)
			}
			claim := claimQueuedNode(t, ctx, pool, org, childRunID, "work")
			eng.executeClaim(ctx, claim, eng.NewDispatcher(grammar.RenderOptions{}).Execute, quietLogger())
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, pool, eng, org := newHarness(t)
			q := store.New(pool)
			suffix := fmt.Sprint(time.Now().UnixNano())

			childID := "wf-handoff-child-" + suffix
			saveWorkflowVersion(t, ctx, q, org, childID, `{"id":"`+childID+`","name":"child","dslVersion":"1.0",
				"nodes":[{"id":"work","type":"noop","config":{}}],"edges":[]}`)
			parentDoc := `{"id":"wf-handoff-parent-` + suffix + `","name":"parent","dslVersion":"1.0",
				"nodes":[{"id":"call","type":"subworkflow","config":{"workflowId":"` + childID + `"}}],"edges":[]}`
			parentRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, parentDoc)})
			if err != nil {
				t.Fatalf("start parent: %v", err)
			}
			// Run only the parent's step so the child's root stays queued for the trigger.
			call := claimQueuedNode(t, ctx, pool, org, parentRunID, "call")
			eng.executeClaim(ctx, call, eng.NewDispatcher(grammar.RenderOptions{}).Execute, quietLogger())
			var childRunID string
			if err := pool.QueryRow(ctx, `SELECT id FROM runs WHERE parent_run_id = $1`, parentRunID).Scan(&childRunID); err != nil {
				t.Fatalf("child run: %v", err)
			}

			tc.fail(t, ctx, pool, eng, org, childRunID)

			var childStatus, parentStatus, callStatus, callError string
			var marker *time.Time
			deadline := time.Now().Add(5 * time.Second)
			for {
				_ = pool.QueryRow(ctx, `SELECT status, parent_notification_after FROM runs WHERE id = $1`, childRunID).Scan(&childStatus, &marker)
				_ = pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, parentRunID).Scan(&parentStatus)
				if parentStatus == "failed" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("parent stayed %q after the child ended %q", parentStatus, childStatus)
				}
				time.Sleep(30 * time.Millisecond)
			}
			_ = pool.QueryRow(ctx, `SELECT status, coalesce(error_json::text, '') FROM run_nodes WHERE run_id = $1 AND node_id = 'call'`,
				parentRunID).Scan(&callStatus, &callError)
			if childStatus != "failed" || callStatus != "failed" ||
				!strings.Contains(callError, "SUBWORKFLOW_FAILED") || !strings.Contains(callError, "firstChildFailure") {
				t.Fatalf("handoff outcome: child=%s call=%s error=%s", childStatus, callStatus, callError)
			}
			if marker != nil {
				t.Fatalf("settled marker must clear, still %v", marker)
			}
		})
	}
}

func claimQueuedNode(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, runID, nodeID string) ClaimedNode {
	t.Helper()
	claim := ClaimedNode{RunID: runID, NodeID: nodeID, OrgID: org}
	if err := pool.QueryRow(ctx, `UPDATE run_nodes SET status='running', started_at=now()
		WHERE run_id=$1 AND node_id=$2 AND status='queued'
		RETURNING id, attempts`, runID, nodeID).Scan(&claim.RowID, &claim.Attempt); err != nil {
		t.Fatalf("claim %s: %v", nodeID, err)
	}
	return claim
}
