// Rerun from a step: a new production run over the source run's snapshot. Node
// seeding follows the Replay Lab fork (earlier outputs cloned, one node queued),
// but admission goes through runstart and StartRun, so every start gate and the
// ordinary executor gates apply and writes are real.
package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
)

// RerunLinkKind marks trace-only lineage: a rerun never joins its source run.
const RerunLinkKind = "rerun"

// rerunSkipReason marks a step a rerun skipped, unlike a branch not taken.
var rerunSkipReason = []byte("outside_rerun")

// ErrRerunSourceOpen reports a source that was revived or moved after planning.
var ErrRerunSourceOpen = errors.New("the source run changed or has not finished")

func rerunRowMoved(seed *RerunSeed, row store.GetRunNodeRow) bool {
	if row.Attempts != seed.PlannedAttempts || (row.FinishedAt == nil) != (seed.PlannedFinishedAt == nil) {
		return true
	}
	return row.FinishedAt != nil && !row.FinishedAt.Equal(*seed.PlannedFinishedAt)
}

// NodeSeed is a node row's starting state in a rerun.
type NodeSeed struct {
	Status string
	State  json.RawMessage
}

// RerunSeed tells StartRun to queue only NodeID and start Nodes as given.
type RerunSeed struct {
	SourceRunID, NodeID string
	Nodes               map[string]NodeSeed
	// The selected row as planned: StartRun refuses if it moved since.
	PlannedAttempts   pgtype.Int4
	PlannedFinishedAt *time.Time
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
	// Reused subworkflows upstream of a side effect: RerunChildDecision reads
	// their child runs for a human decision.
	ReusedSubworkflows []string `json:"-"`
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
// has no queued row through which to run again. Readiness accepts a skipped
// predecessor, so nothing a closure node depends on may be skipped in its place.
func PlanRerun(sourceRunID string, wf *domain.Workflow, rows []store.ListRunNodesByRunForOrgRow, nodeID string) (RerunPlan, *RerunRejection) {
	source := make(map[string]store.ListRunNodesByRunForOrgRow, len(rows))
	for _, row := range rows {
		source[row.NodeID] = row
		if row.Status == "running" || waitsOnChildRun(row.StateJson) {
			return RerunPlan{}, &RerunRejection{Code: "rerun_source_open", Message: "A step of the source run is still executing", NodeID: row.NodeID}
		}
	}
	if !slices.ContainsFunc(wf.Nodes, func(node domain.Node) bool { return node.ID == nodeID }) {
		return RerunPlan{}, &RerunRejection{Code: "fork_node_not_found", Message: "Step is not part of this run", NodeID: nodeID}
	}
	switch source[nodeID].Status {
	case "succeeded", "failed", "cancelled":
	default:
		return RerunPlan{}, &RerunRejection{Code: "predecessor_not_succeeded", Message: "This step did not finish in the source run", NodeID: nodeID}
	}
	closure := collectRelatives(wf, nodeID, false)
	closure[nodeID] = true
	needed := map[string]bool{}
	for member := range closure {
		maps.Copy(needed, collectRelatives(wf, member, true))
	}
	plan := RerunPlan{
		Reused: []string{}, Rerun: []string{}, NotRun: []string{}, SideEffects: []RerunEffect{},
		Seed: &RerunSeed{
			SourceRunID: sourceRunID, NodeID: nodeID, Nodes: make(map[string]NodeSeed, len(wf.Nodes)),
			PlannedAttempts: source[nodeID].Attempts, PlannedFinishedAt: source[nodeID].FinishedAt,
		},
	}
	for _, node := range wf.Nodes {
		row := source[node.ID]
		switch {
		case closure[node.ID]:
			plan.Rerun = append(plan.Rerun, node.ID)
			if rerunHasEffect(node) {
				plan.SideEffects = append(plan.SideEffects, RerunEffect{NodeID: node.ID, Type: node.Type})
			}
		case row.Status == "succeeded" && hasSavedOutput(row.StateJson):
			plan.Seed.Nodes[node.ID] = NodeSeed{Status: row.Status, State: row.StateJson}
			plan.Reused = append(plan.Reused, node.ID)
		case needed[node.ID] && (row.Status != "skipped" || bytes.Contains(row.StateJson, rerunSkipReason)):
			return RerunPlan{}, &RerunRejection{Code: "predecessor_not_succeeded", Message: "A step this rerun depends on did not succeed in the source run", NodeID: node.ID}
		case needed[node.ID]:
			// A branch the source run did not take stays not taken.
			plan.Seed.Nodes[node.ID] = NodeSeed{Status: row.Status, State: row.StateJson}
			plan.NotRun = append(plan.NotRun, node.ID)
		default:
			state, _ := json.Marshal(map[string]any{"skipped": map[string]any{"reason": string(rerunSkipReason), "rerunNodeId": nodeID}})
			plan.Seed.Nodes[node.ID] = NodeSeed{Status: "skipped", State: state}
			plan.NotRun = append(plan.NotRun, node.ID)
		}
	}
	// A human decision covers one execution, and only agents check approval at
	// dispatch, so each write needs every decision upstream of it to run again.
	gated := map[string]bool{}
	for _, effect := range plan.SideEffects {
		upstream := collectRelatives(wf, effect.NodeID, true)
		for _, node := range wf.Nodes {
			if !upstream[node.ID] || closure[node.ID] {
				continue
			}
			if domain.ConsumesHumanDecision(node.Type) {
				return RerunPlan{}, &RerunRejection{Code: "rerun_needs_approval", Message: "Rerun from this human step so it is decided again", NodeID: node.ID}
			}
			if node.Type == "subworkflow" && plan.Seed.Nodes[node.ID].Status == "succeeded" {
				gated[node.ID] = true
			}
		}
	}
	for _, node := range wf.Nodes {
		if gated[node.ID] {
			plan.ReusedSubworkflows = append(plan.ReusedSubworkflows, node.ID)
		}
	}
	return plan, nil
}

// rerunChildReadMax bounds the child runs one rerun request reads.
const rerunChildReadMax = 100

// ErrRerunChildMissing reports a child run that is gone or has no valid snapshot.
var ErrRerunChildMissing = errors.New("subworkflow child run cannot be read")

// RerunChildReader loads a finished child run's executed document and steps.
type RerunChildReader func(ctx context.Context, runID string) (*domain.Workflow, []store.ListRunNodesByRunForOrgRow, error)

// RerunChildDecision refuses a plan whose reused subworkflow, or a run below it,
// consumed a human decision. A child it cannot identify or read counts as one.
func RerunChildDecision(ctx context.Context, plan RerunPlan, read RerunChildReader) (*RerunRejection, error) {
	budget, seen := rerunChildReadMax, map[string]bool{}
	for _, nodeID := range plan.ReusedSubworkflows {
		decided, err := childDecided(ctx, plan.Seed.Nodes[nodeID].State, read, seen, &budget)
		if err != nil {
			return nil, err
		}
		if decided {
			return &RerunRejection{Code: "rerun_needs_approval", Message: "Rerun from this subworkflow so its human step is decided again", NodeID: nodeID}, nil
		}
	}
	return nil, nil
}

func childDecided(ctx context.Context, state json.RawMessage, read RerunChildReader, seen map[string]bool, budget *int) (bool, error) {
	var fields struct {
		Subworkflow struct {
			ChildRunID string `json:"childRunId"`
		} `json:"subworkflow"`
	}
	_ = json.Unmarshal(state, &fields)
	childRunID := fields.Subworkflow.ChildRunID
	if childRunID == "" || seen[childRunID] || *budget == 0 {
		return true, nil
	}
	seen[childRunID] = true
	*budget--
	wf, rows, err := read(ctx, childRunID)
	if errors.Is(err, ErrRerunChildMissing) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	byID := make(map[string]store.ListRunNodesByRunForOrgRow, len(rows))
	for _, row := range rows {
		byID[row.NodeID] = row
	}
	for _, node := range wf.Nodes {
		row, present := byID[node.ID]
		if present && row.Status == "skipped" {
			continue
		}
		if domain.ConsumesHumanDecision(node.Type) {
			return true, nil
		}
		if node.Type == "subworkflow" {
			if decided, err := childDecided(ctx, row.StateJson, read, seen, budget); err != nil || decided {
				return decided, err
			}
		}
	}
	return false, nil
}

// waitsOnChildRun reports a parked subworkflow whose child may still be writing.
func waitsOnChildRun(state json.RawMessage) bool {
	var fields struct {
		Waiting struct {
			Kind string `json:"kind"`
		} `json:"waiting"`
	}
	return json.Unmarshal(state, &fields) == nil && fields.Waiting.Kind == "subworkflow"
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
				switch {
				case item == grammar.RedactedPlaceholder && present:
					out[key] = prior
				case holdsNoLiteral(item):
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
			// Masks restore by position, so a moved or edited element could carry
			// one target's credential to another.
			if key := maskedKey(item); key != "" && (len(value) != len(source) || !reflect.DeepEqual(merged, prior)) {
				return nil, key
			}
			out[index] = merged
		}
		return out, ""
	default:
		return override, ""
	}
}

// holdsNoLiteral accepts secret references with a known auth scheme, and values
// that are not text, such as a tokenLimit.
func holdsNoLiteral(value any) bool {
	switch item := value.(type) {
	case string:
		stripped := domain.StripSecretReferences(item)
		rest := strings.ToLower(strings.TrimSpace(stripped))
		return rest == "" || (stripped != item && slices.Contains([]string{"bearer", "basic", "token"}, rest))
	case map[string]any:
		for _, child := range item {
			if !holdsNoLiteral(child) {
				return false
			}
		}
	case []any:
		return !slices.ContainsFunc(item, func(child any) bool { return !holdsNoLiteral(child) })
	}
	return true
}

func maskedKey(value any) string {
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			if child == grammar.RedactedPlaceholder && grammar.IsSensitiveKey(key) {
				return key
			}
			if found := maskedKey(child); found != "" {
				return found
			}
		}
	case []any:
		for _, child := range item {
			if found := maskedKey(child); found != "" {
				return found
			}
		}
	}
	return ""
}
