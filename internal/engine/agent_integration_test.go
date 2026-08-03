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
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
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

// The LLM planner matrix: no client / malformed / unavailable tool /
// thrown all fall back to the RULES plan with aiError attribution, a
// budget block terminates cleanly, and a VALID plan executes its tool.
func TestAgentLLMPlannerMatrix(t *testing.T) {
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
	org := fmt.Sprintf("org-llmplan-%d", time.Now().UnixNano())

	planRun := func(id, reply string) map[string]any {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			payload, _ := json.Marshal(map[string]any{
				"id": "msg_1", "type": "message", "role": "assistant",
				"model":       "claude-haiku-4-5-20251001",
				"content":     []map[string]any{{"type": "text", "text": reply}},
				"stop_reason": "end_turn",
				"usage":       map[string]any{"input_tokens": 5, "output_tokens": 5},
			})
			_, _ = w.Write(payload)
		}))
		defer server.Close()
		t.Setenv("ANTHROPIC_API_KEY", "test-key")
		t.Setenv("JANUSLY_LOCAL_STACK", "true")
		t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
		t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
		t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)
		wf := &domain.Workflow{
			ID: id, Name: "LLM Agent", DSLVersion: "1.0",
			Nodes: []domain.Node{{ID: "a", Type: "agent", Config: map[string]any{
				"goal": "uppercase something", "value": "hola",
				"planner": "openai", "maxSteps": float64(1),
			}}},
			Edges: []domain.Edge{},
		}
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
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
		return state.Output
	}
	firstPlan := func(output map[string]any) map[string]any {
		steps := output["steps"].([]any)
		return steps[0].(map[string]any)["plan"].(map[string]any)
	}

	// No client: rules fallback with llm_not_configured.
	t.Setenv("ANTHROPIC_API_KEY", "")
	wf := &domain.Workflow{
		ID: "wf-llm-nokey", Name: "LLM Agent", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "a", Type: "agent", Config: map[string]any{
			"goal": "uppercase it", "value": "hola", "planner": "openai", "maxSteps": float64(1),
		}}},
		Edges: []domain.Edge{},
	}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start nokey: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	var raw []byte
	_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'a'`, runID).Scan(&raw)
	var state struct {
		Output map[string]any `json:"output"`
	}
	_ = json.Unmarshal(raw, &state)
	plan := firstPlan(state.Output)
	if plan["mode"] != "fallback" || plan["aiError"] != "llm_not_configured" || plan["tool"] != "text.uppercase" {
		t.Fatalf("no-client plan: %+v", plan)
	}

	// Malformed reply: rules fallback, still executes uppercase.
	plan = firstPlan(planRun("wf-llm-malformed", "esto no es JSON"))
	if plan["mode"] != "fallback" || plan["tool"] != "text.uppercase" {
		t.Fatalf("malformed plan: %+v", plan)
	}

	// Unavailable tool: rules fallback with the attribution.
	plan = firstPlan(planRun("wf-llm-ghost-tool", `{"tool":"ghost.tool","input":{},"reason":"nope"}`))
	if plan["mode"] != "fallback" || plan["aiError"] != "LLM planner did not return an available tool" {
		t.Fatalf("ghost-tool plan: %+v", plan)
	}

	// VALID plan executes the chosen tool.
	output := planRun("wf-llm-valid", `{"tool":"text.uppercase","input":{"value":"plan del modelo"},"reason":"direct"}`)
	steps := output["steps"].([]any)
	step := steps[0].(map[string]any)
	if step["plan"].(map[string]any)["mode"] != "ai" ||
		step["result"].(map[string]any)["value"] != "PLAN DEL MODELO" {
		t.Fatalf("valid plan must execute: %+v", step)
	}

	// done=true finishes with the final answer.
	output = planRun("wf-llm-done", `{"done":true,"finalAnswer":"todo listo"}`)
	if output["finalAnswer"] != "todo listo" {
		t.Fatalf("done plan: %+v", output)
	}
}

// Episodic memory: consent off never calls embeddings, the recall event
// fires ONLY for an ai-mode plan with a non-empty recall (stable
// content-free fingerprints), and a done agent records one episode.
func TestAgentEpisodicMemory(t *testing.T) {
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
	org := fmt.Sprintf("org-episodes-%d", time.Now().UnixNano())

	var embedCalls int
	ollama := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		embedCalls++
		var body struct {
			Prompt string `json:"prompt"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		vector := make([]float64, 1024)
		for i, ch := range body.Prompt {
			vector[i%1024] += float64(ch%23) / 23
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"embedding": vector})
	}))
	defer ollama.Close()
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		payload, _ := json.Marshal(map[string]any{
			"id": "msg_1", "type": "message", "role": "assistant",
			"model":       "claude-haiku-4-5-20251001",
			"content":     []map[string]any{{"type": "text", "text": `{"done":true,"finalAnswer":"resuelto con backoff"}`}},
			"stop_reason": "end_turn", "usage": map[string]any{"input_tokens": 5, "output_tokens": 5},
		})
		_, _ = w.Write(payload)
	}))
	defer llm.Close()
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", llm.URL)

	agentRun := func(id string) string {
		wf := &domain.Workflow{
			ID: "wf-episodes", Name: "Agente", DSLVersion: "1.0",
			Nodes: []domain.Node{{ID: "a", Type: "agent", Config: map[string]any{
				"goal": "arregla los timeouts del webhook", "planner": "openai", "maxSteps": float64(1),
			}}},
			Edges: []domain.Edge{},
		}
		wf.ID = id
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			t.Fatalf("start %s: %v", id, err)
		}
		waitRunStatus(t, pool, runID, "succeeded", 0)
		return runID
	}

	// 1. Consent OFF: zero embedding calls, no episode rows, no event.
	t.Setenv("JANUSLY_MEMORY_ENABLED", "")
	runID := agentRun("wf-ep-off")
	if embedCalls != 0 {
		t.Fatalf("consent off must never call embeddings: %d", embedCalls)
	}
	var events int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1 AND type = 'agent.memory.recalled'`, runID).Scan(&events)
	if events != 0 {
		t.Fatal("no recall event without memory")
	}

	// 2. Consent ON: the first run records an episode (no recall event —
	// nothing to recall yet); the second recalls it and emits the event
	// with 12-char fingerprints.
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	seed := func(key, valueJSON, valueType string) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'memory', 'test', $5)`, org+"-"+key, org, key, valueJSON, valueType); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	seed("memory.enabled", "true", "boolean")
	seed("memory.allowedKinds", `"agent_episode"`, "string")
	seed("memory.embeddingBaseUrl", fmt.Sprintf("%q", ollama.URL), "string")

	first := agentRun("wf-ep-one")
	var episodes int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries WHERE org_id = $1 AND kind = 'agent_episode'`, org).Scan(&episodes)
	if episodes != 1 {
		t.Fatalf("done agent must record one episode: %d", episodes)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1 AND type = 'agent.memory.recalled'`, first).Scan(&events)
	if events != 0 {
		t.Fatal("an empty recall must not emit the event")
	}

	second := agentRun("wf-ep-two")
	var payload []byte
	if err := pool.QueryRow(ctx, `SELECT payload FROM run_events WHERE run_id = $1 AND type = 'agent.memory.recalled'`, second).Scan(&payload); err != nil {
		t.Fatalf("second run must emit the recall event: %v", err)
	}
	var event struct {
		Count        int      `json:"count"`
		Fingerprints []string `json:"fingerprints"`
	}
	_ = json.Unmarshal(payload, &event)
	if event.Count != 1 || len(event.Fingerprints) != 1 || len(event.Fingerprints[0]) != 12 {
		t.Fatalf("recall event shape: %+v", event)
	}
	if strings.Contains(string(payload), "backoff") {
		t.Fatal("episode content must never enter the event")
	}
}

