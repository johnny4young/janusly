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
	// The author of the saved version and every redriver count too.
	if _, err := pool.Exec(ctx, `INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json, created_by)
		VALUES ($1, $2, 'wf-child', 1, '{}', 'erin')`, child+"-v", org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET workflow_version_id = $2 WHERE id = $1`, child, child+"-v"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO run_redrivers (run_id, actor) VALUES ($1, 'frank')`, parent); err != nil {
		t.Fatal(err)
	}
	requesters, err := store.New(pool).ListToolApprovalRequesters(ctx, store.ListToolApprovalRequestersParams{RunID: child, NodeID: "call"})
	if err != nil || strings.Join(requesters, ",") != "alice,dave,erin,frank" {
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

// pauseAndDecide claims the step, pauses it at the gate and records a decision.
func pauseAndDecide(t *testing.T, ctx context.Context, eng *Engine, org string, input map[string]any, status string) (ClaimedNode, string) {
	t.Helper()
	claim := claimNext(t, ctx, eng, org)
	waiting, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", input, nil)
	if err != nil || !paused {
		t.Fatalf("gate must pause: %v", err)
	}
	if err := eng.MarkNodeWaiting(ctx, claim, waiting); err != nil {
		t.Fatal(err)
	}
	approvalID := waiting.Metadata["approvalId"].(string)
	if _, _, err := eng.DecideToolApproval(ctx, ToolApprovalDecision{
		OrgID: org, ApprovalID: approvalID, Actor: "bob", ParamsDigest: waiting.Metadata["paramsDigest"].(string), Status: status,
	}); err != nil {
		t.Fatal(err)
	}
	return claimNext(t, ctx, eng, org), approvalID
}

func requireApprovalCode(t *testing.T, err error, code string) {
	t.Helper()
	var execErr *ExecError
	if !errors.As(err, &execErr) || execErr.Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

// Rotating or repointing a named credential changes the bound call.
func TestToolApprovalBindsTheCredentialRevision(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	if _, err := pool.Exec(ctx, `INSERT INTO credentials (id, org_id, name, kind, secret_ref) VALUES ($1, $2, 'hook', 'webhook_secret', 'env:A')`, org+"-cred", org); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"value": "a", "credential": "hook"}
	claim, _ := pauseAndDecide(t, ctx, eng, org, input, ToolApprovalApproved)
	if _, err := pool.Exec(ctx, `UPDATE credentials SET secret_ref = 'env:B', updated_at = now() WHERE id = $1`, org+"-cred"); err != nil {
		t.Fatal(err)
	}
	_, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", input, nil)
	if paused {
		t.Fatal("a repointed credential must not run")
	}
	requireApprovalCode(t, err, "TOOL_APPROVAL_PARAMS_CHANGED")
}

// An approval is only good until its deadline, even when nobody claimed the step.
func TestToolApprovalCannotBeSpentAfterItsDeadline(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	claim, _ := pauseAndDecide(t, ctx, eng, org, map[string]any{"value": "a"}, ToolApprovalApproved)
	if _, err := pool.Exec(ctx, `UPDATE tool_approval_requests SET expires_at = now() - interval '1 second' WHERE run_id = $1`, runID); err != nil {
		t.Fatal(err)
	}
	_, _, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil)
	requireApprovalCode(t, err, "TOOL_APPROVAL_EXPIRED")
}

