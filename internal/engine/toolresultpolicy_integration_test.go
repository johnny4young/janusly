//go:build integration

package engine

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

// A write whose provider envelope says ok=false must not finish the run as a
// success just because the author left resultPolicy out.
func TestWriteToolWithoutResultPolicyFailsTheRun(t *testing.T) {
	for _, test := range []struct {
		name, policy, wantStatus string
	}{
		{name: "default", wantStatus: "failed"},
		{name: "explicit envelope", policy: domain.ResultPolicyEnvelope, wantStatus: "succeeded"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, pool, eng, org := newHarness(t)
			dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
			workerCtx, stop := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				defer close(done)
				_ = eng.RunWorkers(workerCtx, 1, 20*time.Millisecond, dispatcher.Execute, quietLogger())
			}()
			defer func() { stop(); <-done }()

			config := map[string]any{"tool": "webhook.send", "input": map[string]any{
				"credential": "absent-hook", "url": "https://hooks.example.test/orders",
				"payload": map[string]any{"orderId": "o-1"},
			}}
			if test.policy != "" {
				config["resultPolicy"] = test.policy
			}
			runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: &domain.Workflow{
				ID: "wf-write-policy", Name: "Write policy", DSLVersion: "1.0",
				Nodes: []domain.Node{{ID: "send", Type: "tool", Config: config}},
				Edges: []domain.Edge{},
			}})
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(30 * time.Second)
			var status, nodeError string
			for time.Now().Before(deadline) {
				if err := pool.QueryRow(ctx, `
					SELECT r.status, coalesce(n.error_json::text, '')
					FROM runs r JOIN run_nodes n ON n.run_id = r.id
					WHERE r.id = $1`, runID).Scan(&status, &nodeError); err != nil {
					t.Fatal(err)
				}
				if status == "succeeded" || status == "failed" {
					break
				}
				time.Sleep(25 * time.Millisecond)
			}
			if status != test.wantStatus {
				t.Fatalf("status %s, want %s: %s", status, test.wantStatus, nodeError)
			}
			if status == "failed" && !strings.Contains(nodeError, "TOOL_RESULT_NOT_OK") {
				t.Fatalf("failure lost its tool result code: %s", nodeError)
			}
		})
	}
}
