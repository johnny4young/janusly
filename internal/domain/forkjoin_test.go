package domain

import (
	"strings"
	"testing"
)

func TestResolveParallelForkBranchesAcceptsUnicodeCharacterBounds(t *testing.T) {
	label := strings.Repeat("ñ", ForkJoinMaxBranchLabelLength)
	description := strings.Repeat("界", ForkJoinMaxBranchDescLength)
	branches, err := ResolveParallelForkBranches(map[string]any{
		"branches": []any{
			map[string]any{"label": label, "description": description},
			map[string]any{"label": "fallback"},
		},
	})
	if err != nil {
		t.Fatalf("unicode values within the documented character bounds were rejected: %v", err)
	}
	if got := branches[0]["label"]; got != label {
		t.Fatalf("label changed during resolution: %q", got)
	}
}

func TestResolveParallelForkBranchesRejectsAmbiguousLabels(t *testing.T) {
	tests := []struct {
		name     string
		branches []any
	}{
		{
			name: "leading whitespace",
			branches: []any{
				map[string]any{"label": " branch"}, map[string]any{"label": "other"},
			},
		},
		{
			name: "trailing whitespace",
			branches: []any{
				map[string]any{"label": "branch "}, map[string]any{"label": "other"},
			},
		},
		{
			name: "too many unicode characters",
			branches: []any{
				map[string]any{"label": strings.Repeat("ñ", ForkJoinMaxBranchLabelLength+1)},
				map[string]any{"label": "other"},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ResolveParallelForkBranches(map[string]any{"branches": test.branches}); err == nil {
				t.Fatal("ambiguous branch label was accepted")
			}
		})
	}
}

func TestResolveJoinSourcesRejectsAmbiguousIdentifiers(t *testing.T) {
	tests := []struct {
		name    string
		sources map[string]any
	}{
		{name: "leading label whitespace", sources: map[string]any{" a": "node_a", "b": "node_b"}},
		{name: "trailing label whitespace", sources: map[string]any{"a ": "node_a", "b": "node_b"}},
		{name: "leading node whitespace", sources: map[string]any{"a": " node_a", "b": "node_b"}},
		{name: "trailing node whitespace", sources: map[string]any{"a": "node_a ", "b": "node_b"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ResolveJoinSources(map[string]any{"sources": test.sources}); err == nil {
				t.Fatal("ambiguous join identifier was accepted")
			}
		})
	}
}
