// The `tool` node executor: renders its input, dispatches to the registry,
// and returns the contract's envelope shape {tool, result}. resultPolicy
// "require_ok" fails the node on an unsuccessful envelope; the default
// "envelope" hands the result downstream for the workflow to branch on.
//
// executeRegisteredTool is the ONE interception ladder (vector seams →
// dry-run write-side skip → integration chokepoint → plain registry) —
// the tool node and the for_each loop both dispatch through it, so a tool
// behaves identically no matter which node invoked it.
package executors

import (
	"context"
	"errors"
	"fmt"
	"maps"

	"github.com/johnny4young/janusly/internal/tools"
)

// executeRegisteredTool runs one tool invocation through the shared
// interception ladder and ALWAYS answers an envelope map — a thrown
// registry error becomes {ok:false, error} (callers needing hard failure
// semantics, like require_ok, re-raise from the envelope).
func executeRegisteredTool(ctx context.Context, registry *tools.Registry, httpExec Func, name string, input map[string]any, in Input) map[string]any {
	// Validate the RENDERED input before every interception branch. Save-time
	// validation cannot know the native type of a whole template reference,
	// and neither vector seams nor dry-run skips may turn a type mismatch into
	// an apparently successful invocation.
	if err := registry.ValidateResolvedInput(name, input); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	// http.request must be semantically identical whether selected by a tool,
	// loop, or agent node. The shared HTTP executor is the only path that
	// applies tenant bounds, method-aware dry-run behavior, SSRF protection,
	// redirect policy, and write-side error classification together.
	if name == "http.request" {
		httpInput := in
		httpInput.Config = maps.Clone(input)
		output, err := httpExec(ctx, httpInput)
		if err != nil {
			result := map[string]any{"ok": false, "error": err.Error()}
			var shape *ExecErrorShape
			if errors.As(err, &shape) {
				if shape.Code != "" {
					result["code"] = shape.Code
				}
				if shape.StatusCode > 0 {
					result["statusCode"] = shape.StatusCode
				}
				if shape.Details != nil {
					result["details"] = shape.Details
				}
				if shape.WriteSide {
					result["writeSide"] = true
				}
			}
			return result
		}
		result := map[string]any{"ok": true}
		if outputMap, ok := output.(map[string]any); ok {
			maps.Copy(result, outputMap)
		}
		return result
	}
	if name == "vector.search" || name == "vector.upsert" {
		return executeVectorTool(name, input, in.Memory)
	}
	// The sandbox gate: a validation replay must not produce external
	// effects — every registered write-side tool skips cooperatively.
	if in.DryRun && registry.IsWriteSide(name) {
		return map[string]any{"ok": true, "skipped": true, "reason": "validation_dry_run"}
	}
	// Integration tools ride the shared chokepoint seams (credential gate
	// + rate limit + usage + guarded egress).
	if tools.IsIntegrationTool(name) {
		return tools.ExecuteIntegrationTool(ctx, name, input, in.Integrations)
	}
	output, err := registry.Execute(ctx, name, input)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	result := map[string]any{"ok": true}
	maps.Copy(result, output)
	return result
}

// NewToolExecutor builds the tool-node executor over a registry.
func NewToolExecutor(registry *tools.Registry, httpExecutors ...Func) Func {
	httpExec := NewHTTPExecutor(HTTPOptions{})
	if len(httpExecutors) > 0 && httpExecutors[0] != nil {
		httpExec = httpExecutors[0]
	}
	return func(ctx context.Context, in Input) (any, error) {
		name, _ := in.Config["tool"].(string)
		if name == "" {
			return nil, fmt.Errorf("tool node requires config.tool")
		}
		input, _ := in.Config["input"].(map[string]any)
		if input == nil {
			input = map[string]any{}
		}
		policy, _ := in.Config["resultPolicy"].(string)

		result := executeRegisteredTool(ctx, registry, httpExec, name, input, in)
		if result["ok"] == false && policy == "require_ok" {
			message, _ := result["error"].(string)
			statusCode := 0
			switch value := result["statusCode"].(type) {
			case int:
				statusCode = value
			case float64:
				statusCode = int(value)
			}
			writeSide := registry.IsWriteSide(name)
			if name == "http.request" {
				method, _ := input["method"].(string)
				writeSide = httpMethodWriteSide(method)
			}
			return nil, &ExecErrorShape{
				Message:    fmt.Sprintf("Tool %s returned an unsuccessful result: %s", name, message), //nolint:staticcheck // contract message is the wire contract
				Name:       "ToolResultError",
				Code:       "TOOL_RESULT_NOT_OK",
				StatusCode: statusCode,
				// The envelope does not prove whether a write-side provider failed
				// before or after accepting the effect. Conservatively suppress
				// whole-node retries; an operator can inspect and redrive.
				WriteSide: writeSide,
			}
		}
		return map[string]any{"tool": name, "result": result}, nil
	}
}

// executeVectorTool: thin wrappers over the memory substrate. Consent off
// (or no deps) answers {ok:false, error:"memory_disabled"} for upsert and
// an empty result for search — never a throw. A validation (dry-run)
// execution skips the WRITE side entirely.
func executeVectorTool(name string, input map[string]any, deps *MemoryDeps) map[string]any {
	if name == "vector.search" {
		query, _ := input["query"].(string)
		if deps == nil || deps.Recall == nil || query == "" {
			return map[string]any{"ok": true, "entries": []any{}}
		}
		entries := deps.Recall(query)
		anyEntries := make([]any, 0, len(entries))
		for _, entry := range entries {
			anyEntries = append(anyEntries, entry)
		}
		return map[string]any{"ok": true, "entries": anyEntries}
	}
	content, _ := input["content"].(string)
	if content == "" {
		return map[string]any{"ok": false, "error": "content is required"}
	}
	if deps == nil || deps.Commit == nil {
		return map[string]any{"ok": false, "error": "memory_disabled"}
	}
	if deps.DryRun {
		return map[string]any{"ok": true, "skipped": true, "reason": "validation_dry_run"}
	}
	metadata, _ := input["metadata"].(map[string]any)
	return deps.Commit(content, metadata)
}
