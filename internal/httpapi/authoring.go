package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"net/http"
	"slices"
	"strings"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/executors"
)

func init() {
	audit.RegisterRuntimeAction("ai.workflow.proposal_guarded")
}

type workflowProposalRequest struct {
	Prompt          string                `json:"prompt"`
	Brief           authoring.IntentBrief `json:"brief"`
	CurrentWorkflow map[string]any        `json:"currentWorkflow"`
	CatalogVersion  string                `json:"catalogVersion"`
	Model           string                `json:"model"`
}

// Authoring request fields are optional so a partially described intent can
// produce bounded clarification questions. Explicit JSON null is different:
// the OpenAPI contract does not admit it for strings, objects or brief lists,
// and encoding/json otherwise silently turns null into a Go zero value. Keep
// the wire distinction until every supplied field has been type-checked.
type compileWorkflowBriefWire struct {
	Prompt json.RawMessage `json:"prompt"`
	Brief  json.RawMessage `json:"brief"`
}

type workflowProposalWire struct {
	Prompt          json.RawMessage `json:"prompt"`
	Brief           json.RawMessage `json:"brief"`
	CurrentWorkflow json.RawMessage `json:"currentWorkflow"`
	CatalogVersion  json.RawMessage `json:"catalogVersion"`
	Model           json.RawMessage `json:"model"`
}

func decodeStrictAuthoringObject(raw json.RawMessage, target any) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("authoring request must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("authoring request must contain one JSON object")
	}
	return nil
}

func decodeAuthoringWire(r *http.Request, target any) error {
	var raw json.RawMessage
	if err := decodeBody(r, &raw); err != nil {
		return err
	}
	return decodeStrictAuthoringObject(raw, target)
}

func decodeOptionalAuthoringValue(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return errors.New("authoring request fields cannot be null")
	}
	return json.Unmarshal(raw, target)
}

func decodeOptionalIntentBrief(raw json.RawMessage) (authoring.IntentBrief, error) {
	if len(raw) == 0 {
		return authoring.IntentBrief{}, nil
	}
	var fields map[string]json.RawMessage
	if err := decodeStrictAuthoringObject(raw, &fields); err != nil {
		return authoring.IntentBrief{}, err
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return authoring.IntentBrief{}, errors.New("workflow brief fields cannot be null")
		}
	}
	var brief authoring.IntentBrief
	if err := decodeStrictAuthoringObject(raw, &brief); err != nil {
		return authoring.IntentBrief{}, err
	}
	return brief, nil
}

func decodeCompileWorkflowBriefRequest(r *http.Request) (authoring.CompileBriefRequest, error) {
	var wire compileWorkflowBriefWire
	if err := decodeAuthoringWire(r, &wire); err != nil {
		return authoring.CompileBriefRequest{}, err
	}
	var request authoring.CompileBriefRequest
	if err := decodeOptionalAuthoringValue(wire.Prompt, &request.Prompt); err != nil {
		return authoring.CompileBriefRequest{}, err
	}
	brief, err := decodeOptionalIntentBrief(wire.Brief)
	if err != nil {
		return authoring.CompileBriefRequest{}, err
	}
	request.Brief = brief
	return request, nil
}

func decodeWorkflowProposalRequest(r *http.Request) (workflowProposalRequest, error) {
	var wire workflowProposalWire
	if err := decodeAuthoringWire(r, &wire); err != nil {
		return workflowProposalRequest{}, err
	}
	var request workflowProposalRequest
	for _, field := range []struct {
		raw    json.RawMessage
		target *string
	}{
		{raw: wire.Prompt, target: &request.Prompt},
		{raw: wire.CatalogVersion, target: &request.CatalogVersion},
		{raw: wire.Model, target: &request.Model},
	} {
		if err := decodeOptionalAuthoringValue(field.raw, field.target); err != nil {
			return workflowProposalRequest{}, err
		}
	}
	brief, err := decodeOptionalIntentBrief(wire.Brief)
	if err != nil {
		return workflowProposalRequest{}, err
	}
	request.Brief = brief
	if len(wire.CurrentWorkflow) > 0 {
		if bytes.Equal(bytes.TrimSpace(wire.CurrentWorkflow), []byte("null")) {
			return workflowProposalRequest{}, errors.New("currentWorkflow cannot be null")
		}
		if err := decodeStrictAuthoringObject(wire.CurrentWorkflow, &request.CurrentWorkflow); err != nil {
			return workflowProposalRequest{}, err
		}
		for _, field := range []string{"nodes", "edges"} {
			entries, ok := request.CurrentWorkflow[field].([]any)
			if !ok {
				return workflowProposalRequest{}, errors.New("currentWorkflow must contain nodes and edges arrays")
			}
			for _, entry := range entries {
				if _, ok := entry.(map[string]any); !ok {
					return workflowProposalRequest{}, errors.New("currentWorkflow nodes and edges must contain objects")
				}
			}
		}
	}
	return request, nil
}

