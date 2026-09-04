// Package domain models the workflow document and ports the Janusly API's
// validation semantics: same issue codes, same messages, same check order,
// so a document rejected by one backend is rejected identically by the other.
// The porting source is the source contract and
// the source contract at the consistency pin.
package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
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
	// OnError routes this edge only when the source node fails terminally
	// (retries exhausted). A failure with at least one on-error edge is
	// HANDLED: the run keeps going down the error branch instead of dying.
	OnError bool `json:"onError,omitempty"`
}

// WorkflowJSONMetadata is the small descriptive block persisted inside the
// versioned DAG. Operational ownership/runbook metadata lives in its own
// table and must never be smuggled into this document as arbitrary keys.
type WorkflowJSONMetadata struct {
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags"`
}

// WorkflowPosition is editor-only state. The runtime ignores it, but save and
// load preserve finite coordinates for nodes that exist in the same DAG.
type WorkflowPosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type WorkflowUI struct {
	Positions map[string]WorkflowPosition `json:"positions,omitempty"`
}

// Workflow is the parsed document. Unknown top-level fields are ignored on
// parse, matching the contract schema's strip behavior.
type Workflow struct {
	DSLVersion     string                `json:"dslVersion"`
	ID             string                `json:"id,omitempty"`
	Name           string                `json:"name,omitempty"`
	Metadata       *WorkflowJSONMetadata `json:"metadata,omitempty"`
	Inputs         *InputSchema          `json:"inputs,omitempty"`
	Outputs        map[string]string     `json:"outputs,omitempty"`
	TemplatePolicy string                `json:"templatePolicy,omitempty"`
	Recovery       *WorkflowRecovery     `json:"recovery,omitempty"`
	UI             *WorkflowUI           `json:"ui,omitempty"`
	Nodes          []Node                `json:"nodes"`
	Edges          []Edge                `json:"edges"`
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
	OnError   *bool   `json:"onError"`
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
	var document map[string]json.RawMessage
	if err := json.Unmarshal(raw, &document); err != nil || document == nil {
		return nil, []Issue{{Code: CodeInvalidContract, Message: "workflow: expected an object"}}
	}

	var issues []Issue
	contract := func(path, message string) {
		issues = append(issues, Issue{Code: CodeInvalidContract, Message: path + ": " + message})
	}

	wf := &Workflow{
		DSLVersion: dslVersion,
		Metadata:   &WorkflowJSONMetadata{Tags: []string{}},
		Outputs:    doc.Outputs,
		Inputs:     doc.Inputs,
	}
	for _, field := range []string{"dslVersion", "id", "name", "metadata", "inputs", "outputs", "templatePolicy", "recovery", "ui"} {
		if value, present := document[field]; present && isJSONNull(value) {
			contract(field, "expected a non-null value")
		}
	}
	if encoded, present := document["metadata"]; present && !isJSONNull(encoded) {
		metadata, problems := parseWorkflowJSONMetadata(encoded)
		if len(problems) == 0 {
			wf.Metadata = metadata
		} else {
			for _, problem := range problems {
				contract("metadata"+problem.path, problem.message)
			}
		}
	}
	if doc.Inputs != nil && (!validInputSchemaWire(document["inputs"]) || !validInputSchemaShape(doc.Inputs)) {
		contract("inputs", fmt.Sprintf("expected a supported recursive schema with at most %d nodes", InputSchemaNodeMax))
	}
	if doc.Outputs != nil && !validWorkflowOutputsWire(document["outputs"]) {
		contract("outputs", "expected an object of string templates")
	}
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
		for _, problem := range validateWorkflowRecoveryWire(document["recovery"]) {
			contract("recovery"+problem.path, problem.message)
		}
		normalizeRecoveryContract(doc.Recovery.Contract)
		// The versioned contract validates at parse time — the contract
		// rejects an invalid contract in WorkflowSchema.parse, so the same
		// document fails here with path-prefixed invalid_contract issues.
		for _, problem := range ValidateRecoveryContract(doc.Recovery.Contract) {
			contract("recovery.contract", problem)
		}
		if !isJSONNull(doc.Recovery.CircuitBreaker) {
			if _, _, problem := ParseCircuitBreakerThreshold(doc.Recovery.CircuitBreaker); problem != "" {
				contract("recovery", problem)
			}
		}
	}

	if doc.Nodes == nil {
		contract("nodes", "Invalid input: expected array, received undefined")
	} else {
		// The raw pass only tells an explicit null from an absent field. A
		// document without the token cannot carry one, so the stored
		// snapshot re-parsed on every claim decodes its nodes once.
		var rawNodes []map[string]json.RawMessage
		if bytes.Contains(document["nodes"], []byte("null")) {
			_ = json.Unmarshal(document["nodes"], &rawNodes)
		}
		// Non-nil even when empty: the workflow snapshot persisted at run
		// start must round-trip as "nodes": [] — a nil slice would marshal
		// as null and fail this same contract on re-parse.
		wf.Nodes = []Node{}
		for i, n := range *doc.Nodes {
			path := "nodes." + strconv.Itoa(i)
			if i < len(rawNodes) && rawNodes[i] != nil {
				for _, field := range []string{"label", "config"} {
					if value, present := rawNodes[i][field]; present && isJSONNull(value) {
						contract(path+"."+field, "expected a non-null value")
					}
				}
			}
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
		var rawEdges []map[string]json.RawMessage
		if bytes.Contains(document["edges"], []byte("null")) {
			_ = json.Unmarshal(document["edges"], &rawEdges)
		}
		for i, e := range *doc.Edges {
			path := "edges." + strconv.Itoa(i)
			if i < len(rawEdges) && rawEdges[i] != nil {
				for _, field := range []string{"id", "condition", "onError"} {
					if value, present := rawEdges[i][field]; present && isJSONNull(value) {
						contract(path+"."+field, "expected a non-null value")
					}
				}
			}
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
			if e.OnError != nil {
				edge.OnError = *e.OnError
			}
			wf.Edges = append(wf.Edges, edge)
		}
	}

	if encoded, present := document["ui"]; present && !isJSONNull(encoded) {
		nodeIDs := make(map[string]struct{}, len(wf.Nodes))
		for _, node := range wf.Nodes {
			nodeIDs[node.ID] = struct{}{}
		}
		ui, problems := parseWorkflowUI(encoded, nodeIDs)
		if len(problems) == 0 {
			wf.UI = ui
		} else {
			for _, problem := range problems {
				contract("ui"+problem.path, problem.message)
			}
		}
	}

	if len(issues) > 0 {
		return nil, issues
	}
	return wf, nil
}

