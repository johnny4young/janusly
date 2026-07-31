//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
)

// The rules-planner agent loop through real runs: the reference's fixture
// ladder (explicit tool / uppercase goal / http goal), the step budget
// cutting clean at maxSteps, and a validation dry-run never executing a
// write-side plan.
func TestAgentLoopRulesPlanner(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()
	t.Setenv("ANTHROPIC_API_KEY", "")

	org := fmt.Sprintf("org-agent-%d", time.Now().UnixNano())
	agentRun := func(id string, config map[string]any, replayMode string) (string, map[string]any) {
		wf := &domain.Workflow{
			ID: id, Name: "Agent", DSLVersion: "1.0",
			Nodes: []domain.Node{{ID: "a", Type: "agent", Config: config}},
			Edges: []domain.Edge{},
		}
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf, ReplayMode: replayMode})
		if err != nil {
			t.Fatalf("start %s: %v", id, err)
		}
		waitRunStatus(t, pool, runID, "succeeded", 0)
		var raw []byte
		_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'a'`, runID).Scan(&raw)
		var state struct {
			Output map[string]any `json:"output"`
		}
		_ = json.Unmarshal(raw, &state)
		return runID, state.Output
	}

	// Fixture 1: uppercase goal → text.uppercase, budget of 2 cuts clean.
	_, output := agentRun("wf-agent-upper", map[string]any{
		"goal": "uppercase the greeting", "value": "hola", "maxSteps": float64(2),
	}, "")
	steps := output["steps"].([]any)
	if len(steps) != 2 {
		t.Fatalf("budget must cut at maxSteps: %d", len(steps))
	}
	first := steps[0].(map[string]any)
	result := first["result"].(map[string]any)
	if result["value"] != "HOLA" || first["plan"].(map[string]any)["tool"] != "text.uppercase" {
		t.Fatalf("rules ladder uppercase: %+v", first)
	}

	// Fixture 2: explicit tool config wins the ladder.
	_, output = agentRun("wf-agent-explicit", map[string]any{
		"goal": "whatever", "tool": "json.pick", "maxSteps": float64(1),
		"input": map[string]any{"path": "a.b", "source": map[string]any{"a": map[string]any{"b": 42}}},
	}, "")
	steps = output["steps"].([]any)
	plan := steps[0].(map[string]any)["plan"].(map[string]any)
	if plan["tool"] != "json.pick" || plan["reason"] != "Explicit tool selected by node config" {
		t.Fatalf("explicit tool: %+v", plan)
	}

	// Fixture 3: http goal plans http.request through the guarded stack.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer target.Close()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	runID, output := agentRun("wf-agent-http", map[string]any{
		"goal": "call api for status", "url": target.URL, "maxSteps": float64(1),
	}, "")
	steps = output["steps"].([]any)
	httpResult := steps[0].(map[string]any)["result"].(map[string]any)
	if httpResult["ok"] != true || httpResult["statusCode"] != float64(200) {
		t.Fatalf("http.request through the node machinery: %+v", httpResult)
	}
	// The reasoning event family landed.
	var reasoningEvents int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1 AND type = 'agent.reasoning'`, runID).Scan(&reasoningEvents)
	if reasoningEvents == 0 {
		t.Fatal("agent.reasoning events must emit")
	}

	// Fixture 4: dry-run NEVER executes a write-side plan (POST).
	var hits int
	writeTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{}`))
	}))
	defer writeTarget.Close()
	_, output = agentRun("wf-agent-dry", map[string]any{
		"goal": "call api to mutate", "url": writeTarget.URL, "method": "POST", "maxSteps": float64(1),
	}, "validation")
	steps = output["steps"].([]any)
	dryResult := steps[0].(map[string]any)["result"].(map[string]any)
	if dryResult["skipped"] != true || hits != 0 {
		t.Fatalf("dry run must skip the write: %+v hits=%d", dryResult, hits)
	}
}
