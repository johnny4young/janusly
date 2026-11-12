package mcpserver

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
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

func TestActorStoreErrorsNeverReachTheClient(t *testing.T) {
	raw := errors.New("failed to connect to user=janusly database=janusly host=10.0.0.5")
	server := NewServer(Deps{Transport: "stdio",
		ResolveActor: func(context.Context, mcp.Request) (*agentclient.Principal, error) { return nil, raw },
	})
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		_ = server.Run(context.Background(), serverTransport)
	}()
	client := mcp.NewClient(&mcp.Implementation{Name: "actor-error-test", Version: "1"}, nil)
	session, err := client.Connect(context.Background(), clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close(); <-serverDone })
	if _, err := session.ListTools(context.Background(), nil); err == nil || strings.Contains(err.Error(), "database=") {
		t.Fatalf("tools/list leaked or succeeded: %v", err)
	}
	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: "agent.info", Arguments: map[string]any{}})
	if err != nil && strings.Contains(err.Error(), "database=") {
		t.Fatalf("tools/call leaked: %v", err)
	}
	if err == nil && (!res.IsError || strings.Contains(res.Content[0].(*mcp.TextContent).Text, "database=")) {
		t.Fatalf("tools/call leaked or succeeded: %+v", res.Content)
	}
}
