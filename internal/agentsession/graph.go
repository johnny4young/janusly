package agentsession

import (
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/hookwire"
)

const maxLaneSteps = 200

// Lane kinds, shaped like run map lanes.
const (
	KindAgent    = "external_agent"
	KindSubagent = "external_subagent"
)

// Status a reader sees: a running session silent past IdleAfter is idle.
const (
	StatusRunning = "running"
	StatusIdle    = "idle"
	StatusEnded   = "ended"
)

// EventRow is one applied event as the map reads it.
type EventRow struct {
	Seq           int64
	Type          string
	AgentID       string
	ParentAgentID string
	AgentType     string
	Tool          string
	ToolKind      string
	MCPServer     string
	Status        string
	DurationMs    *int64
	Refs          json.RawMessage
	At            time.Time
}

// LaneStep matches the run map lane step.
type LaneStep struct {
	Type   string `json:"type"`
	At     string `json:"at"`
	Tool   string `json:"tool,omitempty"`
	Status string `json:"status,omitempty"`
	Agent  string `json:"agent,omitempty"`
	Index  int64  `json:"index"`
}

// Lane is one agent of the session; subagents name their parent.
type Lane struct {
	NodeID    string     `json:"nodeId"`
	Kind      string     `json:"kind"`
	ParentID  *string    `json:"parentId"`
	AgentType *string    `json:"agentType"`
	Live      bool       `json:"live"`
	Steps     []LaneStep `json:"steps"`
	Truncated bool       `json:"truncated"`
}

// Totals summarize the session.
type Totals struct {
	Events    int `json:"events"`
	ToolCalls int `json:"toolCalls"`
	MCPCalls  int `json:"mcpCalls"`
	Errors    int `json:"errors"`
}

// Refs are the Janusly objects the session's Janusly calls named.
type Refs struct {
	WorkflowIDs []string `json:"workflowIds"`
	DraftIDs    []string `json:"draftIds"`
	RunIDs      []string `json:"runIds"`
}

// Graph is the session map without the session header.
type Graph struct {
	Lanes         []Lane `json:"lanes"`
	Totals        Totals `json:"totals"`
	LiveSubagents int    `json:"liveSubagents"`
	Refs          Refs   `json:"refs"`
}

// MainLane is the node id of the session's main agent.
const MainLane = "main"

// Project builds one lane per agent from ordered events. Subagents nest under
// their parent (the main agent when none is named); one stays live from its
// start until its stop.
func Project(events []EventRow) Graph {
	graph := Graph{Lanes: []Lane{}, Refs: Refs{WorkflowIDs: []string{}, DraftIDs: []string{}, RunIDs: []string{}}}
	index := map[string]int{}
	lane := func(agentID string) *Lane {
		if agentID == "" {
			agentID = MainLane
		}
		if position, ok := index[agentID]; ok {
			return &graph.Lanes[position]
		}
		next := Lane{NodeID: agentID, Kind: KindAgent, Steps: []LaneStep{}}
		if agentID != MainLane {
			parent := MainLane
			next.Kind, next.ParentID = KindSubagent, &parent
		}
		index[agentID] = len(graph.Lanes)
		graph.Lanes = append(graph.Lanes, next)
		return &graph.Lanes[len(graph.Lanes)-1]
	}
	lane(MainLane)
	for _, event := range events {
		graph.Totals.Events++
		target := lane(event.AgentID)
		switch event.Type {
		case hookwire.TypeSubagentStarted:
			target.Live = true
			if event.AgentType != "" {
				agentType := event.AgentType
				target.AgentType = &agentType
			}
			if event.ParentAgentID != "" && event.ParentAgentID != event.AgentID {
				parent := event.ParentAgentID
				if _, known := index[parent]; !known {
					parent = MainLane
				}
				target.ParentID = &parent
			}
		case hookwire.TypeSubagentStopped:
			target.Live = false
		case hookwire.TypeToolCompleted:
			graph.Totals.ToolCalls++
			if event.ToolKind == hookwire.ToolMCP {
				graph.Totals.MCPCalls++
			}
			if event.Status == "error" {
				graph.Totals.Errors++
			}
			collectRefs(&graph.Refs, event.Refs)
		}
		// Like run lanes, keep the latest steps.
		if len(target.Steps) == maxLaneSteps {
			target.Steps, target.Truncated = target.Steps[1:], true
		}
		target.Steps = append(target.Steps, LaneStep{
			Type: strings.TrimPrefix(event.Type, "io.janusly."), At: event.At.UTC().Format(time.RFC3339Nano),
			Tool: event.Tool, Status: event.Status, Agent: event.AgentType, Index: event.Seq,
		})
	}
	for _, lane := range graph.Lanes {
		if lane.Live {
			graph.LiveSubagents++
		}
	}
	return graph
}

func collectRefs(out *Refs, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var refs hookwire.Refs
	if json.Unmarshal(raw, &refs) != nil {
		return
	}
	add := func(list *[]string, value string) {
		if value != "" && !slices.Contains(*list, value) && len(*list) < 20 {
			*list = append(*list, value)
		}
	}
	add(&out.WorkflowIDs, refs.WorkflowID)
	add(&out.DraftIDs, refs.DraftID)
	add(&out.RunIDs, refs.RunID)
}

// ReadStatus is the status a reader sees. A session ended explicitly is
// ended; a running one silent past IdleAfter is idle, even with a turn
// stopped while subagents live.
func ReadStatus(stored string, lastEventAt, now time.Time) string {
	if stored == StatusEnded {
		return StatusEnded
	}
	if now.Sub(lastEventAt) > IdleAfter {
		return StatusIdle
	}
	return StatusRunning
}
