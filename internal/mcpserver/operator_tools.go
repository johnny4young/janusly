package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/aibudget"
	"github.com/johnny4young/janusly/internal/aiconfig"
	"github.com/johnny4young/janusly/internal/aidiagnosis"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/operations"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

const (
	maxMCPWorkflowDocumentBytes = 128_000
	maxMCPProposalNodes         = 100
	maxMCPProposalIssues        = 50
)

type mcpWorkflowProposalArgs struct {
	Prompt         string                 `json:"prompt,omitempty" jsonschema:"natural-language business intent; maximum 4000 characters"`
	Brief          *authoring.IntentBrief `json:"brief,omitempty" jsonschema:"optional structured intent brief fields"`
	Workflow       map[string]any         `json:"workflow,omitempty" jsonschema:"optional caller-authored Janusly workflow draft to bind; omitted uses the deterministic provider-free template"`
	CatalogVersion string                 `json:"catalogVersion,omitempty" jsonschema:"optional catalog version previously inspected by the caller"`
}

type mcpRecoveryInspectArgs struct {
	CaseID string `json:"caseId" jsonschema:"the tenant-scoped recovery case to inspect"`
}

type mcpManualReplacement struct {
	Output any    `json:"output" jsonschema:"structured replacement output; never echoed by MCP"`
	Reason string `json:"reason" jsonschema:"bounded operator rationale"`
}

type mcpRecoveryDiagnoseArgs struct {
	CaseID            string                `json:"caseId" jsonschema:"the tenant-scoped recovery case"`
	ExpectedRevision  int64                 `json:"expectedRevision" jsonschema:"exact current case revision"`
	ManualReplacement *mcpManualReplacement `json:"manualReplacement,omitempty" jsonschema:"optional typed replacement candidate"`
	AcceptLossReason  string                `json:"acceptLossReason,omitempty" jsonschema:"optional rationale for the explicit-loss candidate"`
}

type mcpRecoveryValidateArgs struct {
	CaseID              string `json:"caseId" jsonschema:"the tenant-scoped recovery case"`
	ExpectedRevision    int64  `json:"expectedRevision" jsonschema:"exact current case revision"`
	CandidateArtifactID string `json:"candidateArtifactId" jsonschema:"immutable candidate artifact id"`
}

type mcpRecoveryApplyArgs struct {
	CaseID               string `json:"caseId" jsonschema:"the tenant-scoped recovery case"`
	ExpectedRevision     int64  `json:"expectedRevision" jsonschema:"exact current case revision"`
	CandidateArtifactID  string `json:"candidateArtifactId" jsonschema:"immutable candidate artifact id"`
	ValidationArtifactID string `json:"validationArtifactId" jsonschema:"passing validation artifact bound to the candidate"`
}

func registerOperatorTools(server *mcp.Server, deps Deps) {
	mcp.AddTool(server, readTool(
		"operations.brief", "Operator brief",
		"Return Janusly's deterministic top-three tenant priorities. This is the exact read model used by Home; AI cannot rerank it.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
		return deps.operationsBrief(ctx)
	})

	mcp.AddTool(server, readTool(
		"workflows.propose", "Propose workflow",
		"Compile an intent brief and bind a provider-free or caller-supplied workflow draft to exact tenant capabilities. Returns a bounded summary, never a full DAG.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args mcpWorkflowProposalArgs) (*mcp.CallToolResult, any, error) {
		return deps.proposeWorkflow(ctx, args)
	})

	mcp.AddTool(server, readTool(
		"recovery.cases.inspect", "Inspect recovery case",
		"Inspect bounded recovery state, transition and artifact metadata without raw evidence, outputs, workflow DAGs, or approval grants.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args mcpRecoveryInspectArgs) (*mcp.CallToolResult, any, error) {
		return deps.inspectRecoveryCase(ctx, args.CaseID)
	})

	mcp.AddTool(server, writeTool(
		"recovery.cases.diagnose", "Diagnose recovery case",
		"Persist a deterministic or bounded AI-enriched diagnosis and one to three engine-owned immutable typed recovery candidates. Provider absence never blocks this operation.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args mcpRecoveryDiagnoseArgs) (*mcp.CallToolResult, any, error) {
		return deps.diagnoseRecoveryCase(ctx, args)
	})

	mcp.AddTool(server, writeTool(
		"recovery.cases.validate", "Validate recovery candidate",
		"Validate one immutable candidate against the exact workflow snapshot and persist a content-bound validation artifact.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args mcpRecoveryValidateArgs) (*mcp.CallToolResult, any, error) {
		return deps.validateRecoveryCase(ctx, args)
	})

	mcp.AddTool(server, writeTool(
		"recovery.cases.apply", "Apply recovery candidate",
		"Apply an immutable validated candidate only after an independent active human approval. MCP never creates approvals.", true,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args mcpRecoveryApplyArgs) (*mcp.CallToolResult, any, error) {
		return deps.applyRecoveryCase(ctx, args)
	})
}

