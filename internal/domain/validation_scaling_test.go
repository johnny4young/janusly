package domain

import (
	"fmt"
	"reflect"
	"testing"
)

func TestCycleDetectionHandlesDeepGraphsIteratively(t *testing.T) {
	const nodeCount = 20_000
	nodes := make([]Node, nodeCount)
	edges := make([]Edge, 0, nodeCount)
	for index := range nodeCount {
		nodes[index] = Node{ID: fmt.Sprintf("node-%05d", index)}
		if index > 0 {
			edges = append(edges, Edge{From: nodes[index-1].ID, To: nodes[index].ID})
		}
	}
	if hasCycle(nodes, edges) {
		t.Fatal("deep acyclic graph reported a cycle")
	}
	edges = append(edges, Edge{From: nodes[len(nodes)-1].ID, To: nodes[0].ID})
	if !hasCycle(nodes, edges) {
		t.Fatal("deep cycle was not detected")
	}
}

func TestReachableNodesWithoutPreservesOriginalRootBoundary(t *testing.T) {
	wf := &Workflow{
		Nodes: []Node{{ID: "root"}, {ID: "guard"}, {ID: "side"}, {ID: "effect"}, {ID: "after"}},
		Edges: []Edge{
			{From: "root", To: "guard"},
			{From: "guard", To: "effect"},
			{From: "effect", To: "after"},
		},
	}
	reachable := reachableNodesWithout(wf, "guard")
	if reachable["effect"] || reachable["after"] {
		t.Fatalf("removing a dominator promoted its descendants to roots: %+v", reachable)
	}

	wf.Edges = append(wf.Edges,
		Edge{From: "root", To: "side"},
		Edge{From: "side", To: "effect"},
	)
	reachable = reachableNodesWithout(wf, "guard")
	if !reachable["effect"] || !reachable["after"] {
		t.Fatalf("bypass around detector was not reachable: %+v", reachable)
	}
}

func TestSemanticGuardIssuesUseStableEffectOrder(t *testing.T) {
	contract := &RecoveryContract{Version: "2"}
	contract.Failure.Semantic = RecoverySemanticFailure{
		Mode: "deterministic",
		Detectors: []RecoverySemanticDetector{{
			ID: "detector", SourceNodeID: "guard", Kind: "expression",
			PassWhen: "true", Action: "quarantine", Message: "guard",
		}},
	}
	contract.Effects = []RecoveryEffect{{NodeID: "effect-z"}, {NodeID: "effect-a"}}
	wf := &Workflow{
		Recovery: &WorkflowRecovery{Contract: contract},
		Nodes: []Node{
			{ID: "root", Type: "noop"}, {ID: "guard", Type: "noop"},
			{ID: "effect-z", Type: "noop"}, {ID: "effect-a", Type: "noop"},
		},
		Edges: []Edge{
			{From: "root", To: "guard"},
			{From: "root", To: "effect-z"},
			{From: "root", To: "effect-a"},
		},
	}
	var issues []Issue
	validateSemanticContractDAG(wf, PermissiveExpressions, nil, func(issue Issue) {
		if issue.Code == "semantic_detector_does_not_guard_effect" {
			issues = append(issues, issue)
		}
	})
	got := make([]string, 0, len(issues))
	for _, issue := range issues {
		got = append(got, issue.NodeID)
	}
	if want := []string{"effect-a", "effect-z"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("effect issue order=%v, want %v", got, want)
	}
}
