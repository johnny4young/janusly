// Package domain models the workflow document and ports the Janusly API's
// validation semantics: same issue codes, same messages, same check order,
// so a document rejected by one backend is rejected identically by the other.
// The porting source is the source contract and
// the source contract at the consistency pin.
package domain

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Node mirrors the wire shape of one workflow step. Config stays a loose map
// because each executor owns its own field contract.
type Node struct {
	ID     string         `json:"id"`
	Type   string         `json:"type"`
	Label  string         `json:"label,omitempty"`
	Config map[string]any `json:"config"`
}

// Edge mirrors the wire shape of one directed connection.
type Edge struct {
	ID        string `json:"id,omitempty"`
	From      string `json:"from"`
	To        string `json:"to"`
	Condition string `json:"condition,omitempty"`
}

// Workflow is the parsed document. Unknown top-level fields are ignored on
// parse, matching the contract schema's strip behavior.
type Workflow struct {
	DSLVersion     string            `json:"dslVersion"`
	ID             string            `json:"id,omitempty"`
	Name           string            `json:"name,omitempty"`
	Inputs         *InputSchema      `json:"inputs,omitempty"`
	Outputs        map[string]string `json:"outputs,omitempty"`
	TemplatePolicy string            `json:"templatePolicy,omitempty"`
	Recovery       *WorkflowRecovery `json:"recovery,omitempty"`
	Nodes          []Node            `json:"nodes"`
	Edges          []Edge            `json:"edges"`
}

const dslVersion = "1.0"

// rawWorkflow separates decoding from contract checking so a malformed field
// reports its path instead of failing the whole document opaquely.
type rawWorkflow struct {
	DSLVersion     *string           `json:"dslVersion"`
	ID             *string           `json:"id"`
	Name           *string           `json:"name"`
	Inputs         *InputSchema      `json:"inputs"`
	Outputs        map[string]string `json:"outputs"`
	TemplatePolicy *string           `json:"templatePolicy"`
	Recovery       *WorkflowRecovery `json:"recovery"`
	Nodes          *[]rawNode        `json:"nodes"`
	Edges          *[]rawEdge        `json:"edges"`
}

type rawNode struct {
	ID     *string        `json:"id"`
	Type   *string        `json:"type"`
	Label  *string        `json:"label"`
	Config map[string]any `json:"config"`
}

type rawEdge struct {
	ID        *string `json:"id"`
	From      *string `json:"from"`
	To        *string `json:"to"`
	Condition *string `json:"condition"`
}

// Parse decodes and contract-checks a workflow document. Contract violations
// come back as `invalid_contract` issues carrying the field path — the same
// code the contract emits when its schema parse fails — and no workflow is
// returned alongside them. Message wording differs from the contract's
// schema library; code and path consistency is the contract.
func Parse(raw []byte) (*Workflow, []Issue) {
	var doc rawWorkflow
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, []Issue{{Code: CodeInvalidContract, Message: "workflow: " + err.Error()}}
	}

	var issues []Issue
	contract := func(path, message string) {
		issues = append(issues, Issue{Code: CodeInvalidContract, Message: path + ": " + message})
	}

	wf := &Workflow{DSLVersion: dslVersion, Outputs: doc.Outputs, Inputs: doc.Inputs}
	if doc.DSLVersion != nil && strings.TrimSpace(*doc.DSLVersion) != dslVersion {
		contract("dslVersion", fmt.Sprintf("expected %q", dslVersion))
	}
	if doc.ID != nil {
		wf.ID = strings.TrimSpace(*doc.ID)
		if wf.ID == "" {
			contract("id", "expected a non-empty string")
		}
	}
	if doc.Name != nil {
		wf.Name = strings.TrimSpace(*doc.Name)
		if wf.Name == "" {
			contract("name", "expected a non-empty string")
		}
	}
	if doc.TemplatePolicy != nil {
		wf.TemplatePolicy = *doc.TemplatePolicy
		if wf.TemplatePolicy != "lenient" && wf.TemplatePolicy != "strict" {
			contract("templatePolicy", `expected "lenient" or "strict"`)
		}
	}
	if doc.Recovery != nil {
		wf.Recovery = doc.Recovery
		// The versioned contract validates at parse time — the contract
		// rejects an invalid contract in WorkflowSchema.parse, so the same
		// document fails here with path-prefixed invalid_contract issues.
		for _, problem := range ValidateRecoveryContract(doc.Recovery.Contract) {
			contract("recovery.contract", problem)
		}
		if _, _, problem := ParseCircuitBreakerThreshold(doc.Recovery.CircuitBreaker); problem != "" {
			contract("recovery", problem)
		}
	}

	if doc.Nodes == nil {
		contract("nodes", "Invalid input: expected array, received undefined")
	} else {
		// Non-nil even when empty: the workflow snapshot persisted at run
		// start must round-trip as "nodes": [] — a nil slice would marshal
		// as null and fail this same contract on re-parse.
		wf.Nodes = []Node{}
		for i, n := range *doc.Nodes {
			path := fmt.Sprintf("nodes.%d", i)
			node := Node{Config: n.Config}
			if node.Config == nil {
				node.Config = map[string]any{}
			}
			if n.ID == nil || strings.TrimSpace(*n.ID) == "" {
				contract(path+".id", "Node id is required")
			} else {
				node.ID = strings.TrimSpace(*n.ID)
			}
			if n.Type == nil || strings.TrimSpace(*n.Type) == "" {
				contract(path+".type", "Node type is required")
			} else {
				node.Type = strings.TrimSpace(*n.Type)
			}
			if n.Label != nil {
				node.Label = strings.TrimSpace(*n.Label)
				if node.Label == "" || len(node.Label) > 80 {
					contract(path+".label", "expected 1..80 characters")
				}
			}
			wf.Nodes = append(wf.Nodes, node)
		}
	}

	if doc.Edges != nil {
		wf.Edges = []Edge{}
	}
	if doc.Edges == nil {
		contract("edges", "Invalid input: expected array, received undefined")
	} else {
		for i, e := range *doc.Edges {
			path := fmt.Sprintf("edges.%d", i)
			edge := Edge{}
			if e.ID != nil {
				edge.ID = strings.TrimSpace(*e.ID)
				if edge.ID == "" {
					contract(path+".id", "expected a non-empty string")
				}
			}
			if e.From == nil || strings.TrimSpace(*e.From) == "" {
				contract(path+".from", "Edge source is required")
			} else {
				edge.From = strings.TrimSpace(*e.From)
			}
			if e.To == nil || strings.TrimSpace(*e.To) == "" {
				contract(path+".to", "Edge target is required")
			} else {
				edge.To = strings.TrimSpace(*e.To)
			}
			if e.Condition != nil {
				edge.Condition = strings.TrimSpace(*e.Condition)
				if edge.Condition == "" {
					contract(path+".condition", "expected a non-empty string")
				}
			}
			wf.Edges = append(wf.Edges, edge)
		}
	}

	if len(issues) > 0 {
		return nil, issues
	}
	return wf, nil
}