func (d Deps) operationsBrief(ctx context.Context) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardToolAny(ctx, "operations.brief", []string{
		"recovery.read", "runs.read", "dlq.read",
	}, false); !allowed {
		return expected(message)
	}
	brief := operations.Builder{
		Pool: d.Pool, Surface: operations.ActionSurfaceMCP,
	}.Build(ctx, d.OrgID, d.Permissions)
	return ok(brief)
}

func (d Deps) proposeWorkflow(ctx context.Context, args mcpWorkflowProposalArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.propose", "ai.write", false); !allowed {
		return expected(message)
	}
	if raw, err := json.Marshal(args); err != nil || len(raw) > maxMCPRequestBytes {
		return expected("workflow proposal request is invalid or exceeds 256000 bytes")
	}
	brief := authoring.IntentBrief{}
	if args.Brief != nil {
		brief = *args.Brief
	}
	compiled, err := authoring.CompileBrief(authoring.CompileBriefRequest{Prompt: args.Prompt, Brief: brief})
	if err != nil {
		return expected(err.Error())
	}
	if compiled.Brief.Objective == "" {
		return expected("a business objective is required")
	}
	catalog := authoring.NewBuilder(d.Pool, d.CatalogSource).Build(ctx, d.OrgID)
	document := args.Workflow
	mode := "caller_draft"
	var bindings authoring.BindingReport
	var workflow *domain.Workflow
	var parseIssues []domain.Issue
	if document == nil && !compiled.Complete {
		// MCP combines the Brief and Proposal stages in one bounded read tool.
		// Return the questions without manufacturing an executable-looking DAG
		// from unresolved high-impact intent; a caller-supplied draft can still
		// be inspected and bound below while remaining unappliable.
		mode = "clarification_required"
		bindings = authoring.BindingReport{
			CatalogVersion: catalog.Version,
			Resolved:       []authoring.Binding{},
			Missing:        []authoring.Binding{},
			Complete:       false,
		}
	} else {
		if document == nil {
			document = authoring.DeterministicWorkflowWithOptions(
				authoring.ProposalGenerationPrompt(compiled, args.Prompt),
				authoring.DeterministicWorkflowOptions{Catalog: &catalog, Brief: &compiled.Brief},
			)
			mode = "deterministic_fallback"
		}
		raw, marshalErr := json.Marshal(document)
		if marshalErr != nil || len(raw) > maxMCPWorkflowDocumentBytes {
			return expected("workflow draft is invalid or exceeds 128000 bytes")
		}
		bindings, workflow, parseIssues = authoring.BindWorkflowJSON(catalog, document)
		if workflow != nil {
			bindings = authoring.BindProposal(catalog, compiled.Brief, workflow)
		}
	}
	if args.CatalogVersion != "" && args.CatalogVersion != catalog.Version {
		bindings.Missing = append(bindings.Missing, authoring.Binding{
			Kind: "catalog_version", Field: "catalogVersion", Requested: args.CatalogVersion,
			ResolvedID: catalog.Version, Alternatives: []string{}, Reason: "capability_catalog_changed",
		})
		bindings.Complete = false
	}
	return ok(mcpWorkflowProposalView(compiled, catalog, bindings, workflow, parseIssues, mode))
}

