// Package workflowvalidation composes the pure domain graph grammar with the
// executable tool registry and semantic fixture evaluator. Product surfaces
// must use this package so save, start, MCP, recovery and AI authoring cannot
// drift on which tool configurations are actually executable.
package workflowvalidation

import (
	"fmt"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/recovery"
)

// Validate applies the strict saved-workflow posture, including required
// inputs declared by registered tools.
func Validate(workflow *domain.Workflow) domain.ValidationResult {
	return validate(workflow, false)
}

// ValidateDraft keeps exact tool-name validation but allows a proposal to
// expose missing bindings/inputs for the operator to complete before Apply.
func ValidateDraft(workflow *domain.Workflow) domain.ValidationResult {
	return validate(workflow, true)
}

// A saved workflow has a size. The request body is capped at 2 MiB, but a DAG
// of minimal nodes fits ~30k of them in that budget, and every node becomes a
// run_nodes row at start. Snippets already cap at 20/40; these are the
// whole-workflow bounds.
const (
	MaxWorkflowNodes = 500
	MaxWorkflowEdges = 1000
)

func validate(workflow *domain.Workflow, allowIncompleteToolInputs bool) domain.ValidationResult {
	if len(workflow.Nodes) > MaxWorkflowNodes || len(workflow.Edges) > MaxWorkflowEdges {
		return domain.ValidationResult{Valid: false, Issues: []domain.Issue{{
			Code: "workflow_too_large",
			Message: fmt.Sprintf("Workflow has %d nodes and %d edges; the limit is %d nodes and %d edges.",
				len(workflow.Nodes), len(workflow.Edges), MaxWorkflowNodes, MaxWorkflowEdges),
		}}}
	}
	registry := executors.SharedToolRegistry()
	return domain.ValidateWithOptions(
		workflow,
		grammar.DomainValidator,
		recovery.FixtureOutcomesForValidation,
		domain.ValidationOptions{
			AllowIncompleteToolInputs: allowIncompleteToolInputs,
			ToolValidator: func(name string, input map[string]any, strictInput bool) error {
				if strictInput {
					return registry.ValidateInput(name, input)
				}
				return registry.ValidatePartialInput(name, input)
			},
		},
	)
}