type proposalReadiness struct {
	Status string                  `json:"status"`
	Issues []domain.ReadinessIssue `json:"issues"`
}

type workflowProposal struct {
	Workflow         map[string]any    `json:"workflow"`
	IntentContract   map[string]string `json:"intentContract"`
	RecoveryContract any               `json:"recoveryContract"`
	Qualification    map[string]bool   `json:"qualification"`
	Assumptions      []string          `json:"assumptions"`
	Risks            []string          `json:"risks"`
	Readiness        proposalReadiness `json:"readiness"`
	Diff             proposalDiff      `json:"diff"`
	Applicable       bool              `json:"applicable"`
}

type finalizedAuthoringProposal struct {
	WorkflowDoc     map[string]any
	Workflow        *domain.Workflow
	Bindings        authoring.BindingReport
	ParseIssues     []domain.Issue
	Mode            string
	ProviderGuarded bool
	GuardReason     string
}

type proposalDiff struct {
	NodesAdded   []string `json:"nodesAdded"`
	NodesRemoved []string `json:"nodesRemoved"`
	NodesChanged []string `json:"nodesChanged"`
	EdgesBefore  int      `json:"edgesBefore"`
	EdgesAfter   int      `json:"edgesAfter"`
}

func (s *V1Server) authoringCatalog(ctxRequest v1Request, r *http.Request) authoring.Catalog {
	return authoring.NewBuilder(s.pool, s.mcp).Build(r.Context(), ctxRequest.orgID)
}

func (s *V1Server) authoringCapabilitiesCore(r *http.Request, rc v1Request) opResult {
	return opOK(s.authoringCatalog(rc, r))
}

func (s *V1Server) compileWorkflowBriefCore(r *http.Request, _ v1Request) opResult {
	request, err := decodeCompileWorkflowBriefRequest(r)
	if err != nil {
		return opError(http.StatusBadRequest, "authoring_brief_invalid", "Invalid workflow brief", nil)
	}
	compiled, err := authoring.CompileBrief(request)
	if err != nil {
		return opError(http.StatusRequestEntityTooLarge, "ai_prompt_too_long", err.Error(), nil)
	}
	return opOK(compiled)
}

// finalizeAuthoringProposal is the deterministic provider-authority
// chokepoint shared by the contract-first API, the compatibility endpoint and
// paid-provider qualification. BindWorkflow stays a pure reporter. When an AI
// draft references an executable identity absent from the tenant catalog or
// adds a known external effect absent from the Intent Brief, the whole
// untrusted graph is discarded rather than patched; a neutral local graph
// preserves the proposal envelope while an explicit synthetic binding keeps
// Apply closed.
func finalizeAuthoringProposal(
	prompt string,
	brief authoring.IntentBrief,
	catalog authoring.Catalog,
	workflowDoc map[string]any,
	mode string,
) finalizedAuthoringProposal {
	graphBindings, workflow, parseIssues := authoring.BindWorkflowJSON(catalog, workflowDoc)
	bindings := graphBindings
	if workflow != nil {
		bindings = authoring.BindProposal(catalog, brief, workflow)
		canonical, err := canonicalAuthoringWorkflowDocument(workflow)
		if err != nil {
			parseIssues = append(parseIssues, domain.Issue{
				Code: domain.CodeInvalidContract, Message: "workflow: canonicalization failed",
			})
			workflow = nil
			bindings.Complete = false
		} else {
			workflowDoc = canonical
		}
	}
	guardReason := ""
	if mode == "ai" && workflow != nil {
		switch {
		case workflowContainsUnsafeProviderSecret(workflow):
			guardReason = "unsafe_provider_secret_material"
		case authoring.HasUnboundCapabilityIdentity(graphBindings):
			guardReason = "unsafe_provider_capability_reference"
		case bindingHasReason(bindings, "proposed_effect_not_declared"):
			guardReason = "unsafe_provider_effect_expansion"
		}
	}
	if guardReason == "" {
		return finalizedAuthoringProposal{
			WorkflowDoc: workflowDoc, Workflow: workflow, Bindings: bindings,
			ParseIssues: parseIssues, Mode: mode,
		}
	}

	guarded := authoring.GuardedIncompleteWorkflow()
	if compiled, _, err := compileWorkflowAssuranceDocument(prompt, guarded); err == nil {
		guarded = compiled
	}
	bindings, workflow, parseIssues = authoring.BindWorkflowJSON(catalog, guarded)
	if workflow != nil {
		bindings = authoring.BindProposal(catalog, brief, workflow)
		if canonical, err := canonicalAuthoringWorkflowDocument(workflow); err == nil {
			guarded = canonical
		} else {
			parseIssues = append(parseIssues, domain.Issue{
				Code: domain.CodeInvalidContract, Message: "workflow: canonicalization failed",
			})
			workflow = nil
			bindings.Complete = false
		}
	}
	bindings.Missing = append(bindings.Missing, authoring.Binding{
		Kind: "provider_output", Field: "workflow", Alternatives: []string{},
		Reason: guardReason,
	})
	bindings.Complete = false
	return finalizedAuthoringProposal{
		WorkflowDoc: guarded, Workflow: workflow, Bindings: bindings,
		ParseIssues: parseIssues, Mode: "fallback", ProviderGuarded: true, GuardReason: guardReason,
	}
}