func mcpWorkflowProposalView(
	compiled authoring.BriefCompilation,
	catalog authoring.Catalog,
	bindings authoring.BindingReport,
	workflow *domain.Workflow,
	parseIssues []domain.Issue,
	mode string,
) map[string]any {
	view := map[string]any{
		"mode": mode, "catalogVersion": catalog.Version,
		"catalogWarnings":     stringSliceView(catalog.Warnings, 20, 120),
		"brief":               mcpBriefView(compiled.Brief),
		"clarifyingQuestions": stringSliceView(compiled.ClarifyingQuestions, 3, 300),
		"bindings":            mcpBindingReportView(bindings),
		"applicable":          compiled.Complete && bindings.Complete && workflow != nil,
	}
	if workflow == nil {
		view["workflow"] = map[string]any{"parseable": false, "nodeCount": 0, "edgeCount": 0, "nodes": []any{}}
		view["assurance"] = map[string]any{
			"validation": map[string]any{"valid": false, "issues": mcpDomainIssueViews(parseIssues)},
			"readiness":  map[string]any{"status": "fail", "issues": []any{}},
		}
		return view
	}

	nodes := make([]map[string]any, 0, min(len(workflow.Nodes), maxMCPProposalNodes))
	types := map[string]bool{}
	for _, node := range workflow.Nodes[:min(len(workflow.Nodes), maxMCPProposalNodes)] {
		nodes = append(nodes, map[string]any{
			"id": boundedMCPText(node.ID, 160), "type": boundedMCPText(node.Type, 80),
		})
		types[node.Type] = true
	}
	validation := workflowvalidation.ValidateDraft(workflow)
	readiness := domain.CheckWorkflowReadiness(workflow, mcpReadinessOptions())
	view["workflow"] = map[string]any{
		"parseable": true,
		"id":        boundedMCPText(workflow.ID, 160), "name": boundedMCPText(workflow.Name, 240),
		"nodeCount": len(workflow.Nodes), "edgeCount": len(workflow.Edges),
		"nodeTypes": sortedStringSet(types), "nodes": nodes,
		"truncatedNodes": max(len(workflow.Nodes)-len(nodes), 0),
	}
	view["assurance"] = mcpProposalAssuranceView(workflow, validation, readiness)
	return view
}

func mcpBriefView(brief authoring.IntentBrief) map[string]any {
	return map[string]any{
		"version": brief.Version, "language": brief.Language,
		"objective":       boundedMCPText(brief.Objective, 1200),
		"trigger":         boundedMCPText(brief.Trigger, 300),
		"inputs":          stringSliceView(brief.Inputs, 12, 300),
		"expectedOutcome": boundedMCPText(brief.ExpectedOutcome, 1200),
		"externalEffects": stringSliceView(brief.ExternalEffects, 12, 300),
		"approvals":       stringSliceView(brief.Approvals, 12, 300),
		"failurePolicy":   boundedMCPText(brief.FailurePolicy, 1200),
		"examples":        stringSliceView(brief.Examples, 12, 300),
	}
}

func mcpBindingReportView(report authoring.BindingReport) map[string]any {
	convert := func(bindings []authoring.Binding) []map[string]any {
		limit := min(len(bindings), maxMCPProposalIssues)
		out := make([]map[string]any, 0, limit)
		for _, binding := range bindings[:limit] {
			out = append(out, map[string]any{
				"kind": boundedMCPText(binding.Kind, 80), "nodeId": boundedMCPText(binding.NodeID, 160),
				"field": boundedMCPText(binding.Field, 160), "requested": boundedMCPText(binding.Requested, 240),
				"resolvedId":   boundedMCPText(binding.ResolvedID, 240),
				"alternatives": stringSliceView(binding.Alternatives, 8, 240),
				"reason":       boundedMCPText(binding.Reason, 160),
			})
		}
		return out
	}
	return map[string]any{
		"catalogVersion": report.CatalogVersion, "complete": report.Complete,
		"resolved": convert(report.Resolved), "missing": convert(report.Missing),
		"omittedResolved": max(len(report.Resolved)-maxMCPProposalIssues, 0),
		"omittedMissing":  max(len(report.Missing)-maxMCPProposalIssues, 0),
	}
}

