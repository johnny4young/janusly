//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/usage"
)

func TestAIExecutorRateAdmissionCountsOnlyProviderCalls(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	usage.SetRecorder(usage.NewDBRecorder(pool))
	t.Cleanup(func() { usage.SetRecorder(nil) })
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs
		(id, org_id, key, value_json, category, description, value_type)
		VALUES ($1,$2,'ai.rateLimitPerMin','1','ai','test','number')`,
		org+"-ai-rate", org); err != nil {
		t.Fatalf("seed AI rate: %v", err)
	}

	var providerCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		providerCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"id":"msg_1","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}`)
	}))
	defer provider.Close()

	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 1, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()

	run := func(id string) (string, map[string]any) {
		t.Helper()
		wf := &domain.Workflow{
			ID: id, Name: "AI admission", DSLVersion: "1.0",
			Nodes: []domain.Node{{ID: "ai", Type: "ai", Config: map[string]any{"prompt": "summarize"}}},
			Edges: []domain.Edge{},
		}
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			t.Fatalf("start %s: %v", id, err)
		}
		waitRunStatus(t, pool, runID, "succeeded", 0)
		var raw []byte
		if err := pool.QueryRow(ctx,
			`SELECT state_json->'output' FROM run_nodes WHERE run_id=$1 AND node_id='ai'`, runID,
		).Scan(&raw); err != nil {
			t.Fatalf("output %s: %v", id, err)
		}
		var output map[string]any
		if err := json.Unmarshal(raw, &output); err != nil {
			t.Fatalf("decode %s: %v", id, err)
		}
		return runID, output
	}

	// Provider-free execution stays fully functional and does not consume the
	// provider-call bucket.
	t.Setenv("ANTHROPIC_API_KEY", "")
	if _, output := run("wf-ai-admission-provider-free"); output["mode"] != "fallback" {
		t.Fatalf("provider-free output: %+v", output)
	}
	if providerCalls.Load() != 0 {
		t.Fatalf("provider-free run dialed simulator: %d", providerCalls.Load())
	}

	// The first configured call is admitted. The next call in the same minute
	// falls back before the SDK, proving executor calls use the durable org
	// bucket rather than an endpoint-local counter.
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", provider.URL)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	firstRunID, output := run("wf-ai-admission-first")
	if output["mode"] != "ai" {
		t.Fatalf("first provider call: %+v", output)
	}
	var attributedWorkflowID string
	if err := pool.QueryRow(ctx, `SELECT metadata->>'workflowId' FROM usage_events
		WHERE org_id=$1 AND run_id=$2 AND metric='llm.completion'`, org, firstRunID).Scan(&attributedWorkflowID); err != nil {
		t.Fatalf("read attributed AI usage: %v", err)
	}
	if attributedWorkflowID != firstRunID {
		t.Fatalf("ad-hoc AI usage must retain its resolved workflow identity: got %q want %q", attributedWorkflowID, firstRunID)
	}
	_, limited := run("wf-ai-admission-limited")
	if limited["mode"] != "fallback" || !strings.HasPrefix(fmt.Sprint(limited["aiError"]), "rate_limit:") {
		t.Fatalf("rate-limited output: %+v", limited)
	}
	if providerCalls.Load() != 1 {
		t.Fatalf("rate denial reached provider: calls=%d", providerCalls.Load())
	}
}