func bindingHasReason(report authoring.BindingReport, reason string) bool {
	for _, binding := range report.Missing {
		if binding.Reason == reason {
			return true
		}
	}
	return false
}

// canonicalAuthoringWorkflowDocument turns the parsed domain workflow back
// into the exact public DAG contract before any proposal leaves the server.
// Provider JSON is untrusted even after it parses: the parser deliberately
// normalizes identifiers and descriptive metadata and strips unknown carrier
// fields. Returning the original map would let Apply render a different draft
// from the one capability binding and readiness actually inspected.
func canonicalAuthoringWorkflowDocument(workflow *domain.Workflow) (map[string]any, error) {
	raw, err := domain.CanonicalWorkflowDocument(workflow)
	if err != nil {
		return nil, err
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil || document == nil {
		if err == nil {
			err = errors.New("canonical workflow is not an object")
		}
		return nil, err
	}
	return document, nil
}

func (s *V1Server) auditGuardedAuthoringProposal(r *http.Request, rc v1Request, surface string, finalized finalizedAuthoringProposal) {
	if !finalized.ProviderGuarded {
		return
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "ai.workflow.proposal_guarded", audit.Options{
		TargetType: "ai", TargetID: stringField(finalized.WorkflowDoc, "id"),
		Metadata: map[string]any{
			"surface": surface, "catalogVersion": finalized.Bindings.CatalogVersion,
			"reason": finalized.GuardReason,
		},
	})
}

func (s *V1Server) workflowProposalCore(r *http.Request, rc v1Request) opResult {
	request, err := decodeWorkflowProposalRequest(r)
	if err != nil {
		return opError(http.StatusBadRequest, "authoring_proposal_invalid", "Invalid workflow proposal request", nil)
	}
	compiled, err := authoring.CompileBrief(authoring.CompileBriefRequest{Prompt: request.Prompt, Brief: request.Brief})
	if err != nil {
		return opError(http.StatusRequestEntityTooLarge, "ai_prompt_too_long", err.Error(), nil)
	}
	if compiled.Brief.Objective == "" {
		return opError(http.StatusUnprocessableEntity, "authoring_objective_required", "A business objective is required", nil)
	}
	// Proposal generation is stage two of contract-first authoring. Direct API
	// callers must not bypass the clarification gate enforced by the UI, spend a
	// provider budget, or receive an executable-looking graph for an unresolved
	// intent. The deterministic compiler returns at most three bounded questions.
	if !compiled.Complete {
		return opError(http.StatusUnprocessableEntity, "authoring_brief_incomplete",
			"Workflow intent requires clarification before proposal generation",
			map[string]any{"clarifyingQuestions": compiled.ClarifyingQuestions})
	}
	catalog := s.authoringCatalog(rc, r)
	proposalPrompt := authoring.ProposalGenerationPrompt(compiled, request.Prompt)
	catalogChanged := request.CatalogVersion != "" && request.CatalogVersion != catalog.Version
	var wire map[string]any
	if catalogChanged {
		// The caller reviewed a different capability snapshot. Do not spend AI
		// budget, consume the AI rate bucket, or synthesize an executable graph
		// against identities the caller has not seen. Preserve the established
		// 200 proposal envelope with a neutral local graph; the exact catalog
		// binding below keeps Apply closed and tells the caller to rebuild.
		workflowDoc := authoring.GuardedIncompleteWorkflow()
		if guarded, _, compileErr := compileWorkflowAssuranceDocument(proposalPrompt, workflowDoc); compileErr == nil {
			workflowDoc = guarded
		}
		wire = maps.Clone(workflowDoc)
		wire["mode"] = "fallback"
	} else {
		generated := s.generateWorkflowFromPrompt(
			r.Context(), rc, proposalPrompt, request.Model, catalog, compiled.Brief,
		)
		if generated.status < 200 || generated.status >= 300 || generated.data == nil {
			return generated
		}
		var ok bool
		wire, ok = generated.data.(map[string]any)
		if !ok {
			return opError(http.StatusInternalServerError, "authoring_proposal_invalid", "Generated proposal has an invalid envelope", nil)
		}
	}
	mode, _ := wire["mode"].(string)
	aiError, _ := wire["aiError"].(string)
	workflowDoc := maps.Clone(wire)
	delete(workflowDoc, "mode")
	delete(workflowDoc, "aiError")
	delete(workflowDoc, "bonBackoff")

	finalized := finalizeAuthoringProposal(proposalPrompt, compiled.Brief, catalog, workflowDoc, mode)
	s.auditGuardedAuthoringProposal(r, rc, "workflow_proposal", finalized)
	workflowDoc = finalized.WorkflowDoc
	workflow := finalized.Workflow
	bindings := finalized.Bindings
	parseIssues := finalized.ParseIssues
	mode = finalized.Mode
	if catalogChanged {
		bindings.Missing = append(bindings.Missing, authoring.Binding{
			Kind: "catalog_version", Field: "catalogVersion", Requested: request.CatalogVersion,
			ResolvedID: catalog.Version, Alternatives: []string{}, Reason: "capability_catalog_changed",
		})
		bindings.Complete = false
	}
	readiness := proposalReadiness{Status: "fail", Issues: []domain.ReadinessIssue{}}
	if workflow != nil {
		readiness = proposalWorkflowReadiness(workflow, parseIssues)
	}
	assumptions, risks := proposalSignals(compiled.Brief, bindings, mode, readiness, finalized.ProviderGuarded)
	qualification := map[string]bool{"intent": false, "recovery": false, "semantic": false}
	intentContract := map[string]string{}
	var recoveryContract any
	if workflow != nil {
		maps.Copy(intentContract, workflow.Outputs)
		qualification["intent"] = len(workflow.Outputs) > 0
		if workflow.Recovery != nil && workflow.Recovery.Contract != nil {
			recoveryContract = workflow.Recovery.Contract
			qualification["recovery"] = true
			qualification["semantic"] = workflow.Recovery.Contract.Version == "2"
		}
	}
	proposal := workflowProposal{
		Workflow: workflowDoc, IntentContract: intentContract, RecoveryContract: recoveryContract,
		Qualification: qualification, Assumptions: assumptions, Risks: risks,
		Readiness: readiness, Diff: compareWorkflowDocuments(request.CurrentWorkflow, workflowDoc),
		// Apply means copy into an unsaved dirty canvas, not save, validate or
		// execute. Exact capability bindings and a parseable graph are the
		// apply gate; readiness findings remain visible and are enforced by
		// the independent validation/save/start operations.
		Applicable: compiled.Complete && bindings.Complete && workflow != nil,
	}
	response := map[string]any{
		"mode": mode, "brief": compiled.Brief,
		"clarifyingQuestions": compiled.ClarifyingQuestions,
		"bindings":            bindings, "proposal": proposal,
	}
	if finalized.ProviderGuarded {
		response["providerGuarded"] = true
	}
	if aiError != "" {
		response["aiError"] = aiError
	}
	if backoff, present := wire["bonBackoff"]; present {
		response["bonBackoff"] = backoff
	}
	return opOK(response)
}

func proposalWorkflowReadiness(workflow *domain.Workflow, parseIssues []domain.Issue) proposalReadiness {
	issues := make([]domain.ReadinessIssue, 0, len(parseIssues)+8)
	for _, issue := range parseIssues {
		issues = append(issues, domain.ReadinessIssue{
			Code: issue.Code, Severity: "fail", Message: issue.Message,
			NodeID: issue.NodeID, EdgeID: issue.EdgeID,
		})
	}
	// Structural issues may be absent after the generation repair ladder, but
	// capability-aware routes call this helper independently in tests too.
	for _, issue := range validateGeneratedWorkflow(mustMarshalWorkflow(workflow)) {
		issues = append(issues, domain.ReadinessIssue{
			Code: issue.Code, Severity: "fail", Message: issue.Message,
			NodeID: issue.NodeID, EdgeID: issue.EdgeID,
		})
	}
	registry := executors.SharedToolRegistry()
	readiness := domain.CheckWorkflowReadiness(workflow, domain.ReadinessOptions{
		IsWriteSideTool: func(name string, _ map[string]any) bool { return registry.IsWriteSide(name) },
		IsExternalTool:  registry.IsExternal,
	})
	issues = append(issues, readiness.Issues...)
	issues = deduplicateReadinessIssues(issues)
	if len(issues) > 50 {
		issues = issues[:50]
	}
	status := "pass"
	for _, issue := range issues {
		if issue.Severity == "fail" {
			status = "fail"
			break
		}
		if status == "pass" {
			status = "warn"
		}
	}
	return proposalReadiness{Status: status, Issues: issues}
}

func mustMarshalWorkflow(workflow *domain.Workflow) []byte {
	raw, _ := json.Marshal(workflow)
	return raw
}

func deduplicateReadinessIssues(issues []domain.ReadinessIssue) []domain.ReadinessIssue {
	seen := map[string]bool{}
	out := make([]domain.ReadinessIssue, 0, len(issues))
	for _, issue := range issues {
		key := issue.Code + "\x00" + issue.NodeID + "\x00" + issue.EdgeID + "\x00" + issue.Message
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, issue)
	}
	return out
}

