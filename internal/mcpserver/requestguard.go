package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/ratelimit"
)

const (
	mcpCallMethod = "tools/call"
	mcpListMethod = "tools/list"
)

// errAgentUnauthenticated is the single wire answer for any agent credential
// failure; the reason stays server side.
var errAgentUnauthenticated = errors.New("agent token is invalid, expired or revoked")

// errAgentUnavailable replaces a store failure while resolving the agent; the
// detail is logged, never sent.
var errAgentUnavailable = errors.New("agent token verification is temporarily unavailable; retry later")

// requestGuard bounds the complete raw tools/call envelope before the SDK's
// typed tool schema and Janusly business parsing. It also makes the common
// authority envelope fail closed: an unknown tool, malformed typed request, or
// accidentally unguarded handler is denial-rate-limited and audited once.
func (server Deps) requestGuard(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if method != mcpCallMethod && method != mcpListMethod {
			return next(ctx, method, req)
		}
		if server.ResolveActor != nil {
			principal, err := server.ResolveActor(ctx, req)
			if err != nil {
				if errors.Is(err, agentclient.ErrInvalidToken) {
					server.auditTokenRejection(ctx, err, "")
					err = errAgentUnauthenticated
				} else {
					server.logger().Error("mcp agent resolution failed", "method", method, "error", err)
					err = errAgentUnavailable
				}
				if method == mcpCallMethod {
					result, _, _ := expected(err.Error())
					return result, nil
				}
				return nil, err
			}
			ctx = withCallActor(ctx, principal)
		}
		d := server.at(ctx)
		if method == mcpListMethod {
			result, err := next(ctx, method, req)
			return d.visibleTools(result), err
		}
		params, ok := req.GetParams().(*mcp.CallToolParamsRaw)
		if !ok || params == nil {
			return d.rejectToolRequest(ctx, "unknown", "MCP tool request is malformed", "request_decode", "")
		}
		toolName := auditToolName(params.Name)
		raw, marshalErr := json.Marshal(params)
		if marshalErr != nil || len(raw) > maxMCPRequestBytes {
			return d.rejectToolRequest(ctx, toolName,
				"MCP tool request is invalid or exceeds 256000 bytes", "request_bounds", "")
		}

		decision := &toolInvocationDecision{}
		guardedCtx := context.WithValue(ctx, toolInvocationDecisionKey{}, decision)
		result, err := next(guardedCtx, method, req)
		if !decision.decided {
			// No registered Janusly handler reached guardTool: this covers unknown
			// tools and SDK schema/decode failures, and prevents a future tool from
			// accidentally bypassing the shared authorization envelope.
			return d.rejectToolRequest(ctx, toolName,
				"MCP tool request did not pass the common authority envelope", "request_decode",
				decodeFailureDetail(toolName, result, err))
		}
		d.auditToolDecision(ctx, decision.toolName, decision.permissions, decision.write,
			decision.allowed, decision.reason, decision.phase)
		return withoutInternalError(d.logger(), toolName, result), err
	}
}

// withoutInternalError replaces the text of a handler's Go error, which the
// SDK would otherwise send verbatim (database and connection details).
// Expected business failures never carry one.
func withoutInternalError(logger *slog.Logger, toolName string, result mcp.Result) mcp.Result {
	call, ok := result.(*mcp.CallToolResult)
	if !ok || call == nil || call.GetError() == nil {
		return result
	}
	logger.Error("mcp tool failed", "tool", toolName, "error", call.GetError())
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{
		&mcp.TextContent{Text: toolName + " failed for an internal reason; retry later"},
	}}
}

func (d Deps) logger() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// decodeFailureDetail tells the caller how to repair a call the SDK rejected
// before any Janusly handler ran. It names only the tool and the schema
// violation, which tools/list already exposes; the audit keeps the fixed reason.
func decodeFailureDetail(toolName string, result mcp.Result, err error) string {
	var wire *jsonrpc.Error
	if errors.As(err, &wire) && wire.Code == jsonrpc.CodeInvalidParams && strings.HasPrefix(wire.Message, "unknown tool") {
		return fmt.Sprintf("unknown tool %q; tools/list shows the catalog", toolName)
	}
	call, ok := result.(*mcp.CallToolResult)
	if err != nil || !ok || call == nil || !call.IsError {
		return ""
	}
	var detail strings.Builder
	for _, content := range call.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			detail.WriteString(text.Text)
		}
	}
	if detail.Len() == 0 {
		return ""
	}
	return fmt.Sprintf("invalid arguments for %s (inputSchema in tools/list): %s", toolName, detail.String())
}

// visibleTools hides tools an agent client's capabilities do not reach, so
// tools/list matches what it may call.
func (d Deps) visibleTools(result mcp.Result) mcp.Result {
	principal := d.agent()
	list, ok := result.(*mcp.ListToolsResult)
	if principal == nil || !ok || list == nil {
		return result
	}
	visible := make([]*mcp.Tool, 0, len(list.Tools))
	for _, tool := range list.Tools {
		if principal.Tools[tool.Name] {
			visible = append(visible, tool)
		}
	}
	filtered := *list
	filtered.Tools = visible
	return &filtered
}

func auditToolName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unknown"
	}
	if utf8.RuneCountInString(value) > maxMCPIdentifierRunes {
		return "oversized"
	}
	return boundedMCPText(value, maxMCPIdentifierRunes)
}

func (d Deps) rejectToolRequest(
	ctx context.Context,
	toolName string,
	reason string,
	phase string,
	detail string,
) (mcp.Result, error) {
	limited := false
	if d.Limiter != nil && d.OrgID != "" && d.UserID != "" {
		key := fmt.Sprintf("%d:%s%s", len(d.OrgID), d.OrgID, d.UserID)
		if err := d.Limiter.Enforce(ctx, key, ratelimit.Options{
			Name: "mcp.denied." + phase, Max: 120, Window: time.Minute,
		}); err != nil {
			reason, limited = err.Error(), true
		}
	}
	d.auditToolDecision(ctx, toolName, []string{}, false, false, reason, phase)
	if detail != "" && !limited {
		reason = detail
	}
	result, _, _ := expected(reason)
	return result, nil
}
