// The `mcp_tool` node executor — the thin, dependency-free half of the
// MCP client. All heavy lifting (connection/descriptor lookup, consent,
// sandbox, transports) lives behind the injected McpDeps.Execute closure
// (built by the engine dispatcher from internal/mcpclient), so this
// package never imports the MCP SDK or the store. The chokepoint NEVER
// throws — it returns a typed envelope on every path — and this executor
// converts `ok:false` into an error so the run's existing retry / DLQ
// machinery applies (same contract as the http node).
package executors

import (
	"context"
	"fmt"
)

// McpCall is one tool invocation as the node config expresses it.
type McpCall struct {
	ConnectionAlias string
	ToolName        string
	Input           map[string]any
	TimeoutMs       float64
}

// McpEnvelope is the normalized per-call outcome, implements the
// contract's McpToolEnvelope.
type McpEnvelope struct {
	OK              bool
	Error           string
	Output          map[string]any
	LatencyMs       int64
	ConnectionAlias string
	ToolName        string
	Transport       string
	WriteSide       bool
	// SandboxFailureCode is set only for stdio terminations driven by the
	// sandbox layer (allowlist / lifetime / stderr cap); empty otherwise.
	SandboxFailureCode string
	// StderrTail is the last 1024 chars of the redacted stdio stderr
	// capture; empty for URL transports.
	StderrTail string
}

// McpDeps is the dispatcher-built seam carrying the real client.
type McpDeps struct {
	Execute func(ctx context.Context, call McpCall) McpEnvelope
}

// NewMcpToolExecutor builds the mcp_tool node over the injected seam.
func NewMcpToolExecutor() Func {
	return func(ctx context.Context, in Input) (any, error) {
		alias, _ := in.Config["connectionAlias"].(string)
		if alias == "" {
			return nil, fmt.Errorf("mcp_tool requires config.connectionAlias")
		}
		toolName, _ := in.Config["toolName"].(string)
		if toolName == "" {
			return nil, fmt.Errorf("mcp_tool requires config.toolName")
		}
		if in.Mcp == nil || in.Mcp.Execute == nil {
			return nil, fmt.Errorf("mcp_tool executor requires engine context")
		}
		input, _ := in.Config["input"].(map[string]any)
		if input == nil {
			input = map[string]any{}
		}
		timeoutMs, _ := in.Config["timeoutMs"].(float64)

		emit := func(eventType string, payload map[string]any) {
			if in.Emit != nil {
				in.Emit(eventType, payload)
			}
		}
		emit("mcp_tool.started", map[string]any{
			"connectionAlias": alias, "toolName": toolName,
		})
		envelope := in.Mcp.Execute(ctx, McpCall{
			ConnectionAlias: alias, ToolName: toolName,
			Input: input, TimeoutMs: timeoutMs,
		})
		completed := map[string]any{
			"connectionAlias": alias, "toolName": toolName,
			"ok": envelope.OK, "latencyMs": envelope.LatencyMs,
			"writeSide": envelope.WriteSide,
		}
		if envelope.Error != "" {
			completed["error"] = envelope.Error
		}
		if envelope.SandboxFailureCode != "" {
			completed["sandboxFailureCode"] = envelope.SandboxFailureCode
		}
		if envelope.StderrTail != "" {
			completed["stderrTail"] = envelope.StderrTail
		}
		emit("mcp_tool.completed", completed)
		if envelope.SandboxFailureCode != "" {
			var tail any
			if envelope.StderrTail != "" {
				tail = envelope.StderrTail
			}
			emit("mcp.sandbox.terminated", map[string]any{
				"connectionAlias": alias, "toolName": toolName,
				"reason": envelope.SandboxFailureCode, "stderrTail": tail,
				"writeSide": envelope.WriteSide,
			})
		}
		if !envelope.OK {
			errText := envelope.Error
			if errText == "" {
				errText = "unknown"
			}
			return nil, fmt.Errorf("mcp_tool failed: %s", errText)
		}
		output := envelope.Output
		if output == nil {
			output = map[string]any{}
		}
		return map[string]any{"status": "completed", "output": output}, nil
	}
}
