package mcpserver

import (
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestInternalToolErrorsNeverReachTheClient(t *testing.T) {
	failing := &mcp.CallToolResult{}
	failing.SetError(errors.New("failed to connect to user=janusly database=janusly host=10.0.0.5"))
	replaced, ok := withoutInternalError(slog.Default(), "runs.status", failing).(*mcp.CallToolResult)
	if !ok || !replaced.IsError || replaced.GetError() != nil {
		t.Fatalf("internal error kept: %+v", replaced)
	}
	text := replaced.Content[0].(*mcp.TextContent).Text
	if strings.Contains(text, "janusly database") || !strings.Contains(text, "runs.status") {
		t.Fatalf("leaked or unhelpful text: %q", text)
	}
	business, _, _ := expected("run not found")
	if withoutInternalError(slog.Default(), "runs.status", business) != business {
		t.Fatal("an expected failure was rewritten")
	}
}
