//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
)

func TestRouterRuntimeChoosesOneSuccessorAndPersistsCausalEvidence(t *testing.T) {
	tests := []struct {
		name     string
		nodeType string
		idField  string
	}{
		{name: "canonical router", nodeType: "router", idField: "nodeId"},
		{name: "legacy router llm", nodeType: "router_llm", idField: "id"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, pool, eng, org := newHarness(t)
			doc := fmt.Sprintf(`{
				"id":"wf-router",
				"nodes":[
					{"id":"route","type":%q,"config":{"strategy":"balanced","candidates":[
						{%q:"fast","avgCost":0.01,"avgLatencyMs":20,"successRate":0.98},
						{%q:"safe","avgCost":0.03,"avgLatencyMs":80,"successRate":0.99}
					]}},
					{"id":"fast","type":"noop","config":{}},
					{"id":"safe","type":"noop","config":{}}
				],
				"edges":[{"from":"route","to":"fast"},{"from":"route","to":"safe"}]
			}`, tt.nodeType, tt.idField, tt.idField)
			runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
			if err != nil {
				t.Fatalf("start: %v", err)
			}
			runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

			statuses := map[string]string{}
			rows, err := pool.Query(ctx, `SELECT node_id, status FROM run_nodes WHERE run_id=$1`, runID)
			if err != nil {
				t.Fatalf("read statuses: %v", err)
			}
			for rows.Next() {
				var nodeID, status string
				if err := rows.Scan(&nodeID, &status); err != nil {
					rows.Close()
					t.Fatalf("scan status: %v", err)
				}
				statuses[nodeID] = status
			}
			rows.Close()
			if statuses["route"] != "succeeded" || statuses["fast"] != "succeeded" || statuses["safe"] != "skipped" {
				t.Fatalf("router statuses = %#v", statuses)
			}

			var decisionJSON []byte
			if err := pool.QueryRow(ctx, `
				SELECT payload FROM run_events
				WHERE run_id=$1 AND node_id='route' AND type='decision.made'`, runID).Scan(&decisionJSON); err != nil {
				t.Fatalf("decision event: %v", err)
			}
			var decision domain.DecisionOutput
			if err := json.Unmarshal(decisionJSON, &decision); err != nil {
				t.Fatalf("decode decision: %v", err)
			}
			if decision.ChosenNodeID != "fast" || len(decision.Ranking) != 2 || decision.Ranking[0].NodeID != "fast" {
				t.Fatalf("decision = %+v", decision)
			}

			var skippedState []byte
			if err := pool.QueryRow(ctx, `SELECT state_json FROM run_nodes WHERE run_id=$1 AND node_id='safe'`, runID).Scan(&skippedState); err != nil {
				t.Fatalf("skipped state: %v", err)
			}
			var state struct {
				Skipped struct {
					Reason string `json:"reason"`
				} `json:"skipped"`
			}
			if err := json.Unmarshal(skippedState, &state); err != nil || state.Skipped.Reason != "Router route chose fast" {
				t.Fatalf("skip state = %s (%v)", skippedState, err)
			}

			var routeSucceeded, loserSucceeded, loserSkipped int
			if err := pool.QueryRow(ctx, `SELECT
				count(*) FILTER (WHERE type='node.succeeded' AND node_id='route'),
				count(*) FILTER (WHERE type='node.succeeded' AND node_id='safe'),
				count(*) FILTER (WHERE type='node.skipped' AND node_id='safe')
				FROM run_events WHERE run_id=$1`, runID).Scan(&routeSucceeded, &loserSucceeded, &loserSkipped); err != nil {
				t.Fatalf("loser events: %v", err)
			}
			if routeSucceeded != 0 || loserSucceeded != 0 || loserSkipped != 1 {
				t.Fatalf("router events routeSucceeded=%d loserSucceeded=%d loserSkipped=%d",
					routeSucceeded, loserSucceeded, loserSkipped)
			}

			stats := map[string]int{}
			statsRows, err := pool.Query(ctx, `SELECT node_id, pulls FROM routing_stats WHERE org_id=$1`, org)
			if err != nil {
				t.Fatalf("routing stats: %v", err)
			}
			for statsRows.Next() {
				var nodeID string
				var pulls int
				if err := statsRows.Scan(&nodeID, &pulls); err != nil {
					statsRows.Close()
					t.Fatalf("scan routing stats: %v", err)
				}
				stats[nodeID] = pulls
			}
			statsRows.Close()
			if stats["route"] != 1 || stats["fast"] != 1 {
				t.Fatalf("successful outcome stats = %#v", stats)
			}
			if _, exists := stats["safe"]; exists {
				t.Fatalf("skipped loser must not record an outcome: %#v", stats)
			}
		})
	}
}

