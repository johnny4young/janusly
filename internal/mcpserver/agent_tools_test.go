package mcpserver

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
)

func allAgentTools() []string {
	tools := []string{}
	for tool := range agentclient.CeilingTools(agentclient.AllCapabilities) {
		tools = append(tools, tool)
	}
	slices.Sort(tools)
	return tools
}

func listCatalog(t *testing.T, deps Deps) []*mcp.Tool {
	t.Helper()
	server := NewServer(deps)
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		_ = server.Run(context.Background(), serverTransport)
	}()
	client := mcp.NewClient(&mcp.Implementation{Name: "agent-catalog-test", Version: "1"}, nil)
	session, err := client.Connect(context.Background(), clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close(); <-serverDone })
	listed, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return listed.Tools
}

// Every capability tool must exist, and only the operator-only tools may be
// unreachable for agents: a new tool has to be placed deliberately.
func TestAgentCapabilitiesCoverTheCatalog(t *testing.T) {
	catalog := map[string]bool{}
	for _, tool := range listCatalog(t, Deps{}) {
		catalog[tool.Name] = true
	}
	reachable := map[string]bool{}
	for _, tool := range allAgentTools() {
		if !catalog[tool] {
			t.Fatalf("capability names %s, which the catalog does not have", tool)
		}
		reachable[tool] = true
	}
	unreachable := []string{}
	for tool := range catalog {
		if !reachable[tool] {
			unreachable = append(unreachable, tool)
		}
	}
	slices.Sort(unreachable)
	if want := []string{"workflows.propose", "workflows.save"}; !slices.Equal(unreachable, want) {
		t.Fatalf("tools outside every capability = %v, want %v", unreachable, want)
	}
	for tool := range catalog {
		if strings.Contains(tool, "approve") || strings.Contains(tool, "decide") {
			t.Fatalf("MCP must never expose a human decision: %s", tool)
		}
	}
}

func TestAgentToolsListShowsOnlyItsCapabilities(t *testing.T) {
	principal := &agentclient.Principal{
		ClientID: "client-1", OrgID: "org-1", Name: "reader",
		Capabilities: []agentclient.Capability{agentclient.CapabilityRead},
		Tools:        agentclient.CeilingTools([]agentclient.Capability{agentclient.CapabilityRead}),
		Permissions:  map[string]bool{"workflows.read": true}, ExpiresAt: time.Now().Add(time.Hour),
	}
	tools := listCatalog(t, Deps{ResolveActor: func(context.Context, mcp.Request) (*agentclient.Principal, error) {
		return principal, nil
	}})
	for _, tool := range tools {
		if !principal.Tools[tool.Name] {
			t.Fatalf("read-only client sees %s", tool.Name)
		}
	}
	if len(tools) != len(principal.Tools) {
		t.Fatalf("listed %d tools, capability reaches %d", len(tools), len(principal.Tools))
	}
}

func TestAgentGuardRefusesToolsOutsideItsCapabilities(t *testing.T) {
	principal := &agentclient.Principal{
		ClientID: "client-1", OrgID: "org-1",
		Capabilities: []agentclient.Capability{agentclient.CapabilityRead, agentclient.CapabilityOperate},
		Tools:        agentclient.CeilingTools([]agentclient.Capability{agentclient.CapabilityRead, agentclient.CapabilityOperate}),
		// workflows.write is held through operate, yet save stays out of reach.
		Permissions: map[string]bool{"workflows.write": true, "workflows.read": true},
	}
	deps := Deps{}.at(withCallActor(context.Background(), principal))
	allowed, message := deps.guardTool(context.Background(), "workflows.save", "workflows.write", true)
	if allowed || !strings.Contains(message, "agent.info") {
		t.Fatalf("save must stay out of an agent's reach: allowed=%v message=%q", allowed, message)
	}
	if deps.UserID != "agent:client-1" || deps.OrgID != "org-1" {
		t.Fatalf("deps not bound to the agent: %+v", deps)
	}
}

func TestGuardRefusesAToolThatNamesNoPermission(t *testing.T) {
	operator := Deps{OrgID: "org-1", UserID: "operator-1", Permissions: map[string]bool{"workflows.read": true}}
	for _, required := range [][]string{nil, {}, {""}} {
		if allowed, _ := operator.guardToolAny(context.Background(), "workflows.list", required, false); allowed {
			t.Fatalf("an empty permission list %q admitted the caller", required)
		}
	}
	if allowed, message := operator.guardToolAny(context.Background(), "agent.info", nil, false); !allowed {
		t.Fatalf("agent.info needs no business permission: %q", message)
	}
	principal := &agentclient.Principal{
		ClientID: "client-1", OrgID: "org-1",
		Capabilities: []agentclient.Capability{agentclient.CapabilityRead},
		Tools:        agentclient.CeilingTools([]agentclient.Capability{agentclient.CapabilityRead}),
		Permissions:  map[string]bool{},
	}
	agent := Deps{}.at(withCallActor(context.Background(), principal))
	if allowed, message := agent.guardToolAny(context.Background(), "agent.info", nil, false); !allowed {
		t.Fatalf("a demoted agent must still read agent.info: %q", message)
	}
	if allowed, _ := agent.guardToolAny(context.Background(), "workflows.list", nil, false); allowed {
		t.Fatal("an agent reached a business tool without a permission")
	}
}
