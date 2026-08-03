package domain

import (
	"slices"
	"testing"
)

func routerWorkflow(nodeType string, candidates any, edges []Edge) *Workflow {
	return &Workflow{
		ID: "router-workflow",
		Nodes: []Node{
			{ID: "route", Type: nodeType, Config: map[string]any{"candidates": candidates}},
			{ID: "fast", Type: "noop", Config: map[string]any{}},
			{ID: "safe", Type: "noop", Config: map[string]any{}},
		},
		Edges: edges,
	}
}

func validationCodes(result ValidationResult) []string {
	codes := make([]string, 0, len(result.Issues))
	for _, issue := range result.Issues {
		codes = append(codes, issue.Code)
	}
	return codes
}

func TestRouterValidationAcceptsCanonicalAndLegacyDirectSuccessors(t *testing.T) {
	for _, nodeType := range []string{"router", "router_llm"} {
		t.Run(nodeType, func(t *testing.T) {
			wf := routerWorkflow(nodeType, []any{
				map[string]any{"nodeId": "fast"},
				map[string]any{"id": " safe "},
			}, []Edge{{From: "route", To: "fast"}, {From: "route", To: "safe"}})
			result := Validate(wf, nil)
			if !result.Valid {
				t.Fatalf("valid router rejected: %+v", result.Issues)
			}
		})
	}
}

func TestRouterValidationRejectsMalformedAndUnroutableCandidates(t *testing.T) {
	tests := []struct {
		name       string
		candidates any
		edges      []Edge
		wantCodes  []string
	}{
		{name: "missing", candidates: nil, wantCodes: []string{CodeRouterMissingCandidates}},
		{name: "empty", candidates: []any{}, wantCodes: []string{CodeRouterMissingCandidates}},
		{name: "not array", candidates: "fast", wantCodes: []string{CodeRouterMissingCandidates}},
		{
			name: "invalid object", candidates: []any{42, map[string]any{"nodeId": "fast"}},
			edges: []Edge{{From: "route", To: "fast"}}, wantCodes: []string{CodeRouterInvalidCandidate},
		},
		{
			name: "missing id", candidates: []any{map[string]any{"nodeId": " ", "id": ""}},
			wantCodes: []string{CodeRouterCandidateMissingID},
		},
		{
			name: "unknown", candidates: []any{map[string]any{"nodeId": "ghost"}},
			wantCodes: []string{CodeRouterCandidateUnknown, CodeRouterCandidateUnknownID},
		},
		{
			name: "not successor", candidates: []any{map[string]any{"nodeId": "fast"}},
			wantCodes: []string{CodeRouterCandidateNotSuccessor},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := Validate(routerWorkflow("router", tt.candidates, tt.edges), nil)
			got := validationCodes(result)
			for _, want := range tt.wantCodes {
				if !slices.Contains(got, want) {
					t.Fatalf("codes = %v, want %q in issues %+v", got, want, result.Issues)
				}
			}
		})
	}
}