// A redrive gives up an unspent decision, bars the redriver, and keeps
// everyone an earlier request for the step excluded.
func TestToolApprovalRedriveRetiresTheDecisionAndBarsTheRedriver(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	_, approvalID := pauseAndDecide(t, ctx, eng, org, map[string]any{"value": "a"}, ToolApprovalApproved)
	if _, err := pool.Exec(ctx, `UPDATE run_nodes SET status = 'failed' WHERE run_id = $1`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET status = 'failed' WHERE id = $1`, runID); err != nil {
		t.Fatal(err)
	}
	if err := eng.RedriveRunNode(ctx, org, runID, "call", "dave"); err != nil {
		t.Fatal(err)
	}
	claim := claimNext(t, ctx, eng, org)
	next, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil)
	if err != nil || !paused || next.Metadata["approvalId"] == approvalID {
		t.Fatalf("the redrive reused the earlier approval: paused=%v %v", paused, err)
	}
	var requesters string
	if err := pool.QueryRow(ctx, `SELECT array_to_string(requester_ids, ',') FROM tool_approval_requests WHERE id = $1`, next.Metadata["approvalId"]).Scan(&requesters); err != nil || requesters != "alice,dave" {
		t.Fatalf("requesters %q %v", requesters, err)
	}
}

// A replay with a suggested workflow may not drop or retype a gate.
func TestToolApprovalSnapshotSwapKeepsTheGate(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	claim, _ := pauseAndDecide(t, ctx, eng, org, map[string]any{"value": "a"}, ToolApprovalDenied)
	_, _, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil)
	if err := eng.FailNode(ctx, claim, err); err != nil {
		t.Fatal(err)
	}
	var deadLetterID string
	if err := pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&deadLetterID); err != nil {
		t.Fatal(err)
	}
	fix := func(config map[string]any) []byte {
		raw, _ := json.Marshal(domain.Workflow{ID: "wf-tool-approval", Name: "Tool approval", DSLVersion: "1.0",
			Nodes: []domain.Node{{ID: "call", Type: "tool", Config: config}}, Edges: []domain.Edge{}})
		return raw
	}
	var dropped *ToolApprovalDroppedError
	for _, config := range []map[string]any{
		{"tool": "text.uppercase", "input": map[string]any{"value": "a"}},
		{"tool": "text.uppercase", "input": map[string]any{"value": "a"}, "requireApproval": false},
	} {
		err := eng.RedriveDeadLetterWithOptions(ctx, org, deadLetterID, RedriveOptions{FixWorkflowJSON: fix(config), RequestedBy: "alice"})
		if !errors.As(err, &dropped) || dropped.NodeID != "call" {
			t.Fatalf("a fix without the gate was applied: %v", err)
		}
	}
	if err := eng.RedriveDeadLetterWithOptions(ctx, org, deadLetterID, RedriveOptions{
		FixWorkflowJSON: fix(map[string]any{"tool": "text.uppercase", "input": map[string]any{"value": "b"}, "requireApproval": true}), RequestedBy: "alice",
	}); err != nil {
		t.Fatalf("a fix that keeps the gate must apply: %v", err)
	}
}

// A start whose document drops a gate the saved workflow has is refused.
func TestStartRunKeepsTheSavedGate(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	saved, _ := json.Marshal(domain.Workflow{ID: "wf-saved-gate", Name: "Saved", DSLVersion: "1.0",
		Nodes: []domain.Node{approvalTool(map[string]any{"value": "a"})}, Edges: []domain.Edge{}})
	if _, err := pool.Exec(ctx, `INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json) VALUES ($1, $2, 'wf-saved-gate', 1, $3)`, org+"-v1", org, saved); err != nil {
		t.Fatal(err)
	}
	start := func(config map[string]any) error {
		_, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: &domain.Workflow{ID: "wf-saved-gate", Name: "Saved", DSLVersion: "1.0",
			Nodes: []domain.Node{{ID: "call", Type: "tool", Config: config}}, Edges: []domain.Edge{}}})
		return err
	}
	var dropped *ToolApprovalDroppedError
	if err := start(map[string]any{"tool": "text.uppercase", "input": map[string]any{"value": "a"}}); !errors.As(err, &dropped) {
		t.Fatalf("an unflagged copy started: %v", err)
	}
	if err := start(map[string]any{"tool": "text.uppercase", "input": map[string]any{"value": "b"}, "requireApproval": true}); err != nil {
		t.Fatalf("a flagged edit must start: %v", err)
	}
}

// Masked values stay hidden, but the request says where they are.
func TestToolApprovalMarksMaskedValues(t *testing.T) {
	ctx, _, eng, org := newHarness(t)
	startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	claim := claimNext(t, ctx, eng, org)
	waiting, _, err := eng.gateToolApproval(ctx, claim, "text.uppercase",
		map[string]any{"value": "token sk-123", "headers": map[string]any{"authorization": map[string]any{"scheme": "Bearer"}}}, []string{"sk-123"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(waiting.Metadata)
	if strings.Contains(string(raw), "sk-123") || strings.Contains(string(raw), "Bearer") {
		t.Fatalf("a secret reached the approver: %s", raw)
	}
	if got := strings.Join(waiting.Metadata["maskedPaths"].([]string), ","); got != "headers.authorization,value" {
		t.Fatalf("masked paths %q", got)
	}
}
