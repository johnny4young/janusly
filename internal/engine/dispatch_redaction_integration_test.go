//go:build integration

package engine

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

func TestDispatcherRedactsResolvedSecretsFromAgentEvents(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	const secret = "opaque-event-secret-918274"
	var observed atomic.Value
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed.Store(r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer target.Close()

	dispatcher := eng.NewDispatcher(grammar.RenderOptions{
		LookupSecret: func(name string) (string, bool) {
			return secret, name == "AGENT_TEST_TOKEN"
		},
	})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 1, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()

	wf := &domain.Workflow{
		ID: "wf-agent-event-redaction", Name: "Agent event redaction", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "agent", Type: "agent", Config: map[string]any{
			"planner": "rules", "tool": "http.request", "maxSteps": float64(1),
			"input": map[string]any{
				"url": target.URL, "method": "GET",
				"headers": map[string]any{"Authorization": "Bearer {{secret.AGENT_TEST_TOKEN}}"},
			},
		}}},
		Edges: []domain.Edge{},
	}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	waitRunStatus(t, pool, runID, "succeeded", 0)
	if got, _ := observed.Load().(string); got != "Bearer "+secret {
		t.Fatalf("executor did not receive intended credential: %q", got)
	}

	var payloads string
	if err := pool.QueryRow(ctx,
		`SELECT coalesce(string_agg(payload::text, E'\n'), '') FROM run_events WHERE run_id=$1`,
		runID).Scan(&payloads); err != nil {
		t.Fatalf("events: %v", err)
	}
	if strings.Contains(payloads, secret) {
		t.Fatalf("resolved secret reached durable events: %s", payloads)
	}
	if !strings.Contains(payloads, grammar.RedactedPlaceholder) {
		t.Fatalf("expected explicit redaction evidence in events: %s", payloads)
	}
}
