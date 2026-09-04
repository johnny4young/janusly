//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/store"
)

func TestApprovalDeadlinePoliciesEndToEnd(t *testing.T) {
	for _, test := range []struct {
		name       string
		policy     string
		event      string
		errorCode  string
		escalation bool
	}{
		{name: "fail", policy: "fail", event: "approval.timed_out", errorCode: "approval_timed_out"},
		{name: "auto reject", policy: "auto_reject", event: "approval.auto_rejected", errorCode: "approval_auto_rejected"},
		{name: "escalate", policy: "escalate", event: "approval.escalated", escalation: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, pool, eng, org := newHarness(t)
			config := fmt.Sprintf(`"decisionTimeoutMs":150,"onTimeout":%q`, test.policy)
			if test.escalation {
				config += `,"assignee":"tier-1","escalateTo":"tier-2"`
			}
			doc := fmt.Sprintf(`{"nodes":[
				{"id":"gate","type":"approval","config":{%s}},
				{"id":"after","type":"noop","config":{}}
			],"edges":[{"from":"gate","to":"after"}]}`, config)
			runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
			if err != nil {
				t.Fatalf("start: %v", err)
			}
			stop := startPool(t, eng)
			defer stop()

			waitForRunEvent(t, ctx, pool, runID, test.event, 15*time.Second)
			var nodeStatus, runStatus string
			var state, errorJSON []byte
			if err := pool.QueryRow(ctx,
				`SELECT status, state_json, error_json FROM run_nodes WHERE run_id=$1 AND node_id='gate'`, runID).
				Scan(&nodeStatus, &state, &errorJSON); err != nil {
				t.Fatalf("read approval: %v", err)
			}
			_ = pool.QueryRow(ctx, `SELECT status FROM runs WHERE id=$1`, runID).Scan(&runStatus)
			var persisted struct {
				Waiting map[string]any `json:"waiting"`
			}
			if err := json.Unmarshal(state, &persisted); err != nil {
				t.Fatalf("decode waiting state: %v", err)
			}
			waitingSince, err := time.Parse(time.RFC3339Nano, waitingString(persisted.Waiting["waitingSince"]))
			if err != nil {
				t.Fatalf("parse waitingSince: %v", err)
			}
			deadlineAt, err := time.Parse(time.RFC3339Nano, waitingString(persisted.Waiting["deadlineAt"]))
			if err != nil || deadlineAt.Sub(waitingSince) != 150*time.Millisecond ||
				persisted.Waiting["delayMs"] != float64(150) {
				t.Fatalf("relative deadline must start at checkpoint: waiting=%v deadline=%v err=%v",
					waitingSince, deadlineAt, err)
			}
			if test.escalation {
				if nodeStatus != "waiting" || runStatus != "running" ||
					!containsJSON(state, `"assignee": "tier-2"`, `"timeoutState": "escalated"`, `"escalatedFrom": "tier-1"`) {
					t.Fatalf("escalation must reassign without advancing: node=%s run=%s state=%s", nodeStatus, runStatus, state)
				}
				if err := eng.ResumeRun(ctx, runID, "gate"); err != nil {
					t.Fatalf("resume escalated approval: %v", err)
				}
				waitRun(t, pool, runID, "succeeded", 15*time.Second)
			} else {
				if nodeStatus != "failed" || runStatus != "failed" || !containsJSON(errorJSON, `"code": "`+test.errorCode+`"`) {
					t.Fatalf("terminal policy mismatch: node=%s run=%s error=%s", nodeStatus, runStatus, errorJSON)
				}
				var afterStatus string
				_ = pool.QueryRow(ctx,
					`SELECT status FROM run_nodes WHERE run_id=$1 AND node_id='after'`, runID).Scan(&afterStatus)
				if afterStatus != "pending" {
					t.Fatalf("terminal timeout must not advance downstream, got %s", afterStatus)
				}
			}
			var wakeups int
			_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_wakeups w
				JOIN run_nodes rn ON rn.id=w.run_node_id WHERE rn.run_id=$1`, runID).Scan(&wakeups)
			if wakeups != 0 {
				t.Fatalf("handled deadline wakeup leaked: %d", wakeups)
			}
		})
	}
}

func TestApprovalDeadlineManualResumeAndHASweepRace(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := startWaitingApproval(t, ctx, pool, eng, org)

	past := eng.eventNow().Add(-time.Second)
	deadlineAt := domain.FormatWaitingInstant(past)
	if _, err := pool.Exec(ctx, `
		UPDATE run_nodes
		SET state_json = jsonb_set(state_json, '{waiting,deadlineAt}', to_jsonb($2::text))
		WHERE run_id=$1 AND node_id='gate'`, runID, deadlineAt); err != nil {
		t.Fatalf("set due approval state: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE run_wakeups
		SET wake_at=$2::timestamptz
		WHERE run_node_id=(SELECT id FROM run_nodes WHERE run_id=$1 AND node_id='gate')`, runID, deadlineAt); err != nil {
		t.Fatalf("set due approval wakeup: %v", err)
	}

	errs := make(chan error, 3)
	for range 2 {
		go func() {
			_, err := eng.processApprovalTimeout(context.Background(), runID, "gate", past)
			errs <- err
		}()
	}
	go func() {
		err := eng.ResumeRun(context.Background(), runID, "gate")
		if errors.Is(err, ErrResumeConflict) {
			err = nil
		}
		errs <- err
	}()
	for range 3 {
		if err := <-errs; err != nil {
			t.Fatalf("deadline/resume race: %v", err)
		}
	}

	var causal, terminal, wakeups int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id=$1
		AND type IN ('approval.timed_out','node.resumed')`, runID).Scan(&causal)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id=$1
		AND type IN ('run.failed','run.succeeded')`, runID).Scan(&terminal)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_wakeups w
		JOIN run_nodes rn ON rn.id=w.run_node_id WHERE rn.run_id=$1`, runID).Scan(&wakeups)
	if causal != 1 || terminal != 1 || wakeups != 0 {
		t.Fatalf("exactly one race winner required: causal=%d terminal=%d wakeups=%d", causal, terminal, wakeups)
	}
}

func TestStaleApprovalDeadlineRearmsCurrentGeneration(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := startWaitingApproval(t, ctx, pool, eng, org)
	oldDeadline := eng.eventNow().Add(-time.Second)
	currentDeadline := time.Date(2099, 2, 3, 4, 5, 6, 0, time.UTC)
	currentText := domain.FormatWaitingInstant(currentDeadline)
	if _, err := pool.Exec(ctx, `
		UPDATE run_nodes
		SET state_json = jsonb_set(state_json, '{waiting,deadlineAt}', to_jsonb($2::text))
		WHERE run_id=$1 AND node_id='gate'`, runID, currentText); err != nil {
		t.Fatalf("seed current generation: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE run_wakeups
		SET wake_at=$2
		WHERE run_node_id=(SELECT id FROM run_nodes WHERE run_id=$1 AND node_id='gate')`,
		runID, oldDeadline); err != nil {
		t.Fatalf("seed stale wakeup: %v", err)
	}

	applied, err := eng.processApprovalTimeout(ctx, runID, "gate", oldDeadline)
	if err != nil || applied {
		t.Fatalf("stale generation must not apply: applied=%v err=%v", applied, err)
	}
	var nodeStatus string
	var wakeAt time.Time
	_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id=$1 AND node_id='gate'`, runID).Scan(&nodeStatus)
	_ = pool.QueryRow(ctx, `SELECT wake_at FROM run_wakeups WHERE run_node_id=(
		SELECT id FROM run_nodes WHERE run_id=$1 AND node_id='gate')`, runID).Scan(&wakeAt)
	if nodeStatus != "waiting" || !wakeAt.Equal(currentDeadline) {
		t.Fatalf("current generation was not preserved: status=%s wakeAt=%s", nodeStatus, wakeAt)
	}
}

func TestNodeApprovalCheckpointContinuesInGo(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := org + "-node-checkpoint"
	deadline := eng.eventNow().Add(-time.Second)
	deadlineAt := domain.FormatWaitingInstant(deadline)
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status)
		VALUES ($1, $2, 'node-version', 'running')`, runID, org); err != nil {
		t.Fatalf("seed Node run: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO run_nodes (id, run_id, node_id, status, state_json)
		VALUES ($2, $1, 'gate', 'waiting', jsonb_build_object('waiting', jsonb_build_object(
			'kind','approval','deadlineAt',$3::text,'onTimeout','auto_reject')))`,
		runID, runID+"-gate", deadlineAt); err != nil {
		t.Fatalf("seed Node node checkpoint: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO run_wakeups (run_node_id, wake_at, reason)
		VALUES ($1, $2::timestamptz, 'approval_timeout')`, runID+"-gate", deadlineAt); err != nil {
		t.Fatalf("seed Node deadline clock: %v", err)
	}

	if processed := eng.processDueWaitingWakeups(ctx, store.New(pool)); processed != 1 {
		t.Fatalf("Node checkpoint must be claimed once, got %d", processed)
	}
	var runStatus, nodeStatus string
	var events int
	_ = pool.QueryRow(ctx, `SELECT status FROM runs WHERE id=$1`, runID).Scan(&runStatus)
	_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id=$1 AND node_id='gate'`, runID).Scan(&nodeStatus)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id=$1 AND type='approval.auto_rejected'`, runID).Scan(&events)
	if runStatus != "failed" || nodeStatus != "failed" || events != 1 {
		t.Fatalf("Node checkpoint continuation failed: run=%s node=%s events=%d", runStatus, nodeStatus, events)
	}
}

