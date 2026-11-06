//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
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
	return domain.Node{ID: "call", Type: "tool", Config: map[string]any{"tool": "text.uppercase", "input": input}}
}

// requireApprovalFor lists tools in the org's approval policy.
func requireApprovalFor(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, tools string) {
	t.Helper()
	value, _ := json.Marshal(tools)
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'tools.approvalRequired', $3, 'integrations', 'test', 'string')`, org+"-policy", org, value); err != nil {
		t.Fatal(err)
	}
}

// claimNext claims the run's queued "call" step directly, so a queued step
// left by another test in the shared database is never picked instead.
func claimNext(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, runID string) ClaimedNode {
	t.Helper()
	claim := ClaimedNode{RunID: runID, NodeID: "call", OrgID: org}
	if err := pool.QueryRow(ctx, `UPDATE run_nodes SET status = 'running', started_at = now()
		WHERE run_id = $1 AND node_id = 'call' AND status = 'queued' RETURNING id, coalesce(attempts, 1)`, runID).Scan(&claim.RowID, &claim.Attempt); err != nil {
		t.Fatalf("claim: %v", err)
	}
	return claim
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
	requireApprovalFor(t, ctx, pool, org, "text.uppercase, webhook.send")
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
	requireApprovalFor(t, ctx, pool, org, "text.uppercase, webhook.send")
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
	requireApprovalFor(t, ctx, pool, org, "text.uppercase, webhook.send")
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
	requireApprovalFor(t, ctx, pool, org, "text.uppercase, webhook.send")
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	approved := map[string]any{"value": "a"}

	claim := claimNext(t, ctx, pool, org, runID)
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
	claim = claimNext(t, ctx, pool, org, runID)
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
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "text.uppercase, webhook.send")
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	claim := claimNext(t, ctx, pool, org, runID)
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
	requireApprovalFor(t, ctx, pool, org, "text.uppercase, webhook.send")
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
	write := start(domain.Node{ID: "call", Type: "tool", Config: map[string]any{"tool": "webhook.send",
		"input": map[string]any{"credential": "hook", "url": "https://hooks.example.test/x", "payload": map[string]any{}}}})
	waitForSQL(t, ctx, pool, "succeeded", `SELECT status FROM runs WHERE id = $1`, write)
	waitForSQL(t, ctx, pool, "validation_dry_run", `SELECT state_json #>> '{output,result,reason}' FROM run_nodes WHERE run_id = $1`, write)
	read := start(approvalTool(map[string]any{"value": "a"}))
	waitForApproval(t, ctx, pool, read)
}

// pauseAndDecide claims the step, pauses it at the gate and records a decision.
func pauseAndDecide(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, org, runID string, input map[string]any, status string) (ClaimedNode, string) {
	t.Helper()
	claim := claimNext(t, ctx, pool, org, runID)
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
	return claimNext(t, ctx, pool, org, runID), approvalID
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
	requireApprovalFor(t, ctx, pool, org, "text.uppercase, webhook.send")
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	if _, err := pool.Exec(ctx, `INSERT INTO credentials (id, org_id, name, kind, secret_ref) VALUES ($1, $2, 'hook', 'webhook_secret', 'env:A')`, org+"-cred", org); err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"value": "a", "credential": "hook"}
	claim, _ := pauseAndDecide(t, ctx, pool, eng, org, runID, input, ToolApprovalApproved)
	if _, err := pool.Exec(ctx, `UPDATE credentials SET secret_ref = 'env:B', updated_at = now() WHERE id = $1`, org+"-cred"); err != nil {
		t.Fatal(err)
	}
	_, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", input, nil)
	if paused {
		t.Fatal("a repointed credential must not run")
	}
	requireApprovalCode(t, err, "TOOL_APPROVAL_PARAMS_CHANGED")
}