type workflowFieldProblem struct {
	path    string
	message string
}

func parseWorkflowJSONMetadata(raw json.RawMessage) (*WorkflowJSONMetadata, []workflowFieldProblem) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, []workflowFieldProblem{{message: "expected an object"}}
	}
	metadata := &WorkflowJSONMetadata{Tags: []string{}}
	var problems []workflowFieldProblem
	if value, present := object["description"]; present {
		if isJSONNull(value) || json.Unmarshal(value, &metadata.Description) != nil {
			problems = append(problems, workflowFieldProblem{path: ".description", message: "expected a string"})
		} else {
			metadata.Description = strings.TrimSpace(metadata.Description)
		}
	}
	if value, present := object["tags"]; present {
		if isJSONNull(value) || json.Unmarshal(value, &metadata.Tags) != nil || metadata.Tags == nil {
			problems = append(problems, workflowFieldProblem{path: ".tags", message: "expected an array of strings"})
		} else {
			for index := range metadata.Tags {
				metadata.Tags[index] = strings.TrimSpace(metadata.Tags[index])
				if metadata.Tags[index] == "" {
					problems = append(problems, workflowFieldProblem{
						path: fmt.Sprintf(".tags.%d", index), message: "expected a non-empty string",
					})
				}
			}
		}
	}
	return metadata, problems
}

