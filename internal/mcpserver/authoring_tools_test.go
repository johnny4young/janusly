package mcpserver

import (
	"maps"
	"slices"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

// Trigger node types are documented by catalog.describe section=triggers.
var triggerNodeTypes = []string{"email_received", "file_dropped", "mcp_server_event", "pagerduty_incident", "webhook_received"}

func TestNodeGuideCoversEveryExecutableStepType(t *testing.T) {
	documented := map[string]bool{}
	for _, guide := range nodeGuides {
		if documented[guide.Type] {
			t.Fatalf("duplicate guide for %s", guide.Type)
		}
		documented[guide.Type] = true
	}
	for _, nodeType := range triggerNodeTypes {
		documented[nodeType] = true
	}
	for _, nodeType := range slices.Sorted(maps.Keys(domain.ExecutableNodeTypes)) {
		if !documented[nodeType] {
			t.Errorf("executable type %s has no catalog.describe guide", nodeType)
		}
	}
	for nodeType := range documented {
		if !domain.ExecutableNodeTypes[nodeType] {
			t.Errorf("guide documents %s, which this backend cannot execute", nodeType)
		}
	}
}

func TestNodeGuideExamplesPassValidation(t *testing.T) {
	for _, guide := range nodeGuides {
		t.Run(guide.Type, func(t *testing.T) {
			step := domain.Node{ID: "step", Type: guide.Type, Config: guide.Example}
			wf := &domain.Workflow{ID: "guide", Name: "Guide", DSLVersion: "1.0", Nodes: []domain.Node{step}, Edges: []domain.Edge{}}
			if !guide.standalone {
				// Neighbours named in the routing and fork/join examples.
				wf.Nodes = append(wf.Nodes,
					domain.Node{ID: "next", Type: "noop", Config: map[string]any{}},
					domain.Node{ID: "other", Type: "noop", Config: map[string]any{}})
				if guide.Type == "join" {
					wf.Edges = []domain.Edge{{From: "next", To: "step"}, {From: "other", To: "step"}}
				} else {
					wf.Edges = []domain.Edge{{From: "step", To: "next"}, {From: "step", To: "other"}}
				}
			}
			if result := workflowvalidation.Validate(wf); !result.Valid {
				t.Fatalf("example for %s is invalid: %+v", guide.Type, result.Issues)
			}
		})
	}
}