// A timely approval survives a busy queue: it may be spent after the decision
// deadline, but not long after the decision itself.
func TestToolApprovalSpendWindowFollowsTheDecision(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "text.uppercase")
	for _, test := range []struct {
		decidedAgo string
		wantErr    bool
	}{{"1 second", false}, {"31 minutes", true}} {
		runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
		claim, _ := pauseAndDecide(t, ctx, pool, eng, org, runID, map[string]any{"value": "a"}, ToolApprovalApproved)
		if _, err := pool.Exec(ctx, `UPDATE tool_approval_requests SET expires_at = now() - interval '1 second',
			decided_at = now() - $2::interval, created_at = now() - interval '2 hours' WHERE run_id = $1`, runID, test.decidedAgo); err != nil {
			t.Fatal(err)
		}
		_, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil)
		if test.wantErr {
			requireApprovalCode(t, err, "TOOL_APPROVAL_EXPIRED")
		} else if err != nil || paused {
			t.Fatalf("a timely approval decided %s ago did not run: paused=%v %v", test.decidedAgo, paused, err)
		}
	}
}

// A redrive gives up an unspent decision and bars its redriver.
func TestToolApprovalRedriveRetiresTheDecisionAndBarsTheRedriver(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "text.uppercase, webhook.send")
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	_, approvalID := pauseAndDecide(t, ctx, pool, eng, org, runID, map[string]any{"value": "a"}, ToolApprovalApproved)
	if _, err := pool.Exec(ctx, `UPDATE run_nodes SET status = 'failed' WHERE run_id = $1`, runID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET status = 'failed' WHERE id = $1`, runID); err != nil {
		t.Fatal(err)
	}
	if err := eng.RedriveRunNode(ctx, org, runID, "call", "dave"); err != nil {
		t.Fatal(err)
	}
	claim := claimNext(t, ctx, pool, org, runID)
	next, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil)
	if err != nil || !paused || next.Metadata["approvalId"] == approvalID {
		t.Fatalf("the redrive reused the earlier approval: paused=%v %v", paused, err)
	}
	var requesters string
	if err := pool.QueryRow(ctx, `SELECT array_to_string(requester_ids, ',') FROM tool_approval_requests WHERE id = $1`, next.Metadata["approvalId"]).Scan(&requesters); err != nil || requesters != "alice,dave" {
		t.Fatalf("requesters %q %v", requesters, err)
	}
}

// Masked values stay hidden, but the request says where they are.
func TestToolApprovalMarksMaskedValues(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "text.uppercase, webhook.send")
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	claim := claimNext(t, ctx, pool, org, runID)
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

// The policy follows the tool actually called, so renaming the step or moving
// the call into a loop cannot dodge it.
func TestToolApprovalFollowsTheToolNotTheStep(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "text.uppercase")
	runToolApprovalWorkers(t, eng)
	decoy, err := eng.StartRun(ctx, StartInput{OrgID: org, CreatedBy: "alice", Workflow: &domain.Workflow{
		ID: "wf-decoy", Name: "Decoy", DSLVersion: "1.0", Edges: []domain.Edge{},
		Nodes: []domain.Node{{ID: "harmless", Type: "tool", Config: map[string]any{"tool": "text.uppercase", "input": map[string]any{"value": "x"}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	waitForSQL(t, ctx, pool, "tool_approval", `SELECT coalesce(state_json #>> '{waiting,kind}', '') FROM run_nodes WHERE run_id = $1`, decoy)
	looped, err := eng.StartRun(ctx, StartInput{OrgID: org, CreatedBy: "alice", Workflow: &domain.Workflow{
		ID: "wf-loop", Name: "Loop", DSLVersion: "1.0", Edges: []domain.Edge{},
		Nodes: []domain.Node{{ID: "each", Type: "loop", Config: map[string]any{
			"mode": "for_each", "items": []any{"a"}, "tool": "text.uppercase", "input": map[string]any{"value": "{{item}}"}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	waitForSQL(t, ctx, pool, "failed", `SELECT status FROM runs WHERE id = $1`, looped)
	var output string
	_ = pool.QueryRow(ctx, `SELECT coalesce(state_json::text, '') || coalesce(error_json::text, '') FROM run_nodes WHERE run_id = $1`, looped).Scan(&output)
	if !strings.Contains(output, "TOOL_APPROVAL_REQUIRED") {
		t.Fatalf("a listed tool ran inside a loop: %s", output)
	}
}

// Without per-step flags, starting an older document and redriving an older
// run work as before; the policy then gates the call.
func TestOlderDocumentsAndRunsStillStartAndRedrive(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	if err := eng.FailNode(ctx, claimNext(t, ctx, pool, org, runID), errors.New("upstream down")); err != nil {
		t.Fatal(err)
	}
	requireApprovalFor(t, ctx, pool, org, "text.uppercase")
	saved, _ := json.Marshal(domain.Workflow{ID: "wf-tool-approval", Name: "Newer", DSLVersion: "1.0", Nodes: []domain.Node{{ID: "other", Type: "noop"}}, Edges: []domain.Edge{}})
	if _, err := pool.Exec(ctx, `INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json) VALUES ($1, $2, 'wf-tool-approval', 2, $3)`, org+"-v2", org, saved); err != nil {
		t.Fatal(err)
	}
	startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "b"})}, nil)
	if err := eng.RedriveRunNode(ctx, org, runID, "call", "dave"); err != nil {
		t.Fatalf("an older run cannot be redriven: %v", err)
	}
	claim := claimNext(t, ctx, pool, org, runID)
	if _, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil); err != nil || !paused {
		t.Fatalf("the redriven call must wait for approval: %v", err)
	}
}

// A form submitter anywhere in the lineage is barred, since rendered
// parameters can read any step; a redriver is barred only for this step and
// the steps upstream of it; earlier requesters carry forward.
func TestToolApprovalRequesterScope(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	parent := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{{ID: "intake", Type: "noop", Config: map[string]any{}}, {ID: "sub", Type: "noop", Config: map[string]any{}}},
		[]domain.Edge{{From: "intake", To: "sub"}})
	child, err := eng.StartRun(ctx, StartInput{OrgID: org, ParentRunID: parent, ParentNodeID: "sub", ParentLinkKind: "subworkflow",
		Workflow: &domain.Workflow{ID: "wf-child", Name: "Child", DSLVersion: "1.0", Edges: []domain.Edge{{From: "form", To: "call"}},
			Nodes: []domain.Node{{ID: "form", Type: "noop"}, {ID: "other", Type: "noop"}, approvalTool(map[string]any{"value": "a"})}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range [][4]string{
		{parent, "intake", "resume", "paula"}, // parent-run form upstream of the subworkflow step
		{parent, "intake", "redrive", "pete"}, // parent redrive of a step that did not start the child
		{child, "form", "resume", "fiona"},
		{child, "other", "resume", "otto"},  // not upstream of the call, but its output is readable
		{child, "other", "redrive", "rita"}, // redrove an unrelated step
		{child, "call", "redrive", "dave"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO run_actors (run_id, node_id, role, actor) VALUES ($1, $2, $3, $4)`, row[0], row[1], row[2], row[3]); err != nil {
			t.Fatal(err)
		}
	}
	// Forms in a sibling subworkflow and in a grandchild can feed this call too.
	subRun := func(parentRunID, parentNodeID string) string {
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, ParentRunID: parentRunID, ParentNodeID: parentNodeID, ParentLinkKind: "subworkflow",
			Workflow: &domain.Workflow{ID: "wf-sub", Name: "Sub", DSLVersion: "1.0", Nodes: []domain.Node{{ID: "ask", Type: "noop"}}, Edges: []domain.Edge{}}})
		if err != nil {
			t.Fatal(err)
		}
		return runID
	}
	for _, row := range [][2]string{{subRun(parent, "sub"), "sam"}, {subRun(child, "other"), "carla"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO run_actors (run_id, node_id, role, actor) VALUES ($1, 'ask', 'resume', $2)`, row[0], row[1]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tool_approval_requests (id, org_id, run_id, node_id, tool, params_json, params_digest, requester_ids, status, consumed_at, expires_at)
		VALUES ($1, $2, $3, 'call', 'text.uppercase', '{}', 'd', '{gina}', 'expired', now(), now())`, child+"-old", org, child); err != nil {
		t.Fatal(err)
	}
	requesters, err := store.New(pool).ListToolApprovalRequesters(ctx, store.ListToolApprovalRequestersParams{
		RunID: child, NodeID: "call", NodeIds: []string{"call", "form"}, MaxDepth: subworkflowDepthWalkerMax,
	})
	if err != nil || strings.Join(requesters, ",") != "alice,carla,dave,fiona,gina,otto,paula,sam" {
		t.Fatalf("requesters %v %v", requesters, err)
	}
}

// Rotating redrivers does not open self-approval: each one stays excluded.
func TestRedriverRotationCannotSelfApprove(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "text.uppercase")
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	fail := func() {
		if _, err := pool.Exec(ctx, `UPDATE run_nodes SET status = 'failed' WHERE run_id = $1`, runID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE runs SET status = 'failed' WHERE id = $1`, runID); err != nil {
			t.Fatal(err)
		}
	}
	claim := claimNext(t, ctx, pool, org, runID)
	if _, _, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil); err != nil {
		t.Fatal(err)
	}
	for _, redriver := range []string{"dave", "erin"} {
		fail()
		if err := eng.RedriveRunNode(ctx, org, runID, "call", redriver); err != nil {
			t.Fatal(err)
		}
		claim = claimNext(t, ctx, pool, org, runID)
	}
	waiting, paused, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil)
	if err != nil || !paused {
		t.Fatalf("gate: %v", err)
	}
	if err := eng.MarkNodeWaiting(ctx, claim, waiting); err != nil {
		t.Fatal(err)
	}
	_, _, err = eng.DecideToolApproval(ctx, ToolApprovalDecision{OrgID: org, ApprovalID: waiting.Metadata["approvalId"].(string),
		Actor: "dave", ParamsDigest: waiting.Metadata["paramsDigest"].(string), Status: ToolApprovalApproved})
	if !errors.Is(err, ErrToolApprovalSelf) {
		t.Fatalf("an earlier redriver approved after another redrive: %v", err)
	}
}

// When no person started the run, whoever saved the version cannot approve
// the parameters they wrote; in a person's run they still can.
func TestVersionAuthorIsBarredOnlyFromUnattendedRuns(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	for index, test := range []struct {
		createdBy, triggeredBy string
		authorBarred           bool
	}{{"system:schedule", "schedule", true}, {"alice", "", false}} {
		input := map[string]any{}
		if test.triggeredBy != "" {
			input["triggeredBy"] = test.triggeredBy
		}
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, CreatedBy: test.createdBy, Input: input, Workflow: &domain.Workflow{
			ID: "wf-authored", Name: "Authored", DSLVersion: "1.0", Nodes: []domain.Node{approvalTool(map[string]any{"value": "a"})}, Edges: []domain.Edge{}}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json, created_by) VALUES ($1, $2, 'wf-authored', $3, '{}', 'erin')`, runID+"-v", org, index+1); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE runs SET workflow_version_id = $2 WHERE id = $1`, runID, runID+"-v"); err != nil {
			t.Fatal(err)
		}
		requesters, err := store.New(pool).ListToolApprovalRequesters(ctx, store.ListToolApprovalRequestersParams{RunID: runID, NodeID: "call", NodeIds: []string{"call"}, MaxDepth: subworkflowDepthWalkerMax})
		if err != nil || slices.Contains(requesters, "erin") != test.authorBarred {
			t.Fatalf("%s run: requesters %v %v", test.createdBy, requesters, err)
		}
	}
}

