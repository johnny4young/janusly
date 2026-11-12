package mcpserver

import (
	"context"
	"slices"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
)

func registerAgentTools(server *mcp.Server, deps Deps) {
	mcp.AddTool(server, readTool(
		"agent.info", "Agent client",
		"Describe the calling agent client: its capabilities, the tools they reach, its effective permissions, scope, expiry and rate limit.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).agentInfo(ctx)
	})
}

func (d Deps) agentInfo(ctx context.Context) (*mcp.CallToolResult, any, error) {
	// No business permission: an agent whose creator was demoted must still
	// learn why its calls fail.
	if allowed, message := d.guardToolAny(ctx, "agent.info", nil, false); !allowed {
		return expected(message)
	}
	principal := d.agent()
	if principal == nil {
		return ok(map[string]any{
			"kind": "operator", "organizationId": d.OrgID,
			"permissions": PermissionKeys(d.Permissions), "tools": []string{}, "capabilities": []string{},
			"scope": map[string]any{"workflowIds": []string{}, "tags": []string{}},
		})
	}
	tools := make([]string, 0, len(principal.Tools))
	for tool := range principal.Tools {
		tools = append(tools, tool)
	}
	slices.Sort(tools)
	missing := agentclient.MissingPermissions(principal.Capabilities, principal.Permissions)
	return ok(map[string]any{
		"kind": "agent", "clientId": principal.ClientID, "name": principal.Name,
		"organizationId":     principal.OrgID,
		"capabilities":       agentclient.Strings(principal.Capabilities),
		"tools":              tools,
		"permissions":        PermissionKeys(principal.Permissions),
		"missingPermissions": missing,
		"scope": map[string]any{
			"workflowIds": nonNil(principal.ScopeWorkflowIDs), "tags": nonNil(principal.ScopeTags),
		},
		"expiresAt":          principal.ExpiresAt.UTC().Format(time.RFC3339),
		"rateLimitPerMinute": principal.RateLimitPerMinute,
	})
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
