package engine

import (
	"maps"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

func TestSandboxSeedPlanQueuesOnlyNodesWhosePredecessorsWereSeeded(t *testing.T) {
	wf := &domain.Workflow{
		Nodes: []domain.Node{
			{ID: "trigger-a"}, {ID: "trigger-b"}, {ID: "first"},
			{ID: "join"}, {ID: "mixed"}, {ID: "last"},
		},
		Edges: []domain.Edge{
			{From: "trigger-a", To: "first"},
			{From: "trigger-a", To: "join"}, {From: "trigger-b", To: "join"},
			{From: "trigger-b", To: "mixed"}, {From: "first", To: "mixed"},
			{From: "mixed", To: "last"},
		},
	}

	roots, ready := sandboxSeedPlan(wf)
	if !maps.Equal(roots, map[string]bool{"trigger-a": true, "trigger-b": true}) {
		t.Fatalf("roots: %+v", roots)
	}
	if !maps.Equal(ready, map[string]bool{"first": true, "join": true}) {
		t.Fatalf("ready: %+v", ready)
	}
}