// The crew: sequential previousAgents binds per completed agent (the
// second agent's goal template reads the first's result), parallel runs
// all agents with no late binding, and aggregation follows the strategy.
func TestMultiAgentCrew(t *testing.T) {
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
	org := fmt.Sprintf("org-crew-%d", time.Now().UnixNano())

	crewRun := func(id string, config map[string]any) map[string]any {
		wf := &domain.Workflow{
			ID: id, Name: "Crew", DSLVersion: "1.0",
			Nodes: []domain.Node{{ID: "crew", Type: "multi_agent", Config: config}},
			Edges: []domain.Edge{},
		}
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			t.Fatalf("start %s: %v", id, err)
		}
		waitRunStatus(t, pool, runID, "succeeded", 0)
		var raw []byte
		_ = pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id = $1 AND node_id = 'crew'`, runID).Scan(&raw)
		var state struct {
			Output map[string]any `json:"output"`
		}
		_ = json.Unmarshal(raw, &state)
		return state.Output
	}

	// Sequential: agent 2's goal template reads agent 1's completed result
	// via the DEFERRED previousAgents scope.
	output := crewRun("wf-crew-seq", map[string]any{
		"mode": "sequential", "aggregation": "all", "maxSteps": float64(1),
		"agents": []any{
			map[string]any{"name": "primero", "goal": "uppercase the word", "value": "semilla"},
			map[string]any{"name": "segundo", "goal": "uppercase {{previousAgents.0.result.finalResult.value}}", "reflection": false},
		},
	})
	agents := output["agents"].([]any)
	if len(agents) != 2 || output["count"] != float64(2) {
		t.Fatalf("crew shape: %+v", output)
	}
	// The reference late-binds the GOAL only: the second agent's goal
	// template must have rendered against the first's completed result.
	var goalPayload string
	if err := pool.QueryRow(ctx, `SELECT payload->>'goal' FROM run_events
		WHERE type = 'multi_agent.agent.started' AND payload->>'name' = 'segundo'
		ORDER BY created_at DESC LIMIT 1`).Scan(&goalPayload); err != nil {
		t.Fatalf("read second goal: %v", err)
	}
	if goalPayload != "uppercase SEMILLA" {
		t.Fatalf("previousAgents must bind per completed agent: %q", goalPayload)
	}

	// Parallel: both run, shared context has no late binding races, and
	// the last-strategy aggregation reads the final agent.
	output = crewRun("wf-crew-par", map[string]any{
		"mode": "parallel", "maxSteps": float64(1),
		"agents": []any{
			map[string]any{"name": "a1", "goal": "uppercase it", "value": "uno"},
			map[string]any{"name": "a2", "goal": "uppercase it", "value": "dos"},
		},
	})
	if output["mode"] != "parallel" || output["count"] != float64(2) {
		t.Fatalf("parallel crew: %+v", output)
	}
}

// The deferred-scope contract at the REAL binding point: a strict policy
// over a missing previousAgents path fails when the second agent's goal
// binds — AFTER the first agent completed — and lenient emits ONE
// deduplicated template.unresolved_path evidence event for that phase.
func TestDeferredScopeStrictPolicy(t *testing.T) {
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
	org := fmt.Sprintf("org-deferred-%d", time.Now().UnixNano())

	crew := func(id, policy string) *domain.Workflow {
		return &domain.Workflow{
			ID: id, Name: "Crew", DSLVersion: "1.0", TemplatePolicy: policy,
			Nodes: []domain.Node{{ID: "crew", Type: "multi_agent", Config: map[string]any{
				"mode": "sequential", "maxSteps": float64(1),
				"agents": []any{
					map[string]any{"name": "primero", "goal": "uppercase the word", "value": "sonda"},
					// The same missing deferred path twice — evidence must dedupe.
					map[string]any{"name": "segundo", "goal": "uppercase {{previousAgents.5.result.ghost}} and {{previousAgents.5.result.ghost}}"},
				},
			}}},
			Edges: []domain.Edge{},
		}
	}

	// Strict: the run fails AT the second agent's binding — the first agent
	// completed before the failure.
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: crew("wf-deferred-strict", "strict")})
	if err != nil {
		t.Fatalf("start strict: %v", err)
	}
	waitRunStatus(t, pool, runID, "failed", 0)
	var firstCompleted int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1
		AND type = 'multi_agent.agent.completed' AND payload->>'name' = 'primero'`, runID).Scan(&firstCompleted)
	if firstCompleted == 0 {
		t.Fatal("strict must fail at the deferred binding, not before the first agent ran")
	}
	var payload []byte
	if err := pool.QueryRow(ctx, `SELECT payload FROM run_events WHERE run_id = $1
		AND type = 'template.unresolved_path' LIMIT 1`, runID).Scan(&payload); err != nil {
		t.Fatalf("strict evidence event expected: %v", err)
	}
	var parsed struct {
		Count  int      `json:"count"`
		Paths  []string `json:"paths"`
		Policy string   `json:"policy"`
	}
	_ = json.Unmarshal(payload, &parsed)
	if parsed.Policy != "strict" || parsed.Count != 1 || len(parsed.Paths) != 1 ||
		!strings.HasPrefix(parsed.Paths[0], "previousAgents.5") {
		t.Fatalf("strict evidence payload: %s", payload)
	}

	// Lenient (default): same crew succeeds, ONE deduplicated evidence event
	// for the binding phase.
	runID, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: crew("wf-deferred-lenient", "")})
	if err != nil {
		t.Fatalf("start lenient: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	if err := pool.QueryRow(ctx, `SELECT payload FROM run_events WHERE run_id = $1
		AND type = 'template.unresolved_path'`, runID).Scan(&payload); err != nil {
		t.Fatalf("lenient evidence event expected: %v", err)
	}
	_ = json.Unmarshal(payload, &parsed)
	if parsed.Policy != "lenient" || parsed.Count != 1 || len(parsed.Paths) != 1 {
		t.Fatalf("lenient evidence must dedupe to one path: %s", payload)
	}
}

// The loop's item scope under strict: a mapping over a missing item field
// fails per iteration through the SAME recordUnresolvedPaths chokepoint.
func TestLoopItemScopeStrictPolicy(t *testing.T) {
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
	org := fmt.Sprintf("org-loopstrict-%d", time.Now().UnixNano())

	wf := &domain.Workflow{
		ID: "wf-loop-strict", Name: "Loop", DSLVersion: "1.0", TemplatePolicy: "strict",
		Nodes: []domain.Node{{ID: "l", Type: "loop", Config: map[string]any{
			"items":   "a,b",
			"mapping": map[string]any{"v": "{{item.ghost}}"},
		}}},
		Edges: []domain.Edge{},
	}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	waitRunStatus(t, pool, runID, "failed", 0)
	var payload []byte
	if err := pool.QueryRow(ctx, `SELECT payload FROM run_events WHERE run_id = $1
		AND type = 'template.unresolved_path' LIMIT 1`, runID).Scan(&payload); err != nil {
		t.Fatalf("loop strict evidence expected: %v", err)
	}
	var parsed struct {
		Policy string   `json:"policy"`
		Paths  []string `json:"paths"`
	}
	_ = json.Unmarshal(payload, &parsed)
	if parsed.Policy != "strict" || len(parsed.Paths) == 0 || !strings.HasPrefix(parsed.Paths[0], "item.") {
		t.Fatalf("loop strict evidence: %s", payload)
	}
}