func validWorkflowOutputsWire(raw json.RawMessage) bool {
	var outputs map[string]json.RawMessage
	if len(raw) == 0 || isJSONNull(raw) || json.Unmarshal(raw, &outputs) != nil || outputs == nil {
		return false
	}
	for _, encoded := range outputs {
		var template string
		if isJSONNull(encoded) || json.Unmarshal(encoded, &template) != nil {
			return false
		}
	}
	return true
}

func parseWorkflowUI(raw json.RawMessage, nodeIDs map[string]struct{}) (*WorkflowUI, []workflowFieldProblem) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, []workflowFieldProblem{{message: "expected an object"}}
	}
	ui := &WorkflowUI{}
	encoded, present := object["positions"]
	if !present {
		return ui, nil
	}
	var positions map[string]map[string]json.RawMessage
	if isJSONNull(encoded) || json.Unmarshal(encoded, &positions) != nil || positions == nil {
		return nil, []workflowFieldProblem{{path: ".positions", message: "expected an object"}}
	}
	ui.Positions = make(map[string]WorkflowPosition, len(positions))
	var problems []workflowFieldProblem
	positionIDs := make([]string, 0, len(positions))
	for rawID := range positions {
		positionIDs = append(positionIDs, rawID)
	}
	sort.Strings(positionIDs)
	for _, rawID := range positionIDs {
		rawPosition := positions[rawID]
		id := strings.TrimSpace(rawID)
		path := ".positions." + rawID
		if id == "" {
			problems = append(problems, workflowFieldProblem{path: path, message: "expected a non-empty node id"})
			continue
		}
		if _, duplicate := ui.Positions[id]; duplicate {
			problems = append(problems, workflowFieldProblem{path: path, message: "duplicate node id after trimming"})
			continue
		}
		if _, exists := nodeIDs[id]; !exists {
			problems = append(problems, workflowFieldProblem{path: path, message: "position must reference an existing node"})
			continue
		}
		if rawPosition == nil {
			problems = append(problems, workflowFieldProblem{path: path, message: "expected an object"})
			continue
		}
		position := WorkflowPosition{}
		valid := true
		for _, axis := range []struct {
			name  string
			value *float64
		}{{"x", &position.X}, {"y", &position.Y}} {
			value, exists := rawPosition[axis.name]
			if !exists || isJSONNull(value) || json.Unmarshal(value, axis.value) != nil ||
				math.IsNaN(*axis.value) || math.IsInf(*axis.value, 0) {
				problems = append(problems, workflowFieldProblem{
					path: path + "." + axis.name, message: "expected a finite number",
				})
				valid = false
			}
		}
		if valid {
			ui.Positions[id] = position
		}
	}
	return ui, problems
}

// CanonicalWorkflowDocument serializes only the public workflow contract. It
// deliberately strips save-only carriers and unknown fields, applies parser
// defaults, and writes generated id/name values supplied by the caller.
func CanonicalWorkflowDocument(wf *Workflow) ([]byte, error) {
	if wf == nil {
		return nil, fmt.Errorf("workflow is nil")
	}
	metadata := wf.Metadata
	if metadata == nil {
		metadata = &WorkflowJSONMetadata{Tags: []string{}}
	}
	if metadata.Tags == nil {
		metadata = &WorkflowJSONMetadata{Description: metadata.Description, Tags: []string{}}
	}
	document := map[string]any{
		"dslVersion": wf.DSLVersion,
		"metadata":   metadata,
		"nodes":      wf.Nodes,
		"edges":      wf.Edges,
	}
	if wf.ID != "" {
		document["id"] = wf.ID
	}
	if wf.Name != "" {
		document["name"] = wf.Name
	}
	if wf.Inputs != nil {
		document["inputs"] = wf.Inputs
	}
	if wf.Outputs != nil {
		document["outputs"] = wf.Outputs
	}
	if wf.TemplatePolicy != "" {
		document["templatePolicy"] = wf.TemplatePolicy
	}
	if wf.Recovery != nil {
		document["recovery"] = wf.Recovery
	}
	if wf.UI != nil {
		document["ui"] = wf.UI
	}
	return json.Marshal(document)
}