func mcpProposalAssuranceView(
	workflow *domain.Workflow,
	validation domain.ValidationResult,
	readiness domain.ReadinessResult,
) map[string]any {
	outputFields := make([]string, 0, len(workflow.Outputs))
	for key := range workflow.Outputs {
		outputFields = append(outputFields, boundedMCPText(key, 160))
	}
	sort.Strings(outputFields)
	recoveryView := map[string]any{"declared": false}
	qualification := map[string]any{"declared": false, "detectorCount": 0, "fixtureCount": 0}
	if workflow.Recovery != nil && workflow.Recovery.Contract != nil {
		contract := workflow.Recovery.Contract
		recoveryView = map[string]any{
			"declared": true, "version": contract.Version,
			"autonomyLevel":              contract.AutonomyLevel,
			"semanticMode":               contract.Failure.Semantic.Mode,
			"productionApprovalRequired": contract.Approval.ProductionMutation == "required",
			"permission":                 contract.Approval.Permission,
		}
		qualification = map[string]any{
			"declared":      contract.Version == "2",
			"detectorCount": len(contract.Failure.Semantic.Detectors),
			"fixtureCount":  len(contract.Failure.Semantic.EvaluationFixtures),
		}
	}
	return map[string]any{
		"intent":   map[string]any{"declared": len(outputFields) > 0, "outputFields": outputFields},
		"recovery": recoveryView, "qualification": qualification,
		"validation": map[string]any{"valid": validation.Valid, "issues": mcpDomainIssueViews(validation.Issues)},
		"readiness":  map[string]any{"status": readiness.Status, "issues": mcpReadinessIssueViews(readiness.Issues)},
	}
}

func mcpDomainIssueViews(issues []domain.Issue) []map[string]any {
	limit := min(len(issues), maxMCPProposalIssues)
	out := make([]map[string]any, 0, limit)
	for _, issue := range issues[:limit] {
		out = append(out, map[string]any{
			"code": issue.Code, "nodeId": boundedMCPText(issue.NodeID, 160),
			"edgeId": boundedMCPText(issue.EdgeID, 160),
		})
	}
	return out
}

func mcpReadinessIssueViews(issues []domain.ReadinessIssue) []map[string]any {
	limit := min(len(issues), maxMCPProposalIssues)
	out := make([]map[string]any, 0, limit)
	for _, issue := range issues[:limit] {
		out = append(out, map[string]any{
			"code": issue.Code, "severity": issue.Severity,
			"nodeId": boundedMCPText(issue.NodeID, 160), "edgeId": boundedMCPText(issue.EdgeID, 160),
		})
	}
	return out
}

func (d Deps) inspectRecoveryCase(ctx context.Context, caseID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "recovery.cases.inspect", "recovery.read", false); !allowed {
		return expected(message)
	}
	if !validMCPCaseID(caseID) {
		return expected("caseId is required and must be at most 256 characters")
	}
	detail, err := d.Engine.GetRecoveryCaseDetail(ctx, d.OrgID, caseID)
	if err != nil {
		return mcpRecoveryError(err)
	}
	return ok(mcpRecoveryDetailView(detail))
}

// optionalRecoveryDiagnosisEnrichment gives the service account AI prose only
// when its explicit ceiling includes ai.write. Every failure returns nil and
// leaves the governed write on the deterministic engine path.
func (d Deps) optionalRecoveryDiagnosisEnrichment(
	ctx context.Context,
	caseID string,
	expectedRevision int64,
) *aidiagnosis.Enrichment {
	if d.Pool == nil || d.Engine == nil || d.Permissions == nil || !d.Permissions["ai.write"] {
		return nil
	}
	client, settings := aiconfig.Resolve(ctx, d.Pool, d.OrgID)
	if !client.Configured() {
		return nil
	}
	facts, err := d.Engine.LoadRecoveryDiagnosisFacts(ctx, d.OrgID, caseID, expectedRevision, "en")
	if err != nil {
		return nil
	}
	generated, aiErr := aidiagnosis.Generate(ctx, client, aidiagnosis.GenerateInput{
		Evidence: facts.AIEvidence(),
		Context:  ai.CallContext{OrgID: d.OrgID, UserID: d.UserID},
		AdmitCall: func(callCtx context.Context) *ai.AIError {
			if d.Limiter != nil {
				if err := d.Limiter.Enforce(callCtx, d.OrgID, ratelimit.Options{
					Name: "ai", Max: settings.RateLimitPerMin, Window: time.Minute,
				}); err != nil {
					return &ai.AIError{Class: "rate_limit", Message: err.Error(), BeforeEgress: true}
				}
			}
			if gate := aibudget.Gate(callCtx, d.Pool, d.OrgID, d.UserID, "ai.recovery.diagnosed"); !gate.Allowed {
				return &ai.AIError{Class: "budget_blocked", Message: "monthly AI budget exceeded", BeforeEgress: true}
			}
			return nil
		},
	})
	if aiErr != nil {
		return nil
	}
	return &generated.Enrichment
}

