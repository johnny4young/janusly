//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
)

func startToolApprovalRun(t *testing.T, ctx context.Context, eng *Engine, org, createdBy string, nodes []domain.Node, edges []domain.Edge) string {
	t.Helper()
	if edges == nil {
		edges = []domain.Edge{}
	}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, CreatedBy: createdBy, Workflow: &domain.Workflow{
		ID: "wf-tool-approval", Name: "Tool approval", DSLVersion: "1.0", Nodes: nodes, Edges: edges,
	}})
	if err != nil {
		t.Fatal(err)
	}
	return runID
}

func approvalTool(input map[string]any) domain.Node {
	return domain.Node{ID: "call", Type: "tool", Config: map[string]any{
		"tool": "text.uppercase", "input": input, "requireApproval": true,
	}}
}

func claimNext(t *testing.T, ctx context.Context, eng *Engine, org string) ClaimedNode {
	t.Helper()
	claims, err := eng.claimBatch(ctx, 1)
	if err != nil || len(claims) != 1 {
		t.Fatalf("claim: %d claims, %v", len(claims), err)
	}
	claims[0].OrgID = org
	return claims[0]
}

func waitForSQL(t *testing.T, ctx context.Context, pool *pgxpool.Pool, want, query string, args ...any) string {
	t.Helper()
	var got string
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(25 * time.Millisecond) {
		if err := pool.QueryRow(ctx, query, args...).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got == want {
			return got
		}
	}
	t.Fatalf("waited for %q, last %q", want, got)
	return got
}

func runToolApprovalWorkers(t *testing.T, eng *Engine) {
	t.Helper()
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 1, 20*time.Millisecond, dispatcher.Execute, quietLogger())
	}()
	t.Cleanup(func() { stop(); <-done })
}

// The step pauses before the call, refuses its starter and a stale digest,
// then runs the exact approved parameters once.
func TestToolApprovalRunsOnlyTheApprovedCall(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runToolApprovalWorkers(t, eng)
	runID := startToolApprovalRun(t, ctx, eng, org, "alice",
		[]domain.Node{approvalTool(map[string]any{"value": "snooze {{context.input.id}}"})}, nil)

	waitForSQL(t, ctx, pool, "waiting", `SELECT status FROM run_nodes WHERE run_id = $1`, runID)
	var state []byte
	if err := pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1`, runID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	var waiting struct {
		Waiting struct {
			Kind, ApprovalID, Tool, ParamsDigest string
			Params                               map[string]any
		}
	}
	if err := json.Unmarshal(state, &waiting); err != nil || waiting.Waiting.Kind != "tool_approval" ||
		waiting.Waiting.Tool != "text.uppercase" || waiting.Waiting.Params["value"] != "snooze " {
		t.Fatalf("waiting state %s (%v)", state, err)
	}
	pending := waiting.Waiting
	decide := func(actor, digest, status string) (bool, error) {
		_, replayed, err := eng.DecideToolApproval(ctx, ToolApprovalDecision{
			OrgID: org, ApprovalID: pending.ApprovalID, Actor: actor, ParamsDigest: digest, Status: status,
		})
		return replayed, err
	}
	if _, err := decide("alice", pending.ParamsDigest, ToolApprovalApproved); !errors.Is(err, ErrToolApprovalSelf) {
		t.Fatalf("starter approval: %v", err)
	}
	if _, err := decide("bob", "other", ToolApprovalApproved); !errors.Is(err, ErrToolApprovalStale) {
		t.Fatalf("stale digest: %v", err)
	}
	if _, _, err := eng.DecideToolApproval(ctx, ToolApprovalDecision{
		OrgID: "org-other", ApprovalID: pending.ApprovalID, Actor: "bob", ParamsDigest: pending.ParamsDigest, Status: ToolApprovalApproved,
	}); !errors.Is(err, ErrToolApprovalNotFound) {
		t.Fatalf("cross-org decision: %v", err)
	}
	if err := eng.ResumeRun(ctx, runID, "call"); !errors.Is(err, ErrResumeConflict) {
		t.Fatalf("generic resume must not complete a tool approval: %v", err)
	}
	if replayed, err := decide("bob", pending.ParamsDigest, ToolApprovalApproved); err != nil || replayed {
		t.Fatalf("approve: replayed=%v %v", replayed, err)
	}
	waitForSQL(t, ctx, pool, "succeeded", `SELECT status FROM runs WHERE id = $1`, runID)
	var output string
	if err := pool.QueryRow(ctx, `SELECT state_json #>> '{output,result,value}' FROM run_nodes WHERE run_id = $1`, runID).Scan(&output); err != nil || output != "SNOOZE " {
		t.Fatalf("tool output %q %v", output, err)
	}
	if replayed, err := decide("bob", pending.ParamsDigest, ToolApprovalApproved); err != nil || !replayed {
		t.Fatalf("repeat approval: replayed=%v %v", replayed, err)
	}
	if _, err := decide("carol", pending.ParamsDigest, ToolApprovalDenied); !errors.Is(err, ErrToolApprovalConflict) {
		t.Fatalf("late deny: %v", err)
	}
}