func proposalSignals(brief authoring.IntentBrief, bindings authoring.BindingReport, mode string, readiness proposalReadiness, providerGuarded bool) ([]string, []string) {
	assumptions := []string{}
	risks := []string{}
	if brief.Trigger == "manual" {
		assumptions = append(assumptions, "manual_trigger")
	}
	if mode == "fallback" && !providerGuarded {
		assumptions = append(assumptions, "deterministic_template")
	}
	if providerGuarded {
		risks = append(risks, "provider_output_guarded")
	}
	if len(bindings.Missing) > 0 {
		risks = append(risks, "missing_capability_binding")
	}
	if len(brief.ExternalEffects) > 0 && len(brief.Approvals) == 0 {
		risks = append(risks, "external_effect_without_declared_approval")
	}
	switch readiness.Status {
	case "fail":
		risks = append(risks, "readiness_blocked")
	case "warn":
		risks = append(risks, "readiness_warning")
	}
	return assumptions, risks
}

func compareWorkflowDocuments(current, proposed map[string]any) proposalDiff {
	beforeNodes, beforeEdges := proposalGraphParts(current)
	afterNodes, afterEdges := proposalGraphParts(proposed)
	diff := proposalDiff{NodesAdded: []string{}, NodesRemoved: []string{}, NodesChanged: []string{}, EdgesBefore: beforeEdges, EdgesAfter: afterEdges}
	for id, after := range afterNodes {
		before, exists := beforeNodes[id]
		if !exists {
			diff.NodesAdded = append(diff.NodesAdded, id)
		} else if before != after {
			diff.NodesChanged = append(diff.NodesChanged, id)
		}
	}
	for id := range beforeNodes {
		if _, exists := afterNodes[id]; !exists {
			diff.NodesRemoved = append(diff.NodesRemoved, id)
		}
	}
	slices.Sort(diff.NodesAdded)
	slices.Sort(diff.NodesRemoved)
	slices.Sort(diff.NodesChanged)
	return diff
}

