package agentsession

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/hookwire"
)

func TestProjectNestsSubagentsAndKeepsThemLiveUntilStopped(t *testing.T) {
	at := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	events := []EventRow{
		{Seq: 1, Type: hookwire.TypeSessionStarted, At: at},
		{Seq: 2, Type: hookwire.TypeSubagentStarted, AgentID: "a", AgentType: "Explore", At: at},
		{Seq: 3, Type: hookwire.TypeSubagentStarted, AgentID: "b", ParentAgentID: "a", AgentType: "Plan", At: at},
		{Seq: 4, Type: hookwire.TypeToolCompleted, AgentID: "b", Tool: "mcp__notion__search", ToolKind: "mcp", Status: "ok", At: at},
		{Seq: 5, Type: hookwire.TypeToolCompleted, Tool: "mcp__janusly__runs.start", ToolKind: "mcp", Status: "ok",
			Refs: json.RawMessage(`{"runId":"run_1","workflowId":"wf_1"}`), At: at},
		{Seq: 6, Type: hookwire.TypeSubagentStopped, AgentID: "a", Status: "ok", At: at},
		{Seq: 7, Type: hookwire.TypeTurnStopped, At: at},
	}
	graph := Project(events)
	if len(graph.Lanes) != 3 || graph.Lanes[0].NodeID != MainLane {
		t.Fatalf("lanes: %+v", graph.Lanes)
	}
	a, b := graph.Lanes[1], graph.Lanes[2]
	if *a.ParentID != MainLane || *b.ParentID != "a" || *b.AgentType != "Plan" || a.Kind != KindSubagent {
		t.Fatalf("nesting: a %+v b %+v", a, b)
	}
	if a.Live || !b.Live || graph.LiveSubagents != 1 {
		t.Fatalf("liveness: a %v b %v total %d", a.Live, b.Live, graph.LiveSubagents)
	}
	if graph.Totals != (Totals{Events: 7, ToolCalls: 2, MCPCalls: 2}) {
		t.Fatalf("totals: %+v", graph.Totals)
	}
	if graph.Refs.RunIDs[0] != "run_1" || graph.Refs.WorkflowIDs[0] != "wf_1" || len(graph.Refs.DraftIDs) != 0 {
		t.Fatalf("refs: %+v", graph.Refs)
	}
	if step := graph.Lanes[0].Steps[0]; step.Type != "agent.session.started" || step.Index != 1 {
		t.Fatalf("step: %+v", step)
	}
}

func TestProjectKeepsTheLatestStepsOfALongLane(t *testing.T) {
	events := make([]EventRow, 0, maxLaneSteps+5)
	for i := range maxLaneSteps + 5 {
		events = append(events, EventRow{Seq: int64(i + 1), Type: hookwire.TypeToolRequested, Tool: "Read", At: time.Now()})
	}
	lane := Project(events).Lanes[0]
	if !lane.Truncated || len(lane.Steps) != maxLaneSteps || lane.Steps[len(lane.Steps)-1].Index != int64(maxLaneSteps+5) {
		t.Fatalf("truncation: %v %d", lane.Truncated, len(lane.Steps))
	}
}

func TestReadStatus(t *testing.T) {
	now := time.Now()
	for _, tc := range []struct {
		stored string
		last   time.Time
		want   string
	}{
		{"running", now, StatusRunning},
		{"running", now.Add(-IdleAfter - time.Second), StatusIdle},
		{"ended", now, StatusEnded},
	} {
		if got := ReadStatus(tc.stored, tc.last, now); got != tc.want {
			t.Fatalf("%s: %s", tc.stored, got)
		}
	}
}
