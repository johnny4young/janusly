package domain

import (
	"fmt"
	"maps"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	ForkJoinMinBranches          = 2
	ForkJoinMaxBranches          = 10
	ForkJoinMaxBranchLabelLength = 64
	ForkJoinMaxBranchDescLength  = 280
)

// ResolveParallelForkBranches is the shared authoring/runtime grammar for a
// parallel fork. Keeping it in domain prevents save-time validation and the
// executor from accepting different workflow documents.
func ResolveParallelForkBranches(config map[string]any) ([]map[string]any, error) {
	raw, ok := config["branches"].([]any)
	if !ok {
		return nil, fmt.Errorf("parallel_fork.config.branches must be an array of { label, description? } entries")
	}
	if len(raw) < ForkJoinMinBranches {
		return nil, fmt.Errorf("parallel_fork.config.branches must declare at least %d branches (got %d)", ForkJoinMinBranches, len(raw))
	}
	if len(raw) > ForkJoinMaxBranches {
		return nil, fmt.Errorf("parallel_fork.config.branches supports at most %d branches (got %d)", ForkJoinMaxBranches, len(raw))
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
		if label != strings.TrimSpace(label) {
			return nil, fmt.Errorf("parallel_fork.config.branches[%d].label must not have leading or trailing whitespace", index)
		}
		labelLength := utf8.RuneCountInString(label)
		if labelLength > ForkJoinMaxBranchLabelLength {
			return nil, fmt.Errorf("parallel_fork.config.branches[%d].label must be ≤ %d chars (got %d)", index, ForkJoinMaxBranchLabelLength, labelLength)
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
			if utf8.RuneCountInString(text) > ForkJoinMaxBranchDescLength {
				return nil, fmt.Errorf("parallel_fork.config.branches[%d].description must be ≤ %d chars", index, ForkJoinMaxBranchDescLength)
			}
			branch["description"] = text
		}
		branches = append(branches, branch)
	}
	return branches, nil
}

// ResolveJoinSources is the shared authoring/runtime grammar for fan-in.
func ResolveJoinSources(config map[string]any) (map[string]string, error) {
	raw, ok := config["sources"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("join.config.sources must be an object mapping branch labels to predecessor node ids")
	}
	if len(raw) < ForkJoinMinBranches {
		return nil, fmt.Errorf("join.config.sources must declare at least %d branches (got %d)", ForkJoinMinBranches, len(raw))
	}
	if len(raw) > ForkJoinMaxBranches {
		return nil, fmt.Errorf("join.config.sources supports at most %d branches (got %d)", ForkJoinMaxBranches, len(raw))
	}
	labels := slices.Sorted(maps.Keys(raw))
	sources := map[string]string{}
	seenPredecessors := map[string]bool{}
	for _, label := range labels {
		if strings.TrimSpace(label) == "" {
			return nil, fmt.Errorf("join.config.sources contains an empty branch label")
		}
		if label != strings.TrimSpace(label) {
			return nil, fmt.Errorf("join.config.sources label %q must not have leading or trailing whitespace", label)
		}
		if utf8.RuneCountInString(label) > ForkJoinMaxBranchLabelLength {
			return nil, fmt.Errorf("join.config.sources label %q must be ≤ %d chars", label, ForkJoinMaxBranchLabelLength)
		}
		value, ok := raw[label].(string)
		if !ok || strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("join.config.sources[%q] must be a non-empty predecessor node id", label)
		}
		if value != strings.TrimSpace(value) {
			return nil, fmt.Errorf("join.config.sources[%q] predecessor node id must not have leading or trailing whitespace", label)
		}
		if seenPredecessors[value] {
			return nil, fmt.Errorf("join.config.sources references predecessor %q more than once", value)
		}
		seenPredecessors[value] = true
		sources[label] = value
	}
	return sources, nil
}