func (d Deps) diagnoseRecoveryCase(ctx context.Context, args mcpRecoveryDiagnoseArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "recovery.cases.diagnose", "recovery.write", true); !allowed {
		return expected(message)
	}
	if !validMCPCaseID(args.CaseID) || args.ExpectedRevision < 1 {
		return expected("caseId and a positive expectedRevision are required")
	}
	if raw, err := json.Marshal(args); err != nil || len(raw) > maxMCPWorkflowDocumentBytes {
		return expected("recovery request is invalid or exceeds 128000 bytes")
	}
	caseRow, err := store.New(d.Pool).GetRecoveryCase(ctx, store.GetRecoveryCaseParams{OrgID: d.OrgID, ID: args.CaseID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("recovery case not found")
		}
		return mcpRecoveryError(err)
	}
	if caseRow.Revision != args.ExpectedRevision {
		return expected("recovery case conflict")
	}
	preflight := engine.CreateRecoveryCandidatesInput{
		Auth: d.auditContext(), CaseID: args.CaseID, ExpectedRevision: args.ExpectedRevision,
		AcceptLossReason: args.AcceptLossReason,
	}
	if args.ManualReplacement != nil {
		preflight.ManualReplacement = &engine.SemanticManualReplacement{
			Output: args.ManualReplacement.Output, Reason: args.ManualReplacement.Reason,
		}
	}
	if err := d.Engine.PreflightRecoveryCandidates(ctx, preflight); err != nil {
		return mcpRecoveryError(err)
	}
	mode := "existing_diagnosis"
	var diagnosis *store.RecoveryCaseArtifact
	if caseRow.State == "detected" || caseRow.State == "contained" {
		enrichment := d.optionalRecoveryDiagnosisEnrichment(ctx, args.CaseID, args.ExpectedRevision)
		result, diagnoseErr := d.Engine.DiagnoseRecoveryCase(ctx, engine.DiagnoseRecoveryCaseInput{
			Auth: d.auditContext(), CaseID: args.CaseID, ExpectedRevision: args.ExpectedRevision,
			Language: "en", Enrichment: enrichment,
		})
		if diagnoseErr != nil {
			return mcpRecoveryError(diagnoseErr)
		}
		caseRow = result.Case
		diagnosis = &result.Diagnosis
		mode = result.Mode
	} else if caseRow.State != "diagnosed" {
		return expected("recovery case conflict")
	}
	preflight.ExpectedRevision = caseRow.Revision
	created, err := d.Engine.CreateRecoveryCandidates(ctx, preflight)
	if err != nil {
		return mcpRecoveryError(err)
	}
	candidates := make([]map[string]any, 0, len(created.Candidates))
	for _, artifact := range created.Candidates {
		candidates = append(candidates, mcpRecoveryArtifactView(artifact))
	}
	payload := map[string]any{
		"case": mcpRecoveryCaseView(created.Case), "mode": mode,
		"candidates": candidates, "approvalCreated": false,
	}
	if diagnosis != nil {
		payload["diagnosis"] = mcpRecoveryArtifactView(*diagnosis)
	}
	return ok(payload)
}

func (d Deps) validateRecoveryCase(ctx context.Context, args mcpRecoveryValidateArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "recovery.cases.validate", "recovery.write", true); !allowed {
		return expected(message)
	}
	if !validMCPCaseID(args.CaseID) || args.ExpectedRevision < 1 || !validMCPArtifactID(args.CandidateArtifactID) {
		return expected("caseId, candidateArtifactId and a positive expectedRevision are required")
	}
	result, err := d.Engine.ValidateRecoveryCaseCandidate(ctx, engine.ValidateRecoveryCaseCandidateInput{
		Auth: d.auditContext(), CaseID: args.CaseID, ExpectedRevision: args.ExpectedRevision,
		CandidateArtifactID: args.CandidateArtifactID,
	})
	if err != nil {
		return mcpRecoveryError(err)
	}
	return ok(map[string]any{
		"case":       mcpRecoveryCaseView(result.Case),
		"validation": mcpRecoveryArtifactView(result.Validation),
		"passed":     result.Passed, "approvalCreated": false,
	})
}