func TestRouterRuntimeUsesOnlyTenantRoutingStats(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	if _, err := pool.Exec(ctx, `INSERT INTO routing_stats
		(id, org_id, node_id, pulls, value, mean_reward, success_count, failure_count)
		VALUES
		($1, $2, 'proven', 3, 3, 1, 3, 0),
		($3, $4, 'fresh', 3, 3, 1, 3, 0)`,
		"stat-proven-"+org, org, "stat-foreign-"+org, "foreign-"+org); err != nil {
		t.Fatalf("seed routing stats: %v", err)
	}

	doc := `{
		"id":"wf-router-rl",
		"nodes":[
			{"id":"route","type":"router","config":{"candidates":[
				{"nodeId":"fresh","successRate":0.6},
				{"nodeId":"proven","successRate":0.5}
			]}},
			{"id":"fresh","type":"noop","config":{}},
			{"id":"proven","type":"noop","config":{}}
		],
		"edges":[{"from":"route","to":"fresh"},{"from":"route","to":"proven"}]
	}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

	var decisionJSON []byte
	if err := pool.QueryRow(ctx, `SELECT payload FROM run_events
		WHERE run_id=$1 AND node_id='route' AND type='decision.made'`, runID).Scan(&decisionJSON); err != nil {
		t.Fatalf("decision event: %v", err)
	}
	var decision domain.DecisionOutput
	if err := json.Unmarshal(decisionJSON, &decision); err != nil {
		t.Fatalf("decode decision: %v", err)
	}
	if decision.ChosenNodeID != "proven" {
		t.Fatalf("tenant reinforcement must flip the close decision: %+v", decision)
	}
	var freshStatus, provenStatus string
	if err := pool.QueryRow(ctx, `SELECT
		max(status) FILTER (WHERE node_id='fresh'),
		max(status) FILTER (WHERE node_id='proven')
		FROM run_nodes WHERE run_id=$1`, runID).Scan(&freshStatus, &provenStatus); err != nil {
		t.Fatalf("branch statuses: %v", err)
	}
	if freshStatus != "skipped" || provenStatus != "succeeded" {
		t.Fatalf("branch statuses fresh=%s proven=%s", freshStatus, provenStatus)
	}
}

func TestRouterQuarantineSkipsLoserWithoutPublishingWinner(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	wf := semanticWorkflow("wf-router-quarantine", "quarantine", "false")
	wf.Recovery.Contract.Failure.Semantic.Detectors[0].SourceNodeID = "route"
	wf.Nodes = []domain.Node{
		{ID: "route", Type: "router", Config: map[string]any{
			"candidates": []any{
				map[string]any{"nodeId": "fast", "successRate": 1.0},
				map[string]any{"nodeId": "safe", "successRate": 0.5},
			},
		}},
		{ID: "fast", Type: "noop", Config: map[string]any{}},
		{ID: "safe", Type: "noop", Config: map[string]any{}},
	}
	wf.Edges = []domain.Edge{{From: "route", To: "fast"}, {From: "route", To: "safe"}}
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger())
	}()
	waitRun(t, pool, runID, "waiting", 20*time.Second)
	stop()
	<-done

	statuses := map[string]string{}
	rows, err := pool.Query(ctx, `SELECT node_id, status FROM run_nodes WHERE run_id=$1`, runID)
	if err != nil {
		t.Fatalf("read statuses: %v", err)
	}
	for rows.Next() {
		var nodeID, status string
		if err := rows.Scan(&nodeID, &status); err != nil {
			rows.Close()
			t.Fatalf("scan status: %v", err)
		}
		statuses[nodeID] = status
	}
	rows.Close()
	if statuses["route"] != "succeeded" || statuses["fast"] != "pending" || statuses["safe"] != "skipped" {
		t.Fatalf("quarantined router statuses = %#v", statuses)
	}
	var decisions, violations, winnerQueued int
	if err := pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE type='decision.made'),
		count(*) FILTER (WHERE type='recovery.semantic_violation'),
		count(*) FILTER (WHERE type='node.queued' AND node_id='fast')
		FROM run_events WHERE run_id=$1`, runID).Scan(&decisions, &violations, &winnerQueued); err != nil {
		t.Fatalf("quarantine events: %v", err)
	}
	if decisions != 1 || violations != 1 || winnerQueued != 0 {
		t.Fatalf("quarantine events decisions=%d violations=%d winnerQueued=%d", decisions, violations, winnerQueued)
	}
}
