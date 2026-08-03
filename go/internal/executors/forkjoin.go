// parallel_fork and join — the declarative fan-out/fan-in pair. Both are
// thin shells over runtime semantics the engine already provides: fan-out
// IS having multiple outgoing edges, "wait for all branches" IS the ALL-AND
// readiness check, and the atomic single claim of the join IS the queue's
// pending→queued transition. The executors only validate declarations and
// shape outputs; ported from parallel-fork.ts with its verbatim messages.
package executors

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"
)

const (
	minBranches          = 2
	maxBranches          = 10
	maxBranchLabelLength = 64
	maxBranchDescLength  = 280
)

// resolveParallelForkBranches validates config.branches into the declared
// order, throwing with the reference's descriptive messages.
func resolveParallelForkBranches(config map[string]any) ([]map[string]any, error) {
	raw, ok := config["branches"].([]any)
	if !ok {
		return nil, fmt.Errorf("parallel_fork.config.branches must be an array of { label, description? } entries")
	}
	if len(raw) < minBranches {
		return nil, fmt.Errorf("parallel_fork.config.branches must declare at least %d branches (got %d)", minBranches, len(raw))
	}
	if len(raw) > maxBranches {
		return nil, fmt.Errorf("parallel_fork.config.branches supports at most %d branches (got %d)", maxBranches, len(raw))
	}
	seen := map[string]bool{}
	branches := make([]map[string]any, 0, len(raw))
	for index, entry := range raw {
		item, ok := entry.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("parallel_fork.config.branches[%d] must be an object with a `label` field", index)
		}
		label, ok := item["label"].(string)
		if !ok || strings.TrimSpace(label) == "" {
			return nil, fmt.Errorf("parallel_fork.config.branches[%d].label is required and must be a non-empty string", index)
		}
		if len(label) > maxBranchLabelLength {
			return nil, fmt.Errorf("parallel_fork.config.branches[%d].label must be ≤ %d chars (got %d)", index, maxBranchLabelLength, len(label))
		}
		if seen[label] {
			return nil, fmt.Errorf("parallel_fork.config.branches has duplicate label %q", label)
		}
		seen[label] = true
		branch := map[string]any{"label": label}
		if description, present := item["description"]; present {
			text, ok := description.(string)
			if !ok {
				return nil, fmt.Errorf("parallel_fork.config.branches[%d].description must be a string when provided", index)
			}
			if len(text) > maxBranchDescLength {
				return nil, fmt.Errorf("parallel_fork.config.branches[%d].description must be ≤ %d chars", index, maxBranchDescLength)
			}
			branch["description"] = text
		}
		branches = append(branches, branch)
	}
	return branches, nil
}

// resolveJoinSources validates config.sources into label → predecessor id,
// rejecting duplicate predecessors (the copy-paste mistake surfaced loudly).
func resolveJoinSources(config map[string]any) (map[string]string, error) {
	raw, ok := config["sources"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("join.config.sources must be an object mapping branch labels to predecessor node ids")
	}
	if len(raw) < minBranches {
		return nil, fmt.Errorf("join.config.sources must declare at least %d branches (got %d)", minBranches, len(raw))
	}
	if len(raw) > maxBranches {
		return nil, fmt.Errorf("join.config.sources supports at most %d branches (got %d)", maxBranches, len(raw))
	}
	labels := slices.Sorted(maps.Keys(raw))
	sources := map[string]string{}
	seenPredecessors := map[string]bool{}
	for _, label := range labels {
		if strings.TrimSpace(label) == "" {
			return nil, fmt.Errorf("join.config.sources contains an empty branch label")
		}
		if len(label) > maxBranchLabelLength {
			return nil, fmt.Errorf("join.config.sources label %q must be ≤ %d chars", label, maxBranchLabelLength)
		}
		value, ok := raw[label].(string)
		if !ok || strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("join.config.sources[%q] must be a non-empty predecessor node id", label)
		}
		if seenPredecessors[value] {
			return nil, fmt.Errorf("join.config.sources references predecessor %q more than once", value)
		}
		seenPredecessors[value] = true
		sources[label] = value
	}
	return sources, nil
}

// executeParallelFork validates and echoes the declared branches; fan-out
// is the node's outgoing edges.
func executeParallelFork(_ context.Context, in Input) (any, error) {
	branches, err := resolveParallelForkBranches(in.Config)
	if err != nil {
		return nil, err
	}
	return map[string]any{"branches": branches}, nil
}

// executeJoin assembles output.branches keyed by label from each declared
// predecessor's context output. A missing output reads as nil, defensively —
// the runtime's fan-in readiness prevents it in practice.
func executeJoin(_ context.Context, in Input) (any, error) {
	sources, err := resolveJoinSources(in.Config)
	if err != nil {
		return nil, err
	}
	branches := map[string]any{}
	for label, predecessorID := range sources {
		if entry, ok := in.Context[predecessorID].(map[string]any); ok {
			branches[label] = entry["output"]
			continue
		}
		branches[label] = nil
	}
	return map[string]any{"branches": branches}, nil
}