// A form submission through the resume path records its submitter.
func TestFormSubmitterCannotApproveTheCallDownstream(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "text.uppercase")
	runToolApprovalWorkers(t, eng)
	form := domain.Node{ID: "form", Type: "human_form", Config: map[string]any{"schema": map[string]any{
		"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}}}}}
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{form, approvalTool(map[string]any{"value": "{{context.form.output.value}}"})},
		[]domain.Edge{{From: "form", To: "call"}})
	token := waitForSQL(t, ctx, pool, "", `SELECT CASE WHEN status = 'waiting' THEN '' ELSE 'pending' END FROM run_nodes WHERE run_id = $1 AND node_id = 'form'`, runID)
	_ = token
	var resumeToken string
	if err := pool.QueryRow(ctx, `SELECT state_json #>> '{waiting,resumeToken}' FROM run_nodes WHERE run_id = $1 AND node_id = 'form'`, runID).Scan(&resumeToken); err != nil {
		t.Fatal(err)
	}
	if err := eng.ResumeRunAs(ctx, runID, "form", map[string]any{"value": "q1"}, resumeToken, "fiona"); err != nil {
		t.Fatal(err)
	}
	approvalID := waitForApproval(t, ctx, pool, runID)
	_, _, err := eng.DecideToolApproval(ctx, ToolApprovalDecision{OrgID: org, ApprovalID: approvalID, Actor: "fiona",
		ParamsDigest: approvalDigest(t, ctx, pool, approvalID), Status: ToolApprovalApproved})
	if !errors.Is(err, ErrToolApprovalSelf) {
		t.Fatalf("the form submitter approved the call: %v", err)
	}
}

// A two-person team does not deadlock: the starter cannot decide, the other
// member can, and the request counts that one eligible approver.
func TestTwoMemberOrgCanApprove(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "text.uppercase")
	for _, member := range [][2]string{{"alice", "admin"}, {"bob", "editor"}} {
		if _, err := pool.Exec(ctx, `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`, org+member[0], org, member[0], member[1]); err != nil {
			t.Fatal(err)
		}
	}
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	// Bob saved the version; in a run Alice started by hand he may still approve.
	if _, err := pool.Exec(ctx, `INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json, created_by) VALUES ($1, $2, 'wf-tool-approval', 1, '{}', 'bob')`, runID+"-v", org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET workflow_version_id = $2 WHERE id = $1`, runID, runID+"-v"); err != nil {
		t.Fatal(err)
	}
	claim := claimNext(t, ctx, pool, org, runID)
	waiting, _, err := eng.gateToolApproval(ctx, claim, "text.uppercase", map[string]any{"value": "a"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if waiting.Metadata["eligibleApprovers"] != int32(1) {
		t.Fatalf("eligible approvers %v", waiting.Metadata["eligibleApprovers"])
	}
	if err := eng.MarkNodeWaiting(ctx, claim, waiting); err != nil {
		t.Fatal(err)
	}
	if _, _, err := eng.DecideToolApproval(ctx, ToolApprovalDecision{OrgID: org, ApprovalID: waiting.Metadata["approvalId"].(string),
		Actor: "bob", ParamsDigest: waiting.Metadata["paramsDigest"].(string), Status: ToolApprovalApproved}); err != nil {
		t.Fatalf("the other member could not approve: %v", err)
	}
}

// An unreadable or malformed policy stops the call rather than skipping the gate.
func TestMalformedToolApprovalPolicyFailsClosed(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "Not A Tool")
	runToolApprovalWorkers(t, eng)
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{approvalTool(map[string]any{"value": "a"})}, nil)
	waitForSQL(t, ctx, pool, "failed", `SELECT status FROM runs WHERE id = $1`, runID)
	var output string
	if err := pool.QueryRow(ctx, `SELECT coalesce(state_json #>> '{output}', '') FROM run_nodes WHERE run_id = $1`, runID).Scan(&output); err != nil || output != "" {
		t.Fatalf("the call ran under a malformed policy: %q %v", output, err)
	}
}

// An http step is the http.request call it describes, so the policy gates it.
func TestToolApprovalGatesHTTPSteps(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	requireApprovalFor(t, ctx, pool, org, "http.request")
	runToolApprovalWorkers(t, eng)
	runID := startToolApprovalRun(t, ctx, eng, org, "alice", []domain.Node{{ID: "call", Type: "http", Config: map[string]any{
		"url": "https://hooks.example.test/page", "method": "POST", "headers": map[string]any{"authorization": "Bearer live"}}}}, nil)
	approvalID := waitForApproval(t, ctx, pool, runID)
	var tool, params string
	if err := pool.QueryRow(ctx, `SELECT tool, params_json::text FROM tool_approval_requests WHERE id = $1`, approvalID).Scan(&tool, &params); err != nil {
		t.Fatal(err)
	}
	if tool != "http.request" || strings.Contains(params, "Bearer live") || !strings.Contains(params, "hooks.example.test/page") {
		t.Fatalf("http step request: %s %s", tool, params)
	}
}
