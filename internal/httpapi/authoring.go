package httpapi

import (
	"encoding/json"
	"maps"
	"net/http"
	"slices"
	"strings"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/tools"
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
	var request authoring.CompileBriefRequest
	if err := decodeBody(r, &request); err != nil {
		return opError(http.StatusBadRequest, "authoring_brief_invalid", "Invalid workflow brief", nil)
	}
	compiled, err := authoring.CompileBrief(request)
	if err != nil {
		return opError(http.StatusRequestEntityTooLarge, "ai_prompt_too_long", err.Error(), nil)
	}
	return opOK(compiled)
}

// finalizeAuthoringProposal is the deterministic capability-identity
// chokepoint shared by the contract-first API, the compatibility endpoint and
// paid-provider qualification. BindWorkflow stays a pure reporter. When an AI
// draft references an executable identity absent from the tenant catalog, the
// whole untrusted graph is discarded rather than patched; a neutral local
// graph preserves the proposal envelope while an explicit synthetic binding
// keeps Apply closed.
func finalizeAuthoringProposal(
	prompt string,
	brief authoring.IntentBrief,
	catalog authoring.Catalog,
	workflowDoc map[string]any,
	mode string,
) finalizedAuthoringProposal {
	graphBindings, workflow, parseIssues := authoring.BindWorkflowJSON(catalog, workflowDoc)
	if mode != "ai" || workflow == nil || !authoring.HasUnboundCapabilityIdentity(graphBindings) {
		bindings := graphBindings
		if workflow != nil {
			bindings = authoring.BindProposal(catalog, brief, workflow)
		}
		return finalizedAuthoringProposal{
			WorkflowDoc: workflowDoc, Workflow: workflow, Bindings: bindings,
			ParseIssues: parseIssues, Mode: mode,
		}
	}

	guarded := authoring.GuardedIncompleteWorkflow()
	if compiled, _, err := compileWorkflowAssuranceDocument(prompt, guarded); err == nil {
		guarded = compiled
	}
	bindings, workflow, parseIssues := authoring.BindWorkflowJSON(catalog, guarded)
	if workflow != nil {
		bindings = authoring.BindProposal(catalog, brief, workflow)
	}
	bindings.Missing = append(bindings.Missing, authoring.Binding{
		Kind: "provider_output", Field: "workflow", Alternatives: []string{},
		Reason: "unsafe_provider_capability_reference",
	})
	bindings.Complete = false
	return finalizedAuthoringProposal{
		WorkflowDoc: guarded, Workflow: workflow, Bindings: bindings,
		ParseIssues: parseIssues, Mode: "fallback", ProviderGuarded: true,
	}
}

func (s *V1Server) auditGuardedAuthoringProposal(r *http.Request, rc v1Request, surface string, finalized finalizedAuthoringProposal) {
	if !finalized.ProviderGuarded {
		return
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "ai.workflow.proposal_guarded", audit.Options{
		TargetType: "ai", TargetID: stringField(finalized.WorkflowDoc, "id"),
		Metadata: map[string]any{
			"surface": surface, "catalogVersion": finalized.Bindings.CatalogVersion,
			"reason": "unsafe_provider_capability_reference",
		},
	})
}

func (s *V1Server) workflowProposalCore(r *http.Request, rc v1Request) opResult {
	var request workflowProposalRequest
	if err := decodeBody(r, &request); err != nil {
		return opError(http.StatusBadRequest, "authoring_proposal_invalid", "Invalid workflow proposal request", nil)
	}
	compiled, err := authoring.CompileBrief(authoring.CompileBriefRequest{Prompt: request.Prompt, Brief: request.Brief})
	if err != nil {
		return opError(http.StatusRequestEntityTooLarge, "ai_prompt_too_long", err.Error(), nil)
	}
	if compiled.Brief.Objective == "" {
		return opError(http.StatusUnprocessableEntity, "authoring_objective_required", "A business objective is required", nil)
	}
	catalog := s.authoringCatalog(rc, r)
	proposalPrompt := authoring.ProposalPrompt(compiled.Brief)
	generated := s.generateWorkflowFromPrompt(
		r.Context(), rc, proposalPrompt, request.Model,
		authoring.CapabilityPromptBlock(catalog),
	)
	if generated.status < 200 || generated.status >= 300 || generated.data == nil {
		return generated
	}
	wire, ok := generated.data.(map[string]any)
	if !ok {
		return opError(http.StatusInternalServerError, "authoring_proposal_invalid", "Generated proposal has an invalid envelope", nil)
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
	if request.CatalogVersion != "" && request.CatalogVersion != catalog.Version {
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
		Applicable: bindings.Complete && workflow != nil,
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
	registry := tools.NewRegistry()
	readiness := domain.CheckWorkflowReadiness(workflow, domain.ReadinessOptions{
		IsWriteSideTool: func(name string, _ map[string]any) bool { return registry.IsWriteSide(name) },
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
	s.route(mux, "GET /v1/authoring/capabilities", routeGate{role: auth.RoleViewer, permission: "ai.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeVersioned(w, rc.id, s.authoringCapabilitiesCore(r, rc))
	})
	s.route(mux, "POST /ai/workflow-briefs/compile", routeGate{role: auth.RoleViewer, permission: "ai.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.compileWorkflowBriefCore(r, rc))
	})
	s.route(mux, "POST /ai/workflow-proposals", routeGate{role: auth.RoleViewer, permission: "ai.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.workflowProposalCore(r, rc))
	})
}