func TestIndefiniteApprovalClearsInheritedRetryWakeup(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, approvalDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	claims, err := eng.claimBatch(ctx, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim approval: %+v err=%v", claims, err)
	}
	claim := claims[0]
	if _, err := pool.Exec(ctx, `INSERT INTO run_wakeups (run_node_id, wake_at, reason)
		VALUES ($1, now()-interval '1 second', 'retry')`, claim.RowID); err != nil {
		t.Fatalf("seed inherited retry wakeup: %v", err)
	}
	if err := eng.MarkNodeWaiting(ctx, claim, executors.Waiting{
		Reason:   "Waiting for human approval",
		Metadata: map[string]any{"kind": "approval", "resumeToken": runID + ":gate"},
	}); err != nil {
		t.Fatalf("mark waiting: %v", err)
	}
	var wakeups int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_wakeups WHERE run_node_id=$1`, claim.RowID).Scan(&wakeups)
	if wakeups != 0 {
		t.Fatalf("indefinite human wait inherited a retry clock: %d", wakeups)
	}
}

func startWaitingApproval(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, org string) string {
	t.Helper()
	doc := `{"nodes":[{"id":"gate","type":"approval","config":{
		"until":"2099-01-01T00:00:00Z","onTimeout":"fail"
	}}],"edges":[]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	stop := startPool(t, eng)
	waitForNodeStatus(t, ctx, pool, runID, "gate", "waiting", 10*time.Second)
	stop()
	return runID
}

func waitForRunEvent(t *testing.T, ctx context.Context, pool *pgxpool.Pool, runID, eventType string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var count int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id=$1 AND type=$2`, runID, eventType).Scan(&count)
		if count > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("event %s did not arrive", eventType)
}

func waitForNodeStatus(t *testing.T, ctx context.Context, pool *pgxpool.Pool, runID, nodeID, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		var status string
		_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id=$1 AND node_id=$2`, runID, nodeID).Scan(&status)
		if status == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("node %s did not reach %s", nodeID, want)
}

func containsJSON(raw []byte, fragments ...string) bool {
	compact := string(raw)
	for _, fragment := range fragments {
		if !containsIgnoringSpaces(compact, fragment) {
			return false
		}
	}
	return true
}

func containsIgnoringSpaces(value, fragment string) bool {
	removeSpaces := func(text string) string {
		result := make([]byte, 0, len(text))
		for index := range len(text) {
			if text[index] != ' ' && text[index] != '\n' && text[index] != '\t' {
				result = append(result, text[index])
			}
		}
		return string(result)
	}
	return strings.Contains(removeSpaces(value), removeSpaces(fragment))
}
