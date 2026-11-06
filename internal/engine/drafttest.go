// Draft test runs: a validation run of an unpublished document in which chosen
// steps return a pinned or mocked output instead of executing. Pins live only in
// the run's input_json, never in the workflow document or a version.
package engine

import "encoding/json"

// DraftTestEvidence marks the run as proof of nothing: playbook and recovery
// evidence checks refuse this level.
const DraftTestEvidence = "writes_skipped"

// DraftData is one step's stand-in output. Kind is "pinned" (copied from
// SourceRunID) or "mocked" (typed by the author).
type DraftData struct {
	Kind        string `json:"kind"`
	SourceRunID string `json:"sourceRunId,omitempty"`
	Output      any    `json:"output"`
}

// DraftTest is a draft test run's stand-in data. StepNodeID, when set, runs only
// that step and its ancestors; everything else starts skipped.
type DraftTest struct {
	Pins       map[string]DraftData `json:"pins"`
	StepNodeID string               `json:"stepNodeId,omitempty"`
}

// DraftPinAllowed refuses steps whose completion is a person's decision or a
// branch choice, so a stand-in can never approve or route.
func DraftPinAllowed(nodeType string) bool {
	switch nodeType {
	case "approval", "human_form", "router", "router_llm":
		return false
	}
	return true
}

// draftStepScope is the step and its ancestors, or nil when the whole draft runs.
func draftStepScope(in StartInput) map[string]bool {
	if in.DraftTest == nil || in.DraftTest.StepNodeID == "" {
		return nil
	}
	scope := collectRelatives(in.Workflow, in.DraftTest.StepNodeID, true)
	scope[in.DraftTest.StepNodeID] = true
	return scope
}

// draftTestOutput returns a step's stand-in output. Only a validation run honors
// one, so a production run carrying the same envelope still executes.
func draftTestOutput(replayMode string, inputJSON []byte, nodeID, nodeType string) (any, bool) {
	if replayMode != "validation" || !DraftPinAllowed(nodeType) {
		return nil, false
	}
	// Only this step's stand-in is decoded; the others stay raw.
	var envelope struct {
		DraftTest struct {
			Pins map[string]json.RawMessage `json:"pins"`
		} `json:"draftTest"`
	}
	if json.Unmarshal(inputJSON, &envelope) != nil {
		return nil, false
	}
	var data DraftData
	raw, ok := envelope.DraftTest.Pins[nodeID]
	if !ok || json.Unmarshal(raw, &data) != nil {
		return nil, false
	}
	return data.Output, true
}
