// Package sessiondraft turns an observed agent session into a workflow draft.
package sessiondraft

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/agentsession"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/publishgate"
)

const (
	// MaxDraftAgents bounds the agent steps one draft may hold.
	MaxDraftAgents = 24
	// PlaceholderPrefix marks a value a person or agent must replace before
	// the draft can qualify.
	PlaceholderPrefix = publishgate.ObservedPlaceholderPrefix
	// januslyServer is the authoring surface: its calls are not the work.
	januslyServer  = "janusly"
	maxListedTools = 12
)

var (
	// ErrNotConvertible refuses a session with no MCP tool calls: local tools
	// such as a shell or a file edit have no equivalent in a workflow.
	ErrNotConvertible = errors.New("the session used no MCP tools, so there is nothing to convert")
	// ErrTooManyAgents refuses a session with more agents than a draft holds.
	ErrTooManyAgents = fmt.Errorf("the session has more than %d agents that used MCP tools", MaxDraftAgents)
)

// Conversion says, before converting, how much of a session a workflow can hold.
type Conversion struct {
	TotalSteps       int      `json:"totalSteps"`
	ConvertibleSteps int      `json:"convertibleSteps"`
	Agents           int      `json:"agents"`
	MCPServers       []string `json:"mcpServers"`
	Convertible      bool     `json:"convertible"`
}

// DraftAgent is one observed agent in the draft.
type DraftAgent struct {
	NodeID             string   `json:"nodeId"`
	AgentType          string   `json:"agentType,omitempty"`
	Tools              []string `json:"tools"`
	SuggestedTimeoutMs int64    `json:"suggestedTimeoutMs,omitempty"`
}

// Draft is the workflow document built from a session, with its placeholders.
type Draft struct {
	Document     map[string]any
	Agents       []DraftAgent
	MCPServers   []string
	Placeholders []string
}

type observedAgent struct {
	id, agentType string
	first, last   time.Time
	tools         []string
	durations     []int64
	steps         int
}

func convertible(event agentsession.EventRow) bool {
	return event.Type == hookwire.TypeToolCompleted && event.ToolKind == hookwire.ToolMCP && event.MCPServer != januslyServer
}

func observe(events []agentsession.EventRow) (agents []*observedAgent, servers []string, total int) {
	byID := map[string]*observedAgent{}
	types := map[string]string{}
	for _, event := range events {
		if event.AgentType != "" {
			types[event.AgentID] = event.AgentType
		}
		if event.Type != hookwire.TypeToolCompleted {
			continue
		}
		total++
		if !convertible(event) {
			continue
		}
		agent := byID[event.AgentID]
		if agent == nil {
			agent = &observedAgent{id: event.AgentID, first: event.At}
			byID[event.AgentID] = agent
			agents = append(agents, agent)
		}
		agent.last, agent.steps = event.At, agent.steps+1
		if !slices.Contains(agent.tools, event.Tool) && len(agent.tools) < maxListedTools {
			agent.tools = append(agent.tools, event.Tool)
		}
		if event.DurationMs != nil {
			agent.durations = append(agent.durations, *event.DurationMs)
		}
		if event.MCPServer != "" && !slices.Contains(servers, event.MCPServer) {
			servers = append(servers, event.MCPServer)
		}
	}
	for _, agent := range agents {
		agent.agentType = types[agent.id]
	}
	sort.SliceStable(agents, func(i, j int) bool { return agents[i].first.Before(agents[j].first) })
	slices.Sort(servers)
	return agents, servers, total
}

// Convertibility counts what a draft would keep.
func Convertibility(events []agentsession.EventRow) Conversion {
	agents, servers, total := observe(events)
	out := Conversion{TotalSteps: total, Agents: len(agents), MCPServers: servers, Convertible: len(agents) > 0}
	if out.MCPServers == nil {
		out.MCPServers = []string{}
	}
	for _, agent := range agents {
		out.ConvertibleSteps += agent.steps
	}
	return out
}