func proposalGraphParts(document map[string]any) (map[string]string, int) {
	nodes := map[string]string{}
	rawNodes, _ := document["nodes"].([]any)
	for _, raw := range rawNodes {
		node, _ := raw.(map[string]any)
		id, _ := node["id"].(string)
		if strings.TrimSpace(id) == "" {
			continue
		}
		canonical, _ := json.Marshal(node)
		nodes[id] = string(canonical)
	}
	rawEdges, _ := document["edges"].([]any)
	return nodes, len(rawEdges)
}

func (s *V1Server) mountAuthoringRoutes(mux *http.ServeMux) {
	gate := routeGate{role: auth.RoleViewer, permission: "ai.write"}
	s.route(mux, "GET /v1/authoring/capabilities", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.authoringCapabilitiesCore(r, rc))
	})
	s.route(mux, "POST /ai/workflow-briefs/compile", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.compileWorkflowBriefCore(r, rc))
	})
	s.route(mux, "POST /v1/ai/workflow-briefs/compile", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.compileWorkflowBriefCore(r, rc))
	})
	s.route(mux, "POST /ai/workflow-proposals", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.workflowProposalCore(r, rc))
	})
	s.route(mux, "POST /v1/ai/workflow-proposals", gate, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.workflowProposalCore(r, rc))
	})
}
