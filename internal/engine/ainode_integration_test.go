//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"

	"github.com/johnny4young/janusly/internal/ai/failcat"
)

func aiWorkflow(id string) *domain.Workflow {
	return &domain.Workflow{
		ID: id, Name: "AI Flow", DSLVersion: "1.0",
		Nodes: []domain.Node{
			{ID: "seed", Type: "transform", Config: map[string]any{"mapping": map[string]any{"topic": "latencia"}}},
			{ID: "brain", Type: "ai", Config: map[string]any{"prompt": "resume {{context.seed.output.topic}}"}},
			{ID: "after", Type: "noop", Config: map[string]any{}},
		},
		Edges: []domain.Edge{{From: "seed", To: "brain"}, {From: "brain", To: "after"}},
	}
}

// The ai node's sacred contract across the ladder: no provider → the node
// COMPLETES with mode:"fallback" and the run succeeds; a live provider →
// mode:"ai" with usage on the state; a DEAD provider → the node still
// completes (never fails the run); a validation replay never dials.
func TestAiNodeFallbackContract(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
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

	org := fmt.Sprintf("org-ainode-%d", time.Now().UnixNano())
	nodeState := func(runID, nodeID string) map[string]any {
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = $2`,
			runID, nodeID).Scan(&raw); err != nil {
			t.Fatalf("read state: %v", err)
		}
		var state struct {
			Output map[string]any `json:"output"`
		}
		if err := json.Unmarshal(raw, &state); err != nil {
			t.Fatalf("decode state: %v", err)
		}
		return state.Output
	}

	// 1. $0: no key — the run SUCCEEDS and the node carries the fallback.
	t.Setenv("ANTHROPIC_API_KEY", "")
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: aiWorkflow("wf-ai-zero")})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	output := nodeState(runID, "brain")
	if output["mode"] != "fallback" || output["response"] == nil {
		t.Fatalf("$0 node output: %+v", output)
	}
	if _, present := output["aiError"]; present {
		t.Fatal("no-provider fallback must not carry aiError")
	}

	// 2. Simulated provider: mode "ai" with usage + rendered prompt.
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"id":"msg_1","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001",
			"content":[{"type":"text","text":"la latencia va bien"}],"stop_reason":"end_turn",
			"usage":{"input_tokens":9,"output_tokens":4}}`)
	}))
	defer server.Close()
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)

	runID, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: aiWorkflow("wf-ai-live")})
	if err != nil {
		t.Fatalf("start live: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 1)
	output = nodeState(runID, "brain")
	if output["mode"] != "ai" || output["response"] != "la latencia va bien" {
		t.Fatalf("live node output: %+v", output)
	}
	if output["providerSimulated"] != true || output["costUsd"] != float64(0) {
		t.Fatalf("simulated call must mark + cost zero: %+v", output)
	}
	if output["prompt"] == nil || !containsString(output["prompt"].(string), "latencia") {
		t.Fatalf("templates must render into the prompt: %+v", output["prompt"])
	}

	// 3. Validation replay: the SDK is NEVER dialed.
	before := calls.Load()
	validationRun, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: aiWorkflow("wf-ai-dry"), ReplayMode: "validation",
	})
	if err != nil {
		t.Fatalf("start validation: %v", err)
	}
	waitRunStatus(t, pool, validationRun, "succeeded", 2)
	output = nodeState(validationRun, "brain")
	if output["mode"] != "fallback" || output["dryRun"] != true {
		t.Fatalf("dry-run output: %+v", output)
	}
	if calls.Load() != before {
		t.Fatalf("dry run must not dial the SDK: %d extra calls", calls.Load()-before)
	}

	// 4. Dead provider: the node still COMPLETES; the run succeeds.
	server.Close()
	runID, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: aiWorkflow("wf-ai-dead")})
	if err != nil {
		t.Fatalf("start dead: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 3)
	output = nodeState(runID, "brain")
	if output["mode"] != "fallback" || output["aiError"] == nil {
		t.Fatalf("dead-provider node must complete with aiError: %+v", output)
	}
}

func containsString(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}

// The shared wire catalog against the ai NODE: a provider failure NEVER
// fails the node — the run succeeds with {mode:"fallback", aiError}.
func TestAiNodeFailureMatrix(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
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
	org := fmt.Sprintf("org-aimatrix-%d", time.Now().UnixNano())

	for _, tc := range failcat.Wire() {
		if tc.Name == "timeout" || tc.Name == "network_dead" {
			continue // owned by the client suite (sub-second budgets)
		}
		t.Run(tc.Name, func(t *testing.T) {
			server := httptest.NewServer(failcat.Handler(tc))
			t.Cleanup(server.Close)
			t.Setenv("ANTHROPIC_API_KEY", "test-key")
			t.Setenv("JANUSLY_LOCAL_STACK", "true")
			t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
			t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
			t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)

			wf := &domain.Workflow{
				ID: "wf-aimx-" + tc.Name, Name: "AI", DSLVersion: "1.0",
				Nodes: []domain.Node{{ID: "a", Type: "ai", Config: map[string]any{
					"prompt": "resume esto",
				}}},
				Edges: []domain.Edge{},
			}
			runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
			if err != nil {
				t.Fatalf("start: %v", err)
			}
			waitRunStatus(t, pool, runID, "succeeded", 0)
			var raw []byte
			_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'a'`, runID).Scan(&raw)
			var state struct {
				Output map[string]any `json:"output"`
			}
			_ = json.Unmarshal(raw, &state)
			if state.Output["mode"] != "fallback" {
				t.Fatalf("node must degrade, not fail: %s", raw)
			}
			aiError, _ := state.Output["aiError"].(string)
			if !strings.HasPrefix(aiError, tc.WantClass) {
				t.Fatalf("aiError class %q must lead: %q", tc.WantClass, aiError)
			}
		})
	}
}
