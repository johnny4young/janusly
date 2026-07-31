// The `tool` node executor: renders its input, dispatches to the registry,
// and returns the reference's envelope shape {tool, result}. resultPolicy
// "require_ok" fails the node on an unsuccessful envelope; the default
// "envelope" hands the result downstream for the workflow to branch on.
package executors

import (
	"context"
	"fmt"

	"github.com/johnny4young/janusly/go/internal/tools"
)

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

		output, err := registry.Execute(ctx, name, input)
		result := map[string]any{"ok": true}
		if err != nil {
			result = map[string]any{"ok": false, "error": err.Error()}
			if policy == "require_ok" {
				return nil, fmt.Errorf("Tool %s returned an unsuccessful result: %s", name, err.Error()) //nolint:staticcheck // reference message is the wire contract
			}
		} else {
			for key, value := range output {
				result[key] = value
			}
		}
		return map[string]any{"tool": name, "result": result}, nil
	}
}
