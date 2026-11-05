// Rerun from a step: a new production run over the source run's snapshot. Node
// seeding follows the Replay Lab fork (earlier outputs cloned, one node queued),
// but admission goes through runstart and StartRun, so every start gate and the
// ordinary executor gates apply and writes are real.
package engine

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
)

// RerunLinkKind marks trace-only lineage: a rerun never joins its source run.
const RerunLinkKind = "rerun"

// NodeSeed is a node row's starting state in a rerun.
type NodeSeed struct {
	Status string
	State  json.RawMessage
}

// RerunSeed tells StartRun to queue only NodeID and start Nodes as given.
type RerunSeed struct {
	SourceRunID, NodeID string
	Nodes               map[string]NodeSeed
}

// RerunEffect names one step that can change external state when it runs.
type RerunEffect struct {
	NodeID string `json:"nodeId"`
	Type   string `json:"type"`
}

// RerunPlan is what a rerun would do. Slices follow workflow order.
type RerunPlan struct {
	Reused      []string      `json:"reused"`
	Rerun       []string      `json:"rerun"`
	NotRun      []string      `json:"notRun"`
	SideEffects []RerunEffect `json:"sideEffects"`
	Seed        *RerunSeed    `json:"-"`
}

// RerunRejection is an expected refusal; the API maps it to a 4xx with Code.
type RerunRejection struct {
	Code, Message string
	NodeID        string
}

// RunSnapshot parses the workflow and input a run actually executed, including
// a fix a redrive swapped in, rather than its saved version.
func RunSnapshot(inputJSON []byte) (*domain.Workflow, map[string]any, error) {
	return workflowFromRunInput(inputJSON)
}

// rerunHasEffect fails safe: a subworkflow is opaque here and an unknown tool
// name, possibly templated, is not proven read-only.
func rerunHasEffect(node domain.Node) bool {
	if node.Type == "subworkflow" {
		return true
	}
	registry := executors.SharedToolRegistry()
	return domain.IsSensitiveActionNodeWithOptions(node, domain.ReadinessOptions{
		IsWriteSideTool: func(name string, _ map[string]any) bool {
			return !registry.Has(name) || registry.IsWriteSide(name)
		},
	})
}

// PlanRerun decides each node's role. Only the selected step and its downstream
// closure can execute: everything else is cloned or skipped, so an earlier write
// has no queued row through which to run again.
func PlanRerun(sourceRunID string, wf *domain.Workflow, rows []store.ListRunNodesByRunForOrgRow, nodeID string) (RerunPlan, *RerunRejection) {
	source := make(map[string]store.ListRunNodesByRunForOrgRow, len(rows))
	for _, row := range rows {
		source[row.NodeID] = row
	}
	if !slices.ContainsFunc(wf.Nodes, func(node domain.Node) bool { return node.ID == nodeID }) {
		return RerunPlan{}, &RerunRejection{Code: "fork_node_not_found", Message: "Step is not part of this run", NodeID: nodeID}
	}
	if source[nodeID].Status == "skipped" {
		return RerunPlan{}, &RerunRejection{Code: "predecessor_not_succeeded", Message: "This step did not run in the source run", NodeID: nodeID}
	}
	ancestors := collectRelatives(wf, nodeID, true)
	downstream := collectRelatives(wf, nodeID, false)
	plan := RerunPlan{
		Reused: []string{}, Rerun: []string{}, NotRun: []string{}, SideEffects: []RerunEffect{},
		Seed: &RerunSeed{SourceRunID: sourceRunID, NodeID: nodeID, Nodes: make(map[string]NodeSeed, len(wf.Nodes))},
	}
	approval := ""
	for _, node := range wf.Nodes {
		row := source[node.ID]
		switch {
		case node.ID == nodeID || downstream[node.ID]:
			plan.Rerun = append(plan.Rerun, node.ID)
			if rerunHasEffect(node) {
				plan.SideEffects = append(plan.SideEffects, RerunEffect{NodeID: node.ID, Type: node.Type})
			}
			continue
		case row.Status == "succeeded" || (row.Status == "skipped" && ancestors[node.ID]):
			if row.Status == "succeeded" && !hasSavedOutput(row.StateJson) {
				return RerunPlan{}, &RerunRejection{Code: "predecessor_not_succeeded", Message: "A saved output cannot be reused", NodeID: node.ID}
			}
			plan.Seed.Nodes[node.ID] = NodeSeed{Status: row.Status, State: row.StateJson}
			plan.Reused = append(plan.Reused, node.ID)
			if ancestors[node.ID] && node.Type == "approval" {
				approval = node.ID
			}
			continue
		case ancestors[node.ID]:
			return RerunPlan{}, &RerunRejection{Code: "predecessor_not_succeeded", Message: "An earlier step did not succeed in the source run", NodeID: node.ID}
		}
		state, _ := json.Marshal(map[string]any{"skipped": map[string]any{"reason": "outside_rerun", "rerunNodeId": nodeID}})
		plan.Seed.Nodes[node.ID] = NodeSeed{Status: "skipped", State: state}
		plan.NotRun = append(plan.NotRun, node.ID)
	}
	// An approval covers one execution: dispatch reads approval from the graph,
	// so a cloned one would otherwise authorize these writes a second time.
	if approval != "" && len(plan.SideEffects) > 0 {
		return RerunPlan{}, &RerunRejection{Code: "rerun_needs_approval", Message: "Rerun from the approval step so it is approved again", NodeID: approval}
	}
	return plan, nil
}

