// The `tool` node executor: renders its input, dispatches to the registry,
// and returns the reference's envelope shape {tool, result}. resultPolicy
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
	"fmt"
	"maps"

	"github.com/johnny4young/janusly/go/internal/tools"
)

// executeRegisteredTool runs one tool invocation through the shared
// interception ladder and ALWAYS answers an envelope map — a thrown
// registry error becomes {ok:false, error} (callers needing hard failure
// semantics, like require_ok, re-raise from the envelope).
func executeRegisteredTool(ctx context.Context, registry *tools.Registry, name string, input map[string]any, in Input) map[string]any {
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
func NewToolExecutor(registry *tools.Registry) Func {
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

		result := executeRegisteredTool(ctx, registry, name, input, in)
		if result["ok"] == false && policy == "require_ok" {
			message, _ := result["error"].(string)
			return nil, fmt.Errorf("Tool %s returned an unsuccessful result: %s", name, message) //nolint:staticcheck // reference message is the wire contract
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
