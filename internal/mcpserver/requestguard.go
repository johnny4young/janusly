package mcpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/ratelimit"
)

const mcpCallMethod = "tools/call"

// requestGuard bounds the complete raw tools/call envelope before the SDK's
// typed tool schema and Janusly business parsing. It also makes the common
// authority envelope fail closed: an unknown tool, malformed typed request, or
// accidentally unguarded handler is denial-rate-limited and audited once.
func (d Deps) requestGuard(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if method != mcpCallMethod {
			return next(ctx, method, req)
		}
		params, ok := req.GetParams().(*mcp.CallToolParamsRaw)
		if !ok || params == nil {
			return d.rejectToolRequest(ctx, "unknown", "MCP tool request is malformed", "request_decode")
		}
		toolName := auditToolName(params.Name)
		raw, marshalErr := json.Marshal(params)
		if marshalErr != nil || len(raw) > maxMCPRequestBytes {
			return d.rejectToolRequest(ctx, toolName,
				"MCP tool request is invalid or exceeds 256000 bytes", "request_bounds")
		}

		decision := &toolInvocationDecision{}
		guardedCtx := context.WithValue(ctx, toolInvocationDecisionKey{}, decision)
		result, err := next(guardedCtx, method, req)
		if !decision.decided {
			// No registered Janusly handler reached guardTool: this covers unknown
			// tools and SDK schema/decode failures, and prevents a future tool from
			// accidentally bypassing the shared authorization envelope.
			return d.rejectToolRequest(ctx, toolName,
				"MCP tool request did not pass the common authority envelope", "request_decode")
		}
		d.auditToolDecision(ctx, decision.toolName, decision.permissions, decision.write,
			decision.allowed, decision.reason, decision.phase)
		return result, err
	}
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
) (mcp.Result, error) {
	if d.Limiter != nil && d.OrgID != "" && d.UserID != "" {
		key := fmt.Sprintf("%d:%s%s", len(d.OrgID), d.OrgID, d.UserID)
		if err := d.Limiter.Enforce(ctx, key, ratelimit.Options{
			Name: "mcp.denied." + phase, Max: 120, Window: time.Minute,
		}); err != nil {
			reason = err.Error()
		}
	}
	d.auditToolDecision(ctx, toolName, []string{}, false, false, reason, phase)
	result, _, _ := expected(reason)
	return result, nil
}
