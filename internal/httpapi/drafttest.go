// Draft test runs (engine/drafttest.go): run the editor's draft as a validation
// run in which chosen steps reuse a past output or a mocked one. The request
// never saves the document, and pins never leave the run they were sent with.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/runstart"
	"github.com/johnny4young/janusly/internal/store"
)

func init() { audit.RegisterRuntimeAction("run.draft_test_started") }

type draftPinRequest struct {
	SourceRunID string          `json:"sourceRunId"`
	Mock        json.RawMessage `json:"mock"`
}

type draftTestRequest struct {
	Workflow   json.RawMessage            `json:"workflow"`
	Input      any                        `json:"input"`
	Pins       map[string]draftPinRequest `json:"pins"`
	StepNodeID string                     `json:"stepNodeId"`
}

func draftPinRefused(code, message, nodeID string) *opResult {
	failed := opError(http.StatusUnprocessableEntity, code, message, map[string]any{"nodeId": nodeID})
	return &failed
}

// resolveDraftPin copies a pinned output from a run of the same workflow in the
// caller's organization, or takes the mock, masking sensitive keys either way.
func (s *V1Server) resolveDraftPin(r *http.Request, rc v1Request, workflowID, nodeID string, pin draftPinRequest) (engine.DraftData, *opResult) {
	if pin.SourceRunID == "" {
		if len(pin.Mock) == 0 || len(pin.Mock) > replayLabOverrideMaxBytes {
			return engine.DraftData{}, draftPinRefused("draft_mock_invalid", "A mock needs a JSON value up to 64 KiB", nodeID)
		}
		var mock any
		if json.Unmarshal(pin.Mock, &mock) != nil {
			return engine.DraftData{}, draftPinRefused("draft_mock_invalid", "A mock needs a JSON value up to 64 KiB", nodeID)
		}
		return engine.DraftData{Kind: "mocked", Output: grammar.RedactSensitiveKeys(mock)}, nil
	}
	q := store.New(s.pool)
	run, err := q.GetRun(r.Context(), store.GetRunParams{ID: pin.SourceRunID, OrgID: rc.orgID})
	if err != nil {
		failed := opError(http.StatusNotFound, "not_found", "Source run not found", nil)
		return engine.DraftData{}, &failed
	}
	var envelope struct {
		Workflow  struct{ ID string } `json:"workflow"`
		DraftTest *engine.DraftTest   `json:"draftTest"`
	}
	if json.Unmarshal(run.InputJson, &envelope) != nil || envelope.Workflow.ID != workflowID {
		return engine.DraftData{}, draftPinRefused("draft_pin_other_workflow", "The source run belongs to another workflow", nodeID)
	}
	// A stand-in from an earlier test is not a real output to pin again.
	if envelope.DraftTest != nil {
		if _, standIn := envelope.DraftTest.Pins[nodeID]; standIn {
			return engine.DraftData{}, draftPinRefused("draft_pin_no_output", "This step has no saved output in the source run", nodeID)
		}
	}
	row, err := q.GetRunNode(r.Context(), store.GetRunNodeParams{RunID: run.ID, NodeID: nodeID})
	var state struct {
		Output json.RawMessage `json:"output"`
	}
	if err != nil || row.Status != "succeeded" || json.Unmarshal(row.StateJson, &state) != nil || len(state.Output) == 0 {
		return engine.DraftData{}, draftPinRefused("draft_pin_no_output", "This step has no saved output in the source run", nodeID)
	}
	var output any
	_ = json.Unmarshal(state.Output, &output)
	return engine.DraftData{Kind: "pinned", SourceRunID: run.ID, Output: grammar.RedactSensitiveKeys(output)}, nil
}

func (s *V1Server) draftTestCore(r *http.Request, rc v1Request) opResult {
	if err := s.limiter.Enforce(r.Context(), rc.orgID, s.startRunLimit); err != nil {
		return limitedResult(err)
	}
	var body draftTestRequest
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	wf, issues := domain.Parse(body.Workflow)
	if wf == nil || wf.ID == "" {
		return opError(http.StatusBadRequest, runstart.CodeValidationFailed, "Validation failed", map[string]any{"issues": issues})
	}
	// Pins are scoped to a saved workflow; every other gate is runstart's.
	if _, err := store.New(s.pool).GetWorkflowBreakerStatus(r.Context(), store.GetWorkflowBreakerStatusParams{OrgID: rc.orgID, ID: wf.ID}); errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusNotFound, "draft_test_unsaved", "Save the workflow before testing it", nil)
	} else if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	nodeType := func(id string) (string, bool) {
		index := slices.IndexFunc(wf.Nodes, func(node domain.Node) bool { return node.ID == id })
		if index < 0 {
			return "", false
		}
		return wf.Nodes[index].Type, true
	}
	if _, ok := nodeType(body.StepNodeID); body.StepNodeID != "" && !ok {
		return opError(http.StatusUnprocessableEntity, "fork_node_not_found", "Step is not part of this workflow", map[string]any{"nodeId": body.StepNodeID})
	}
	test := engine.DraftTest{Pins: make(map[string]engine.DraftData, len(body.Pins)), StepNodeID: body.StepNodeID}
	for nodeID, pin := range body.Pins {
		kind, ok := nodeType(nodeID)
		if !ok {
			return *draftPinRefused("fork_node_not_found", "Step is not part of this workflow", nodeID)
		}
		if !engine.DraftPinAllowed(kind) {
			return *draftPinRefused("draft_pin_not_allowed", "Approvals, forms and routers cannot be pinned or mocked", nodeID)
		}
		data, refused := s.resolveDraftPin(r, rc, wf.ID, nodeID, pin)
		if refused != nil {
			return *refused
		}
		test.Pins[nodeID] = data
	}
	started, err := (runstart.Service{Engine: s.engine, Pool: s.pool, NewID: s.newID}).Start(r.Context(), runstart.Request{
		OrgID: rc.orgID, CreatedBy: rc.userID, Workflow: wf, Input: body.Input, DraftTest: &test,
	})
	if err != nil {
		return runStartFailure(err)
	}
	runID := started.RunID
	// Pinned and mocked values never reach the audit trail.
	pinned := make([]string, 0, len(test.Pins))
	for nodeID := range test.Pins {
		pinned = append(pinned, nodeID)
	}
	slices.Sort(pinned)
	s.audit.Write(r.Context(), s.pool, rc.authContext, "run.draft_test_started", audit.Options{
		TargetType: "run", TargetID: runID,
		Metadata: map[string]any{"workflowId": wf.ID, "standInSteps": pinned, "stepNodeId": body.StepNodeID},
	})
	return opOK(map[string]any{"runId": runID})
}

func (s *V1Server) mountDraftTestRoutes(mux *http.ServeMux) {
	s.route(mux, "POST /runs/draft-test", routeGate{auth.RoleEditor, "runs.start"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.draftTestCore(r, rc))
	})
}