// Deny is terminal for that execution: no retry asks again, and an on-error
// edge carries the run down its branch.
func TestToolApprovalDenyFollowsTheErrorBranch(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runToolApprovalWorkers(t, eng)
	call := approvalTool(map[string]any{"value": "page"})
	call.Config["retry"] = map[string]any{"maxAttempts": 3, "delayMs": 1}
	runID := startToolApprovalRun(t, ctx, eng, org, "alice",
		[]domain.Node{call, {ID: "notify", Type: "noop", Config: map[string]any{}}},
		[]domain.Edge{{From: "call", To: "notify", OnError: true}})

	approvalID := waitForApproval(t, ctx, pool, runID)
	row, _, err := eng.DecideToolApproval(ctx, ToolApprovalDecision{
		OrgID: org, ApprovalID: approvalID, Actor: "bob", ParamsDigest: approvalDigest(t, ctx, pool, approvalID), Status: ToolApprovalDenied,
	})
	if err != nil || row.RunID != runID {
		t.Fatal(err)
	}
	waitForSQL(t, ctx, pool, "succeeded", `SELECT status FROM runs WHERE id = $1`, runID)
	var code string
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT error_json->>'code', attempts FROM run_nodes WHERE run_id = $1 AND node_id = 'call'`, runID).Scan(&code, &attempts); err != nil {
		t.Fatal(err)
	}
	if code != "TOOL_APPROVAL_DENIED" || attempts != 1 {
		t.Fatalf("denied step code %q after %d attempts", code, attempts)
	}
	waitForSQL(t, ctx, pool, "succeeded", `SELECT status FROM run_nodes WHERE run_id = $1 AND node_id = 'notify'`, runID)
}

func TestToolApprovalExpiryFailsTheStep(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runToolApprovalWorkers(t, eng)
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "x"})}, nil)
	approvalID := waitForApproval(t, ctx, pool, runID)
	digest := approvalDigest(t, ctx, pool, approvalID)
	if _, err := pool.Exec(ctx, `UPDATE tool_approval_requests SET expires_at = now() - interval '1 second' WHERE id = $1`, approvalID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := eng.DecideToolApproval(ctx, ToolApprovalDecision{
		OrgID: org, ApprovalID: approvalID, Actor: "bob", ParamsDigest: digest, Status: ToolApprovalApproved,
	}); !errors.Is(err, ErrToolApprovalConflict) {
		t.Fatalf("approval after expiry: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE run_wakeups SET wake_at = now() - interval '1 second'
		WHERE run_node_id = (SELECT id FROM run_nodes WHERE run_id = $1)`, runID); err != nil {
		t.Fatal(err)
	}
	waitForSQL(t, ctx, pool, "failed", `SELECT status FROM runs WHERE id = $1`, runID)
	waitForSQL(t, ctx, pool, "TOOL_APPROVAL_EXPIRED", `SELECT error_json->>'code' FROM run_nodes WHERE run_id = $1`, runID)
}

