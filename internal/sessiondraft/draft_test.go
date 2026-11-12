package sessiondraft

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/agentsession"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/hookwire"
	"github.com/johnny4young/janusly/internal/publishgate"
)

var t0 = time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

func call(agent, agentType, tool, kind, server string, second int, durationMs int64) agentsession.EventRow {
	return agentsession.EventRow{
		Type: hookwire.TypeToolCompleted, AgentID: agent, AgentType: agentType, Tool: tool, ToolKind: kind,
		MCPServer: server, Status: "ok", DurationMs: &durationMs, At: t0.Add(time.Duration(second) * time.Second),
	}
}

func nodeTypes(t *testing.T, draft Draft) map[string]string {
	t.Helper()
	types := map[string]string{}
	for _, raw := range draft.Document["nodes"].([]any) {
		node := raw.(map[string]any)
		types[node["id"].(string)] = node["type"].(string)
	}
	return types
}

func TestOverlappingSubagentsRunBetweenAForkAndItsJoin(t *testing.T) {
	events := []agentsession.EventRow{
		call("", "", "mcp__notion__search", "mcp", "notion", 0, 100),
		call("", "", "Bash", "builtin", "", 1, 5),
		call("", "", "mcp__janusly__drafts.save", "mcp", "janusly", 2, 5),
		// a and b overlap; c starts after both ended.
		call("a", "Explore", "mcp__stripe__list_charges", "mcp", "stripe", 10, 400),
		call("b", "Plan", "mcp__slack__post_message", "mcp", "slack", 12, 900),
		call("a", "Explore", "mcp__stripe__get_charge", "mcp", "stripe", 20, 600),
		call("b", "Plan", "Read", "builtin", "", 21, 3),
		call("c", "Report", "mcp__notion__create_page", "mcp", "notion", 40, 250),
	}
	conversion := Convertibility(events)
	if conversion.TotalSteps != 8 || conversion.ConvertibleSteps != 5 || conversion.Agents != 4 || !conversion.Convertible ||
		strings.Join(conversion.MCPServers, ",") != "notion,slack,stripe" {
		t.Fatalf("conversion: %+v", conversion)
	}
	draft, err := BuildDraft("wf_test", "Observed session in billing", events)
	if err != nil {
		t.Fatal(err)
	}
	types := nodeTypes(t, draft)
	if types["agent_1"] != "agent" || types["fork_2"] != "parallel_fork" || types["join_2"] != "join" || types["agent_4"] != "agent" || len(types) != 6 {
		t.Fatalf("nodes: %v", types)
	}
	edges := map[string]bool{}
	for _, raw := range draft.Document["edges"].([]any) {
		edge := raw.(map[string]any)
		edges[edge["from"].(string)+">"+edge["to"].(string)] = true
	}
	for _, want := range []string{"agent_1>fork_2", "fork_2>agent_2", "fork_2>agent_3", "agent_2>join_2", "agent_3>join_2", "join_2>agent_4"} {
		if !edges[want] {
			t.Fatalf("missing edge %s in %v", want, edges)
		}
	}
	if len(edges) != 6 {
		t.Fatalf("edges: %v", edges)
	}
	raw, _ := json.Marshal(draft.Document)
	for _, leak := range []string{"Bash", "Read", "janusly__"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("%s reached the draft: %s", leak, raw)
		}
	}
	if draft.Agents[1].AgentType != "Explore" || strings.Join(draft.Agents[1].Tools, ",") != "mcp__stripe__list_charges,mcp__stripe__get_charge" ||
		draft.Agents[1].SuggestedTimeoutMs != 1200 {
		t.Fatalf("agent summary: %+v", draft.Agents[1])
	}

	// The gate refuses the draft until every placeholder is filled in.
	wf, _ := domain.Parse(raw)
	var document map[string]any
	_ = json.Unmarshal(raw, &document)
	open := map[string]bool{}
	for _, check := range publishgate.StaticChecks(wf, document, nil, authoring.Catalog{}) {
		if check.Code == "observed_placeholder" {
			open[check.Path] = true
		}
	}
	for _, path := range append([]string{}, draft.Placeholders...) {
		if !open[path] {
			t.Fatalf("placeholder %s is not a gate check: %v", path, open)
		}
	}
	if len(open) != 5 || !open["/nodes/agent_2/config/goal"] || !open["/outputs/result"] {
		t.Fatalf("placeholder checks: %v", open)
	}
}

func TestOnlySessionsWithMCPToolsConvert(t *testing.T) {
	coding := []agentsession.EventRow{
		call("", "", "Bash", "builtin", "", 0, 5), call("", "", "Edit", "builtin", "", 1, 5),
		call("", "", "mcp__janusly__workflows.list", "mcp", "janusly", 2, 5),
	}
	if conversion := Convertibility(coding); conversion.Convertible || conversion.ConvertibleSteps != 0 || conversion.TotalSteps != 3 {
		t.Fatalf("a coding session reads as convertible: %+v", conversion)
	}
	if _, err := BuildDraft("wf", "x", coding); !errors.Is(err, ErrNotConvertible) {
		t.Fatalf("coding session converted: %v", err)
	}
	many := []agentsession.EventRow{}
	for i := range MaxDraftAgents + 1 {
		many = append(many, call(string(rune('a'+i)), "", "mcp__x__y", "mcp", "x", i*10, 1))
	}
	if _, err := BuildDraft("wf", "x", many); !errors.Is(err, ErrTooManyAgents) {
		t.Fatalf("too many agents: %v", err)
	}
}