func (d Deps) applyRecoveryCase(ctx context.Context, args mcpRecoveryApplyArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "recovery.cases.apply", "recovery.write", true); !allowed {
		return expected(message)
	}
	if !validMCPCaseID(args.CaseID) || args.ExpectedRevision < 1 ||
		!validMCPArtifactID(args.CandidateArtifactID) || !validMCPArtifactID(args.ValidationArtifactID) {
		return expected("caseId, candidateArtifactId, validationArtifactId and a positive expectedRevision are required")
	}
	artifact, err := store.New(d.Pool).GetRecoveryCaseArtifact(ctx, store.GetRecoveryCaseArtifactParams{
		OrgID: d.OrgID, CaseID: args.CaseID, ID: args.CandidateArtifactID,
	})
	if err != nil || artifact.Kind != "candidate" {
		return expected("recovery case conflict")
	}
	candidate, err := engine.ParseSemanticRecoveryCandidatePayload(artifact.PayloadJson)
	if err != nil {
		return expected("recovery candidate is invalid")
	}
	if allowed, message := d.requireAdditionalPermissions(ctx, "recovery.cases.apply", candidate.RequiredPermissions); !allowed {
		return expected(message)
	}
	result, err := d.Engine.ResolveSemanticOutcomeCase(ctx, engine.ResolveSemanticOutcomeInput{
		Auth: d.auditContext(), CaseID: args.CaseID, ExpectedRevision: args.ExpectedRevision,
		CandidateArtifactID: args.CandidateArtifactID, ValidationArtifactID: args.ValidationArtifactID,
	})
	if err != nil {
		return mcpRecoveryError(err)
	}
	return ok(map[string]any{
		"runId": result.RunID, "sourceNodeId": result.SourceNodeID,
		"decision": result.Decision, "resumed": result.Resumed,
		"resolvedCaseIds": result.ResolvedCaseIDs,
	})
}

func mcpRecoveryError(err error) (*mcp.CallToolResult, any, error) {
	switch {
	case errors.Is(err, engine.ErrRecoveryCaseNotFound):
		return expected("recovery case not found")
	case errors.Is(err, engine.ErrRecoveryCaseConflict),
		errors.Is(err, engine.ErrRecoveryCaseReceiptGone),
		errors.Is(err, engine.ErrRecoveryApprovalMissing):
		return expected("recovery case conflict")
	case errors.Is(err, engine.ErrRecoveryArtifactTooLarge):
		return expected("recovery artifact exceeds 64000 bytes")
	case errors.Is(err, engine.ErrRecoverySemanticInputInvalid):
		return expected("recovery request is invalid")
	case errors.Is(err, engine.ErrRecoveryPolicyBlocked):
		return expected("recovery policy blocks this action")
	case errors.Is(err, engine.ErrRecoverySemanticOutputInvalid):
		return expected("recovery candidate failed deterministic validation")
	default:
		// Do not surface SQL/provider evidence through the MCP transport.
		return expected("recovery operation failed")
	}
}

func validMCPCaseID(caseID string) bool {
	return validMCPIdentifier(caseID)
}

func validMCPArtifactID(artifactID string) bool {
	return validMCPIdentifier(artifactID)
}

func mcpRecoveryDetailView(detail engine.RecoveryCaseDetail) map[string]any {
	transitions := make([]map[string]any, 0, len(detail.Transitions))
	for _, row := range detail.Transitions {
		transitions = append(transitions, map[string]any{
			"id": row.ID, "fromState": row.FromState, "toState": row.ToState,
			"actorKind": row.ActorKind, "occurredAt": row.OccurredAt,
		})
	}
	artifacts := make([]map[string]any, 0, len(detail.Artifacts))
	for _, row := range detail.Artifacts {
		artifacts = append(artifacts, mcpRecoveryArtifactView(row))
	}
	return map[string]any{
		"case": mcpRecoveryCaseView(detail.Case), "transitions": transitions,
		"artifacts": artifacts, "autonomy": detail.Autonomy,
		"approvalRequiredOutsideMcp": detail.Case.State == "awaiting_approval",
	}
}