// hasSavedOutput refuses a state whose output the size bound truncated away.
func hasSavedOutput(state json.RawMessage) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(state, &fields) != nil {
		return false
	}
	_, present := fields["output"]
	return present
}

// ApplyRerunOverride returns a copy of wf whose step config is the override,
// parsed as any submitted document is, or wf itself when nothing changed, so an
// unedited rerun stays on its version. It cannot opt an agent into writes.
func ApplyRerunOverride(wf *domain.Workflow, nodeID string, override map[string]any) (*domain.Workflow, *RerunRejection) {
	index := slices.IndexFunc(wf.Nodes, func(node domain.Node) bool { return node.ID == nodeID })
	if index < 0 {
		return nil, &RerunRejection{Code: "fork_node_not_found", Message: "Step is not part of this run", NodeID: nodeID}
	}
	original := wf.Nodes[index].Config
	merged, key := mergeRerunOverride(override, original)
	if key != "" {
		return nil, &RerunRejection{Code: "rerun_raw_secret", Message: "Credential fields only accept a secret reference", NodeID: nodeID}
	}
	config, _ := merged.(map[string]any)
	if reflect.DeepEqual(config, original) || (len(config) == 0 && len(original) == 0) {
		return wf, nil
	}
	wants, _ := config["allowWriteTools"].(bool)
	had, _ := original["allowWriteTools"].(bool)
	if wants && !had {
		return nil, &RerunRejection{Code: "invalid_input", Message: "An override cannot enable allowWriteTools", NodeID: nodeID}
	}
	patched := *wf
	patched.Nodes = slices.Clone(wf.Nodes)
	patched.Nodes[index].Config = config
	raw, err := json.Marshal(&patched)
	if err != nil {
		return nil, &RerunRejection{Code: "invalid_input", Message: "inputOverride cannot be encoded", NodeID: nodeID}
	}
	parsed, _ := domain.Parse(raw)
	if parsed == nil {
		return nil, &RerunRejection{Code: "invalid_input", Message: "inputOverride is not a valid step config", NodeID: nodeID}
	}
	return parsed, nil
}

// mergeRerunOverride restores masked values from the original config and names
// a sensitive key that carries a literal, which would otherwise be persisted.
func mergeRerunOverride(override, original any) (any, string) {
	switch value := override.(type) {
	case map[string]any:
		source, _ := original.(map[string]any)
		out := make(map[string]any, len(value))
		for key, item := range value {
			if grammar.IsSensitiveKey(key) {
				prior, present := source[key]
				text, isText := item.(string)
				switch {
				case isText && text == grammar.RedactedPlaceholder && present:
					out[key] = prior
				case item == nil || (isText && (strings.TrimSpace(text) == "" || domain.IsSecretReference(text))):
					out[key] = item
				default:
					return nil, key
				}
				continue
			}
			merged, bad := mergeRerunOverride(item, source[key])
			if bad != "" {
				return nil, bad
			}
			out[key] = merged
		}
		return out, ""
	case []any:
		source, _ := original.([]any)
		out := make([]any, len(value))
		for index, item := range value {
			var prior any
			if index < len(source) {
				prior = source[index]
			}
			merged, bad := mergeRerunOverride(item, prior)
			if bad != "" {
				return nil, bad
			}
			out[index] = merged
		}
		return out, ""
	default:
		return override, ""
	}
}
