// The loop node's legacy `map` mode: a pure per-item template projection —
// no tools, no side effects, items bounded at 1,000. The `item` and `index`
// scopes bind per iteration (they were deferred at config render), and
// late-bound unresolved paths flow back through the dispatcher's policy
// seam. Ported from loop-executor.ts.
package executors

import (
	"context"
	"fmt"
	"strings"

	"github.com/johnny4young/janusly/go/internal/grammar"
)

const loopMaxItems = 1_000

// normalizeItems: arrays pass through; strings split on commas with
// trimmed, empty-dropped entries; anything else is no items.
func normalizeItems(raw any) []any {
	switch value := raw.(type) {
	case []any:
		return value
	case string:
		var items []any
		for _, part := range strings.Split(value, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				items = append(items, trimmed)
			}
		}
		return items
	default:
		return nil
	}
}

func executeLoop(_ context.Context, in Input) (any, error) {
	if mode, _ := in.Config["mode"].(string); mode != "" && mode != "map" {
		return nil, fmt.Errorf("loop mode %q is not executable by this backend yet", mode)
	}
	rawItems, err := grammar.MapInput(in.Config["items"], map[string]any{
		"context": in.Context, "inputs": in.Config,
	})
	if err != nil {
		return nil, err
	}
	items := normalizeItems(rawItems)
	if len(items) > loopMaxItems {
		return nil, &ExecErrorShape{
			Message: fmt.Sprintf("Loop contains %d items; maximum is %d", len(items), loopMaxItems),
			Name:    "LoopItemLimitError", Code: "LOOP_ITEM_LIMIT_EXCEEDED",
		}
	}

	mapping := in.Config["mapping"]
	if mapping == nil {
		mapping = map[string]any{"item": "{{item}}", "index": "{{index}}"}
	}
	unresolvedSeen := map[string]bool{}
	var unresolved []string
	results := make([]any, 0, len(items))
	for index, item := range items {
		rendered, err := grammar.RenderTemplateWithRedactions(mapping, map[string]any{
			"context": in.Context, "inputs": in.Config,
			"item": item, "index": float64(index),
		}, grammar.RenderOptions{})
		if err != nil {
			return nil, err
		}
		for _, path := range rendered.UnresolvedPaths {
			if !unresolvedSeen[path] {
				unresolvedSeen[path] = true
				unresolved = append(unresolved, path)
			}
		}
		results = append(results, rendered.Rendered)
	}
	if len(unresolved) > 0 && in.ReportUnresolved != nil {
		if err := in.ReportUnresolved(unresolved); err != nil {
			return nil, err
		}
	}
	if in.Emit != nil {
		in.Emit("loop.completed", map[string]any{"count": len(results), "items": results})
	}
	return map[string]any{"count": len(results), "items": results}, nil
}