func mcpRecoveryCaseView(row store.RecoveryCase) map[string]any {
	workflowID := ""
	if row.WorkflowID.Valid {
		workflowID = row.WorkflowID.String
	}
	return map[string]any{
		"id": row.ID, "runId": row.RunID, "workflowId": workflowID,
		"workflowVersionId": row.WorkflowVersionID,
		"source":            row.Source, "detectorId": row.DetectorID,
		"sourceNodeId": row.SourceNodeID, "detectorKind": row.DetectorKind,
		"action": row.Action, "state": row.State, "revision": row.Revision,
		"createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt, "resolvedAt": row.ResolvedAt,
	}
}

func mcpRecoveryArtifactView(row store.RecoveryCaseArtifact) map[string]any {
	view := map[string]any{
		"id": row.ID, "kind": row.Kind, "sha256": row.PayloadSha256,
		"actorKind": row.ActorKind, "createdAt": row.CreatedAt,
	}
	switch row.Kind {
	case "candidate":
		candidate, err := engine.ParseSemanticRecoveryCandidatePayload(row.PayloadJson)
		if err == nil {
			candidateView := map[string]any{
				"kind": candidate.Kind, "decision": candidate.Decision,
				"risk":                candidate.Risk,
				"expectedResult":      boundedMCPText(candidate.ExpectedResult, 500),
				"requiredPermissions": stringSliceView(candidate.RequiredPermissions, 4, 80),
				"evidenceCount":       len(candidate.Evidence), "outputWithheld": candidate.Output != nil,
			}
			if candidate.Target != nil {
				candidateView["target"] = map[string]any{
					"workflowId":        candidate.Target.WorkflowID,
					"workflowVersionId": candidate.Target.WorkflowVersionID,
					"detectorId":        candidate.Target.DetectorID,
				}
			}
			view["candidate"] = candidateView
		}
	case "validation":
		validation, err := engine.ParseSemanticRecoveryValidationPayload(row.PayloadJson)
		if err == nil {
			view["validation"] = map[string]any{
				"candidateArtifactId": validation.CandidateArtifactID,
				"candidateSha256":     validation.CandidateSha256,
				"caseRevision":        validation.CaseRevision, "passed": validation.Passed,
				"summary": boundedMCPText(validation.Summary, 500),
			}
		}
	case "diagnosis":
		view["diagnosis"] = mcpDiagnosisSummary(row.PayloadJson)
	}
	return view
}

func mcpDiagnosisSummary(raw json.RawMessage) map[string]any {
	view := map[string]any{"hypotheses": []any{}}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return view
	}
	if mode, _ := payload["mode"].(string); mode != "" {
		view["mode"] = boundedMCPText(mode, 80)
	}
	rawHypotheses, _ := payload["hypotheses"].([]any)
	hypotheses := make([]map[string]any, 0, min(len(rawHypotheses), 3))
	for _, rawHypothesis := range rawHypotheses[:min(len(rawHypotheses), 3)] {
		hypothesis, _ := rawHypothesis.(map[string]any)
		evidence, _ := hypothesis["evidenceRefs"].([]any)
		counter, _ := hypothesis["counterEvidenceRefs"].([]any)
		hypotheses = append(hypotheses, map[string]any{
			"id":            boundedMCPText(scalarString(hypothesis["id"]), 160),
			"confidence":    hypothesis["confidence"],
			"evidenceCount": len(evidence), "counterEvidenceCount": len(counter),
		})
	}
	view["hypotheses"] = hypotheses
	return view
}

func stringSliceView(values []string, limit, maxRunes int) []string {
	limit = min(len(values), limit)
	out := make([]string, 0, limit)
	for _, value := range values[:limit] {
		out = append(out, boundedMCPText(value, maxRunes))
	}
	return out
}

func sortedStringSet(values map[string]bool) []string {
	out := make([]string, 0, len(values))
	for value := range values {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}