// One approval covers one execution of the exact parameters: a re-claim
// after it is spent (retry, restart, redrive) must ask again, and changed
// parameters never run.
func TestToolApprovalIsSingleUseAndBoundToParameters(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	approved := map[string]any{"value": "a"}

	claim := claimNext(t, ctx, eng, org)
	waiting, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", approved, nil)
	if err != nil || !paused {
		t.Fatalf("first claim must pause: %v", err)
	}
	if err := eng.MarkNodeWaiting(ctx, claim, waiting); err != nil {
		t.Fatal(err)
	}
	approvalID := waiting.Metadata["approvalId"].(string)
	if _, _, err := eng.DecideToolApproval(ctx, ToolApprovalDecision{
		OrgID: org, ApprovalID: approvalID, Actor: "bob", ParamsDigest: waiting.Metadata["paramsDigest"].(string), Status: ToolApprovalApproved,
	}); err != nil {
		t.Fatal(err)
	}
	claim = claimNext(t, ctx, eng, org)
	_, paused, err = eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "b"}, nil)
	var execErr *ExecError
	if paused || !errors.As(err, &execErr) || execErr.Code != "TOOL_APPROVAL_PARAMS_CHANGED" {
		t.Fatalf("changed parameters ran: paused=%v %v", paused, err)
	}
	next, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", approved, nil)
	if err != nil || !paused || next.Metadata["approvalId"] == approvalID {
		t.Fatalf("a spent approval was reused: paused=%v %v", paused, err)
	}
	var live int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM tool_approval_requests WHERE run_id = $1 AND consumed_at IS NULL`, runID).Scan(&live); err != nil || live != 1 {
		t.Fatalf("live requests %d %v", live, err)
	}
}

// Concurrent approvers serialize on the run: exactly one decision lands.
func TestToolApprovalConcurrentDecisionsHaveOneWinner(t *testing.T) {
	ctx, _, eng, org := newHarness(t)
	startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	claim := claimNext(t, ctx, eng, org)
	waiting, _, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := eng.MarkNodeWaiting(ctx, claim, waiting); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 6)
	for index := range 6 {
		status := ToolApprovalApproved
		if index%2 == 1 {
			status = ToolApprovalDenied
		}
		go func() {
			_, _, err := eng.DecideToolApproval(ctx, ToolApprovalDecision{
				OrgID: org, ApprovalID: waiting.Metadata["approvalId"].(string), Actor: "approver-" + string(rune('a'+index)),
				ParamsDigest: waiting.Metadata["paramsDigest"].(string), Status: status,
			})
			results <- err
		}()
	}
	wins := 0
	for range 6 {
		if err := <-results; err == nil {
			wins++
		} else if !errors.Is(err, ErrToolApprovalConflict) {
			t.Fatal(err)
		}
	}
	if wins != 1 {
		t.Fatalf("%d decisions landed", wins)
	}
}

// A subworkflow child has no starter of its own; its parent's starter and a
// redrive operator count as requesters.
func TestToolApprovalRequestersSpanSubworkflowLineage(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	parent := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{{ID: "sub", Type: "noop", Config: map[string]any{}}}, nil)
	child, err := eng.StartRun(ctx, StartInput{OrgID: org, ParentRunID: parent, ParentNodeID: "sub", ParentLinkKind: "subworkflow",
		Workflow: &domain.Workflow{ID: "wf-child", Name: "Child", DSLVersion: "1.0", Nodes: []domain.Node{approvalTool(map[string]any{"value": "a"})}, Edges: []domain.Edge{}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE run_nodes SET recovery_requested_by = 'dave' WHERE run_id = $1`, child); err != nil {
		t.Fatal(err)
	}
	requesters, err := store.New(pool).ListToolApprovalRequesters(ctx, child)
	if err != nil || strings.Join(requesters, ",") != "alice,dave" {
		t.Fatalf("requesters %v %v", requesters, err)
	}
}

func waitForApproval(t *testing.T, ctx context.Context, pool *pgxpool.Pool, runID string) string {
	t.Helper()
	waitForSQL(t, ctx, pool, "tool_approval", `SELECT coalesce(state_json #>> '{waiting,kind}', '') FROM run_nodes WHERE run_id = $1 AND node_id = 'call'`, runID)
	var id string
	if err := pool.QueryRow(ctx, `SELECT id FROM tool_approval_requests WHERE run_id = $1 AND consumed_at IS NULL`, runID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func approvalDigest(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var digest string
	if err := pool.QueryRow(ctx, `SELECT params_digest FROM tool_approval_requests WHERE id = $1`, id).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	return digest
}

// Validation suppresses the write itself, so only a call that would really
// run (a read) still waits for a person there.
func TestToolApprovalInValidationRuns(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runToolApprovalWorkers(t, eng)
	start := func(node domain.Node) string {
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, CreatedBy: "alice", ReplayMode: "validation", Workflow: &domain.Workflow{
			ID: "wf-tool-approval-validation", Name: "Validation", DSLVersion: "1.0", Nodes: []domain.Node{node}, Edges: []domain.Edge{},
		}})
		if err != nil {
			t.Fatal(err)
		}
		return runID
	}
	write := start(domain.Node{ID: "call", Type: "tool", Config: map[string]any{"tool": "webhook.send", "requireApproval": true,
		"input": map[string]any{"credential": "hook", "url": "https://hooks.example.test/x", "payload": map[string]any{}}}})
	waitForSQL(t, ctx, pool, "succeeded", `SELECT status FROM runs WHERE id = $1`, write)
	waitForSQL(t, ctx, pool, "validation_dry_run", `SELECT state_json #>> '{output,result,reason}' FROM run_nodes WHERE run_id = $1`, write)
	read := start(approvalTool(map[string]any{"value": "a"}))
	waitForApproval(t, ctx, pool, read)
}
