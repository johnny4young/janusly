package authoring

import (
	"encoding/json"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
)

func TestDeterministicWorkflowReturnsIndependentDeepCopies(t *testing.T) {
	first := DeterministicWorkflow("send an email")
	second := DeterministicWorkflow("send an email")
	first["name"] = "mutated"
	nodes := first["nodes"].([]any)
	nodes[0].(map[string]any)["id"] = "mutated-node"

	if second["name"] == "mutated" {
		t.Fatal("top-level template state leaked between requests")
	}
	secondNodes := second["nodes"].([]any)
	if secondNodes[0].(map[string]any)["id"] == "mutated-node" {
		t.Fatal("nested template state leaked between requests")
	}
	third := DeterministicWorkflow("send an email")
	if third["name"] == "mutated" || third["nodes"].([]any)[0].(map[string]any)["id"] == "mutated-node" {
		t.Fatal("process-global fallback catalog was mutated")
	}
}

func TestDeterministicWorkflowEmitsCompleteSafePrimitives(t *testing.T) {
	catalog := NewBuilder(nil, nil).Build(t.Context(), "")
	for _, testCase := range []struct {
		prompt, id, nodeType string
	}{
		{"Every day at 09:00 run a scheduled summary", "scheduled-operation", "schedule"},
		{"Wait five minutes before continuing", "bounded-wait", "wait_until"},
		{"Use a team of agents to review the evidence", "multi-agent-review", "multi_agent"},
		{"Use router_llm between a fast and safe path", "bounded-router", "router_llm"},
	} {
		t.Run(testCase.id, func(t *testing.T) {
			document := DeterministicWorkflow(testCase.prompt)
			if document["id"] != testCase.id {
				t.Fatalf("selected template = %v want %s", document["id"], testCase.id)
			}
			raw, err := json.Marshal(document)
			if err != nil {
				t.Fatal(err)
			}
			workflow, issues := domain.Parse(raw)
			if workflow == nil || len(issues) > 0 {
				t.Fatalf("parse: %+v", issues)
			}
			found := false
			for _, node := range workflow.Nodes {
				found = found || node.Type == testCase.nodeType
			}
			if !found {
				t.Fatalf("template omitted %s: %+v", testCase.nodeType, workflow.Nodes)
			}
			if bindings := BindWorkflow(catalog, workflow); !bindings.Complete {
				t.Fatalf("safe primitive must be completely configured: %+v", bindings)
			}
		})
	}
}
