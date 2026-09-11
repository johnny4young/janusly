//go:build integration

package engine

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/grammar"
)

func TestReaperPreservesCommittedEffectAfterLostCompletion(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	var effects atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("unexpected provider method: %s", r.Method)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		effects.Add(1)
		_, _ = w.Write([]byte(`{"applied":true}`))
	}))
	t.Cleanup(provider.Close)
	doc := `{"id":"wf-lost-completion","nodes":[
		{"id":"mutate","type":"http","config":{"url":"` + provider.URL + `","method":"POST",
			"retry":{"maxAttempts":3,"delayMs":1}}},
		{"id":"after","type":"noop","config":{}}
	],"edges":[{"from":"mutate","to":"after"}]}`
	wf := mustParse(t, doc)
	runID := org + "-lost-completion"
	inputJSON, err := json.Marshal(map[string]any{"workflow": json.RawMessage(doc), "input": map[string]any{}})
	if err != nil {
		t.Fatalf("marshal run: %v", err)
	}
	// Seed an already claimed node so unrelated workers cannot win it. The
	// real dispatcher performs the HTTP effect; only its completion is lost.
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, workflow_version_id, status, input_json)
		VALUES ($1, $2, $1, 'running', $3)`, runID, org, inputJSON); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO run_nodes (id, run_id, node_id, status, attempts, started_at)
		VALUES ($1, $2, 'mutate', 'running', 1, now()), ($3, $2, 'after', 'pending', 0, NULL)`,
		runID+"-mutate", runID, runID+"-after"); err != nil {
		t.Fatalf("seed claimed nodes: %v", err)
	}
	claim := ClaimedNode{RowID: runID + "-mutate", RunID: runID, NodeID: "mutate", Attempt: 1, OrgID: org}.
		withSnapshot(wf, map[string]any{}, "", runID)
	output, err := eng.NewDispatcher(grammar.RenderOptions{}).Execute(ctx, claim, wf.Nodes[0], wf, map[string]any{})
	if err != nil || effects.Load() != 1 {
		t.Fatalf("committed provider effect: writes=%d err=%v", effects.Load(), err)
	}

	// Model abrupt death after the effect and before CompleteNode. No
	// graceful worker shutdown is used: that intentionally drains outcomes.
	if _, err := pool.Exec(ctx, `UPDATE run_nodes SET started_at=now()-interval '2 hours'
		WHERE run_id=$1 AND node_id='mutate'`, runID); err != nil {
		t.Fatalf("age lost completion: %v", err)
	}
	restarted := New(pool)
	reaped, err := restarted.reapScopedStalledNodes(ctx, org, runID, time.Hour,
		map[string]any{"reason": "worker_stalled"}, quietLogger())
	if err != nil || reaped.Scanned != 1 || reaped.Reaped != 1 {
		t.Fatalf("recover lost completion: %+v err=%v", reaped, err)
	}
	// A late result from the old claim cannot overwrite the reaper's CAS or
	// enable downstream work after the operator-visible failure settled.
	if err := eng.CompleteNode(ctx, claim, output); err != nil {
		t.Fatalf("late completion: %v", err)
	}
	var nodeStatus, runStatus, downstreamStatus, failureCode string
	var attempts, deadLetters, retryEvents, completedEvents int
	if err := pool.QueryRow(ctx, `SELECT n.status, r.status, n.attempts, n.error_json->>'code',
		(SELECT status FROM run_nodes WHERE run_id=n.run_id AND node_id='after'),
		(SELECT count(*) FROM dead_letters WHERE run_id=n.run_id),
		(SELECT count(*) FROM run_events WHERE run_id=n.run_id AND type='node.retry'),
		(SELECT count(*) FROM run_events WHERE run_id=n.run_id AND type='node.succeeded')
		FROM run_nodes n JOIN runs r ON r.id=n.run_id
		WHERE n.run_id=$1 AND n.node_id='mutate'`, runID).
		Scan(&nodeStatus, &runStatus, &attempts, &failureCode, &downstreamStatus,
			&deadLetters, &retryEvents, &completedEvents); err != nil {
		t.Fatalf("read reaped effect: %v", err)
	}
	if effects.Load() != 1 || nodeStatus != "failed" || runStatus != "failed" ||
		attempts != 1 || failureCode != "worker_stalled" || downstreamStatus != "pending" ||
		deadLetters != 1 || retryEvents != 0 || completedEvents != 0 {
		t.Fatalf("lost completion must not replay or verify: writes=%d node=%s run=%s attempts=%d code=%s downstream=%s dlq=%d retries=%d completions=%d",
			effects.Load(), nodeStatus, runStatus, attempts, failureCode, downstreamStatus, deadLetters, retryEvents, completedEvents)
	}
}