// BuildDraft turns the agents that used MCP tools into agent steps, in the
// order they started; agents whose activity overlapped run between a
// parallel_fork and its join. What a session cannot show (each goal, the
// outputs) is left as a placeholder the publish gate refuses.
func BuildDraft(workflowID, name string, events []agentsession.EventRow) (Draft, error) {
	agents, servers, _ := observe(events)
	if len(agents) == 0 {
		return Draft{}, ErrNotConvertible
	}
	if len(agents) > MaxDraftAgents {
		return Draft{}, ErrTooManyAgents
	}
	waves := [][]*observedAgent{}
	var waveEnd time.Time
	for _, agent := range agents {
		last := len(waves) - 1
		if last < 0 || !agent.first.Before(waveEnd) || len(waves[last]) == domain.ForkJoinMaxBranches {
			waves = append(waves, nil)
			last++
			waveEnd = time.Time{}
		}
		waves[last] = append(waves[last], agent)
		if agent.last.After(waveEnd) {
			waveEnd = agent.last
		}
	}
	draft := Draft{MCPServers: servers}
	nodes, edges := []any{}, []any{}
	tail, index := "", 0
	link := func(from, to string) {
		if from != "" {
			edges = append(edges, map[string]any{"id": from + "_to_" + to, "from": from, "to": to})
		}
	}
	for waveIndex, wave := range waves {
		fork, join := "", ""
		if len(wave) > 1 {
			fork, join = fmt.Sprintf("fork_%d", waveIndex+1), fmt.Sprintf("join_%d", waveIndex+1)
			branches, sources := []any{}, map[string]any{}
			for offset := range wave {
				label := fmt.Sprintf("agent_%d", index+offset+1)
				branches = append(branches, map[string]any{"label": label})
				sources[label] = label
			}
			nodes = append(nodes, map[string]any{"id": fork, "type": "parallel_fork", "label": "Run in parallel",
				"config": map[string]any{"branches": branches}})
			link(tail, fork)
			nodes = append(nodes, map[string]any{"id": join, "type": "join", "label": "Wait for all",
				"config": map[string]any{"sources": sources}})
		}
		for _, agent := range wave {
			index++
			nodeID := fmt.Sprintf("agent_%d", index)
			label := agent.agentType
			if label == "" {
				label = fmt.Sprintf("Agent %d", index)
			}
			goalPath := "/nodes/" + nodeID + "/config/goal"
			nodes = append(nodes, map[string]any{"id": nodeID, "type": "agent", "label": label, "config": map[string]any{
				"goal": PlaceholderPrefix + " say what this agent must achieve. In the session it called " + strings.Join(agent.tools, ", ") + ".",
			}})
			draft.Placeholders = append(draft.Placeholders, goalPath)
			draft.Agents = append(draft.Agents, DraftAgent{NodeID: nodeID, AgentType: agent.agentType, Tools: agent.tools,
				SuggestedTimeoutMs: suggestedTimeout(agent.durations)})
			if fork != "" {
				link(fork, nodeID)
				link(nodeID, join)
			} else {
				link(tail, nodeID)
				tail = nodeID
			}
		}
		if join != "" {
			tail = join
		}
	}
	draft.Placeholders = append(draft.Placeholders, "/outputs/result")
	draft.Document = map[string]any{
		"dslVersion": "1.0", "id": workflowID, "name": name,
		"metadata": map[string]any{"description": "Drafted from an observed agent session. A starting point, not a replay.", "tags": []any{}},
		"nodes":    nodes, "edges": edges,
		"outputs": map[string]any{"result": PlaceholderPrefix + " declare what a successful run returns."},
	}
	raw, err := json.Marshal(draft.Document)
	if err != nil {
		return Draft{}, err
	}
	if wf, issues := domain.Parse(raw); wf == nil {
		return Draft{}, fmt.Errorf("drafted workflow does not parse: %v", issues)
	}
	return draft, nil
}

// suggestedTimeout is twice the 95th percentile of the observed call durations.
func suggestedTimeout(durations []int64) int64 {
	if len(durations) == 0 {
		return 0
	}
	sorted := slices.Clone(durations)
	slices.Sort(sorted)
	return 2 * sorted[min(len(sorted)-1, len(sorted)*95/100)]
}
