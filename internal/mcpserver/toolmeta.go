package mcpserver

import "github.com/modelcontextprotocol/go-sdk/mcp"

// MCP annotations are hints rather than authority, but keeping them truthful
// lets compatible clients show an independent confirmation affordance. The
// server still enforces every permission, consent and lifecycle invariant.
func readTool(name, title, description string) *mcp.Tool {
	return &mcp.Tool{
		Name: name, Title: title, Description: description,
		Annotations: &mcp.ToolAnnotations{
			Title: title, ReadOnlyHint: true, IdempotentHint: true,
			DestructiveHint: new(false), OpenWorldHint: new(false),
		},
	}
}

func writeTool(name, title, description string, destructive bool) *mcp.Tool {
	return &mcp.Tool{
		Name: name, Title: title, Description: description,
		Annotations: &mcp.ToolAnnotations{
			Title: title, ReadOnlyHint: false, IdempotentHint: false,
			DestructiveHint: new(destructive), OpenWorldHint: new(false),
		},
	}
}
