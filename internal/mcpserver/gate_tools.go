package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/publishgate"
	"github.com/johnny4young/janusly/internal/store"
)

func init() {
	for _, action := range []audit.Action{"workflow.draft_saved", "workflow.qualified", "workflow.published", "publish_request.created"} {
		audit.RegisterRuntimeAction(action)
	}
}

const (
	maxQualificationsPerHour = 30
	maxDraftRunsPerHour      = 120
)

var credentialNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,127}$`)

// gateError is the machine-repairable failure the gate tools return: a closed
// code, the argument path, and one imperative fix.
func gateError(code, message, path, fix string) (*mcp.CallToolResult, any, error) {
	body := map[string]any{"code": code, "message": message}
	if path != "" {
		body["path"] = path
	}
	if fix != "" {
		body["fix"] = fix
	}
	raw, _ := json.Marshal(map[string]any{"error": body})
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}}}, nil, nil
}

func (d Deps) gate() publishgate.Gate {
	return publishgate.Gate{Engine: d.Engine, Pool: d.Pool, NewID: d.NewID}
}

type draftSaveArgs struct {
	WorkflowID string                `json:"workflowId,omitempty" jsonschema:"an existing workflow to change; omit to propose a new workflow, whose id the server assigns"`
	Workflow   map[string]any        `json:"workflow" jsonschema:"the full workflow document"`
	Fixtures   []publishgate.Fixture `json:"fixtures,omitempty" jsonschema:"behaviour fixtures, each run with writes suppressed; at most 20"`
}

type draftRefArgs struct {
	DraftID string `json:"draftId" jsonschema:"a draft id from drafts.save"`
}

type draftsListArgs struct {
	WorkflowID string `json:"workflowId,omitempty" jsonschema:"only drafts of this workflow"`
	Limit      int    `json:"limit,omitempty" jsonschema:"maximum rows to return (default 20, max 100)"`
	Cursor     string `json:"cursor,omitempty" jsonschema:"keyset cursor from a previous page's nextCursor"`
}

type draftTestArgs struct {
	DraftID string         `json:"draftId" jsonschema:"the draft to run with writes suppressed"`
	Input   map[string]any `json:"input,omitempty" jsonschema:"run input"`
	Stubs   map[string]any `json:"stubs,omitempty" jsonschema:"stand-in outputs by step id; approvals, forms and routers cannot take one"`
}

type qualificationArgs struct {
	QualificationID string `json:"qualificationId" jsonschema:"a qualification id from workflows.qualify"`
}

type publishArgs struct {
	DraftID         string `json:"draftId" jsonschema:"the qualified draft"`
	QualificationID string `json:"qualificationId" jsonschema:"its passed qualification"`
}

type publishStatusArgs struct {
	PublishRequestID string `json:"publishRequestId" jsonschema:"a publish request id from workflows.publish"`
}

type credentialRequestArgs struct {
	Name string `json:"name" jsonschema:"the credential name the workflow references"`
	Kind string `json:"kind,omitempty" jsonschema:"optional credential kind, such as http_bearer"`
}

func registerGateTools(server *mcp.Server, deps Deps) {
	mcp.AddTool(server, writeTool("drafts.save", "Save draft",
		"Store a draft of a new or existing workflow with its behaviour fixtures. A draft never runs in production; workflows.qualify then workflows.publish.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args draftSaveArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).saveDraft(ctx, args)
	})
	mcp.AddTool(server, readTool("drafts.get", "Get draft",
		"Read one draft: its document, fixtures, digest and the version it was drafted from.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args draftRefArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).getDraft(ctx, args.DraftID)
	})
	mcp.AddTool(server, readTool("drafts.list", "List drafts",
		"List the organization's drafts newest first, keyset-paginated; optional workflowId filter.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args draftsListArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).listDrafts(ctx, args)
	})
	mcp.AddTool(server, writeTool("workflows.test", "Test draft",
		"Run a draft as a validation run: every write is suppressed and stubs replace the steps they name. Returns a run id for runs.status and runs.output.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args draftTestArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).testDraft(ctx, args)
	})
	mcp.AddTool(server, writeTool("workflows.qualify", "Qualify draft",
		"Run the publish gate on a draft: structure, readiness, contracts, credentials, secret literals and every behaviour fixture. Returns a qualification to poll with qualifications.get.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args draftRefArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).qualifyDraft(ctx, args.DraftID)
	})
	mcp.AddTool(server, readTool("qualifications.get", "Get qualification",
		"Read a qualification: running, passed or failed, with every check's code, path and fix.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args qualificationArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).getQualification(ctx, args.QualificationID)
	})
	mcp.AddTool(server, writeTool("workflows.publish", "Publish draft",
		"Publish a qualified draft. An additive read-only change to a published workflow is published at once; a workflow that writes or was never published, or a change that removes or changes triggers, or removes steps or outputs, waits for a person's approval.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args publishArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).publishDraft(ctx, args)
	})
	mcp.AddTool(server, readTool("publish.status", "Publish status",
		"Read a publish request: pending, published, rejected, expired or superseded, and the published version.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args publishStatusArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).publishStatus(ctx, args.PublishRequestID)
	})
	mcp.AddTool(server, readTool("credentials.request", "Request credential",
		"Get the link where a person creates a credential the workflow needs. No tool accepts a secret value.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args credentialRequestArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).requestCredential(ctx, args)
	})
}

// draftVisible: the drafter always sees its drafts; others need the workflow
// to be in scope.
func (d Deps) draftVisible(ctx context.Context, draft store.WorkflowDraft) (bool, error) {
	if draft.CreatedBy == d.UserID {
		return true, nil
	}
	return d.workflowVisible(ctx, draft.WorkflowID)
}

func (d Deps) loadDraft(ctx context.Context, draftID string) (store.WorkflowDraft, *mcp.CallToolResult, error) {
	notFound := func() (store.WorkflowDraft, *mcp.CallToolResult, error) {
		result, _, _ := gateError("not_found", "draft not found", "/draftId", "drafts.list shows your drafts.")
		return store.WorkflowDraft{}, result, nil
	}
	if !validMCPIdentifier(draftID) {
		return notFound()
	}
	draft, err := store.New(d.Pool).GetWorkflowDraft(ctx, store.GetWorkflowDraftParams{OrgID: d.OrgID, ID: draftID})
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound()
	}
	if err != nil {
		return store.WorkflowDraft{}, nil, err
	}
	if visible, err := d.draftVisible(ctx, draft); err != nil {
		return store.WorkflowDraft{}, nil, err
	} else if !visible {
		return notFound()
	}
	return draft, nil, nil
}

// loadActionableDraft is loadDraft for tools that act on a draft: a draft of
// an existing workflow needs that workflow in scope now, not only when it was
// drafted; a draft of a new workflow must be the caller's own.
func (d Deps) loadActionableDraft(ctx context.Context, draftID string) (store.WorkflowDraft, *mcp.CallToolResult, error) {
	draft, refused, err := d.loadDraft(ctx, draftID)
	if refused != nil || err != nil {
		return draft, refused, err
	}
	exists, err := store.New(d.Pool).WorkflowExistsInOrg(ctx, store.WorkflowExistsInOrgParams{OrgID: d.OrgID, ID: draft.WorkflowID})
	if err != nil {
		return draft, nil, err
	}
	visible := draft.CreatedBy == d.UserID
	if exists {
		if visible, err = d.workflowVisible(ctx, draft.WorkflowID); err != nil {
			return draft, nil, err
		}
	}
	if !visible {
		result, _, _ := gateError("not_found", "draft not found", "/draftId", "drafts.list shows your drafts.")
		return store.WorkflowDraft{}, result, nil
	}
	return draft, nil, nil
}

func (d Deps) saveDraft(ctx context.Context, args draftSaveArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "drafts.save", "workflows.write", false); !allowed {
		return expected(message)
	}
	raw, err := json.Marshal(args.Workflow)
	if err != nil || len(raw) > maxMCPWorkflowDocumentBytes {
		return gateError("invalid_argument", "workflow document is invalid or exceeds 128000 bytes", "/workflow", "Send one workflow document.")
	}
	wf, _ := domain.Parse(raw)
	if wf == nil {
		return expectedReport("workflow contract invalid", d.validationReport(ctx, args.Workflow))
	}
	q := store.New(d.Pool)
	workflowID, newWorkflow := strings.TrimSpace(args.WorkflowID), args.WorkflowID == ""
	baseVersion := pgtype.Text{}
	if newWorkflow {
		if principal := d.agent(); principal != nil && principal.Scoped() && len(principal.ScopeTags) == 0 {
			return gateError("permission_denied", "a client scoped to listed workflows cannot create one", "/workflowId",
				"Pass a workflowId in scope, or ask for a client scoped by tag.")
		}
		workflowID = "wf_" + uuid.NewString()
	} else {
		if !validMCPIdentifier(workflowID) {
			return gateError("invalid_argument", "workflowId must be at most 256 characters", "/workflowId", "")
		}
		exists, err := q.WorkflowExistsInOrg(ctx, store.WorkflowExistsInOrgParams{OrgID: d.OrgID, ID: workflowID})
		if err != nil {
			return nil, nil, err
		}
		visible := false
		if exists {
			visible, err = d.workflowVisible(ctx, workflowID)
		} else {
			// A new workflow this caller drafted before: another revision of it.
			visible, err = q.DraftedWorkflowBy(ctx, store.DraftedWorkflowByParams{OrgID: d.OrgID, WorkflowID: workflowID, CreatedBy: d.UserID})
			newWorkflow = visible
		}
		if err != nil {
			return nil, nil, err
		}
		if !visible {
			return gateError("not_found", "workflow not found", "/workflowId", "workflows.list shows the workflows you can change; omit workflowId to propose a new one.")
		}
		latest, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{WorkflowID: workflowID, OrgID: d.OrgID})
		switch {
		case err == nil:
			baseVersion = pgtype.Text{String: latest.ID, Valid: true}
		case !errors.Is(err, pgx.ErrNoRows):
			return nil, nil, err
		}
	}
	wf.ID = workflowID
	if wf.Name == "" {
		wf.Name = workflowID
	}
	document, err := domain.CanonicalWorkflowDocument(wf)
	if err != nil {
		return gateError("invalid_argument", "workflow document cannot be normalized", "/workflow", "")
	}
	rawFixtures, _ := json.Marshal(args.Fixtures)
	fixtures, problems := publishgate.ParseFixtures(rawFixtures, wf)
	if len(problems) > 0 {
		return gateChecksError("fixtures are invalid", problems)
	}
	digest, err := publishgate.Digest(baseVersion.String, document, fixtures)
	if err != nil {
		return nil, nil, err
	}
	rawFixtures, _ = json.Marshal(fixtures)
	draft, err := q.InsertWorkflowDraft(ctx, store.InsertWorkflowDraftParams{
		ID: "draft_" + uuid.NewString(), OrgID: d.OrgID, WorkflowID: workflowID, BaseVersionID: baseVersion,
		Document: document, Fixtures: rawFixtures, Digest: digest, CreatedBy: d.UserID,
	})
	unchanged := false
	if errors.Is(err, pgx.ErrNoRows) {
		unchanged = true
		draft, err = q.GetWorkflowDraftByDigest(ctx, store.GetWorkflowDraftByDigestParams{
			OrgID: d.OrgID, WorkflowID: workflowID, CreatedBy: d.UserID, Digest: digest,
		})
	}
	if err != nil {
		return nil, nil, err
	}
	if !unchanged {
		d.Audit.Write(ctx, d.Pool, d.auditContext(), "workflow.draft_saved", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{"draftId": draft.ID, "fixtures": len(fixtures), "newWorkflow": newWorkflow},
		})
	}
	var validated map[string]any
	_ = json.Unmarshal(document, &validated)
	return ok(map[string]any{
		"draftId": draft.ID, "workflowId": workflowID, "digest": digest, "unchanged": unchanged,
		"newWorkflow": newWorkflow, "fixtures": len(fixtures), "validation": d.validationReport(ctx, validated),
		"next": "workflows.test to try a case, workflows.qualify to run the gate",
	})
}

func gateChecksError(message string, checks []publishgate.Check) (*mcp.CallToolResult, any, error) {
	raw, _ := json.Marshal(map[string]any{"error": map[string]any{"code": "validation_failed", "message": message, "issues": checks}})
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}}}, nil, nil
}

func (d Deps) getDraft(ctx context.Context, draftID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "drafts.get", "workflows.read", false); !allowed {
		return expected(message)
	}
	draft, refused, err := d.loadDraft(ctx, draftID)
	if refused != nil || err != nil {
		return refused, nil, err
	}
	var document, fixtures any
	_ = json.Unmarshal(draft.Document, &document)
	_ = json.Unmarshal(draft.Fixtures, &fixtures)
	return ok(map[string]any{
		"draftId": draft.ID, "workflowId": draft.WorkflowID, "digest": draft.Digest,
		"baseVersionId": draft.BaseVersionID.String, "createdBy": draft.CreatedBy,
		"createdAt": draft.CreatedAt.UTC().Format(time.RFC3339Nano),
		"document":  scrubSecretShapes(document), "fixtures": scrubSecretShapes(fixtures),
	})
}

func (d Deps) listDrafts(ctx context.Context, args draftsListArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "drafts.list", "workflows.read", false); !allowed {
		return expected(message)
	}
	if !validOptionalMCPCursor(args.Cursor) || !validOptionalMCPIdentifier(args.WorkflowID) {
		return expected("drafts list cursor or workflowId exceeds its bounded length")
	}
	page, problem := pageBounds(args.Limit, args.Cursor)
	if problem != "" {
		return expected(problem)
	}
	params := store.ListWorkflowDraftsParams{
		OrgID: d.OrgID, FilterWorkflowID: pgtype.Text{String: args.WorkflowID, Valid: args.WorkflowID != ""},
		Self: d.UserID, BeforeCreatedAt: page.before, BeforeID: page.beforeID, PageLimit: page.limit + 1,
	}
	if d.scoped() {
		ids, err := d.scopeList(ctx)
		if err != nil {
			return nil, nil, err
		}
		params.ScopeWorkflowIds = ids
	}
	rows, err := store.New(d.Pool).ListWorkflowDrafts(ctx, params)
	if err != nil {
		return nil, nil, err
	}
	hasMore := len(rows) > int(page.limit)
	if hasMore {
		rows = rows[:page.limit]
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{
			"draftId": row.ID, "workflowId": row.WorkflowID, "digest": row.Digest,
			"baseVersionId": row.BaseVersionID.String, "createdBy": row.CreatedBy,
			"createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	payload := map[string]any{"drafts": items, "hasMore": hasMore}
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		payload["nextCursor"] = last.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" + last.ID
	}
	return ok(payload)
}

func (d Deps) testDraft(ctx context.Context, args draftTestArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.test", "runs.start", false); !allowed {
		return expected(message)
	}
	draft, refused, err := d.loadActionableDraft(ctx, args.DraftID)
	if refused != nil || err != nil {
		return refused, nil, err
	}
	if recent, err := store.New(d.Pool).CountRecentAgentDraftRuns(ctx, store.CountRecentAgentDraftRunsParams{
		OrgID: d.OrgID, CreatedBy: pgtype.Text{String: d.UserID, Valid: true},
	}); err != nil {
		return nil, nil, err
	} else if recent >= maxDraftRunsPerHour {
		return gateError("rate_limited", "at most 120 draft and fixture runs per hour", "", "Stub more steps and test fewer cases at a time.")
	}
	wf, _, _, err := publishgate.DraftWorkflow(draft)
	if err != nil {
		return nil, nil, err
	}
	fixture := publishgate.Fixture{Name: "test", Input: args.Input, Stubs: args.Stubs, Expect: publishgate.Expectation{Status: "succeeded"}}
	rawFixture, _ := json.Marshal([]publishgate.Fixture{fixture})
	_, problems := publishgate.ParseFixtures(rawFixture, wf)
	for _, nodeID := range publishgate.StubRequired(wf) {
		if _, stubbed := args.Stubs[nodeID]; !stubbed {
			problems = append(problems, publishgate.Check{Code: "stub_required", Status: "failed", Path: "/stubs/" + nodeID,
				Message: "this step reaches outside Janusly or reads a secret, so it does not run before a person approves the workflow",
				Fix:     "Pass a stand-in output for it in stubs."})
		}
	}
	if len(problems) > 0 {
		return gateChecksError("the test cannot run as asked", problems)
	}
	runs, err := d.gate().StartFixtureRuns(ctx, d.OrgID, d.UserID, wf, []publishgate.Fixture{fixture})
	if err != nil {
		return nil, nil, err
	}
	if runs[0].RunID == "" {
		return gateError("validation_failed", runs[0].Detail, "/draftId", "Fix the draft and save it again.")
	}
	return ok(map[string]any{"runId": runs[0].RunID, "writesSuppressed": true,
		"next": "runs.status until it ends, then runs.output"})
}

func (d Deps) qualifyDraft(ctx context.Context, draftID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.qualify", "runs.start", false); !allowed {
		return expected(message)
	}
	draft, refused, err := d.loadActionableDraft(ctx, draftID)
	if refused != nil || err != nil {
		return refused, nil, err
	}
	q := store.New(d.Pool)
	if recent, err := q.CountRecentDraftQualifications(ctx, store.CountRecentDraftQualificationsParams{OrgID: d.OrgID, CreatedBy: d.UserID}); err != nil {
		return nil, nil, err
	} else if recent >= maxQualificationsPerHour {
		return gateError("rate_limited", "at most 30 qualifications per hour", "", "Fix every reported check before qualifying again.")
	}
	wf, document, fixtures, err := publishgate.DraftWorkflow(draft)
	if err != nil {
		return nil, nil, err
	}
	catalog, err := d.tenantCatalog(ctx)
	if err != nil {
		return nil, nil, err
	}
	checks := publishgate.StaticChecks(wf, document, fixtures, catalog)
	runs := []publishgate.FixtureRun{}
	status := "failed"
	var completedAt *time.Time
	if publishgate.Passed(checks) {
		if recent, err := q.CountRecentAgentDraftRuns(ctx, store.CountRecentAgentDraftRunsParams{
			OrgID: d.OrgID, CreatedBy: pgtype.Text{String: d.UserID, Valid: true},
		}); err != nil {
			return nil, nil, err
		} else if int(recent)+len(fixtures) > maxDraftRunsPerHour {
			return gateError("rate_limited", "at most 120 draft and fixture runs per hour", "", "Qualify again later or with fewer fixtures.")
		}
		if runs, err = d.gate().StartFixtureRuns(ctx, d.OrgID, d.UserID, wf, fixtures); err != nil {
			return nil, nil, err
		}
		status = "running"
	} else {
		now := time.Now()
		completedAt = &now
	}
	rawChecks, _ := json.Marshal(checks)
	rawRuns, _ := json.Marshal(runs)
	receipt, err := q.InsertDraftQualification(ctx, store.InsertDraftQualificationParams{
		ID: "qual_" + uuid.NewString(), OrgID: d.OrgID, DraftID: draft.ID, Digest: draft.Digest,
		Status: status, Checks: rawChecks, FixtureRuns: rawRuns, CreatedBy: d.UserID, CompletedAt: completedAt,
	})
	if err != nil {
		return nil, nil, err
	}
	if receipt, err = d.gate().Settle(ctx, receipt, fixtures); err != nil {
		return nil, nil, err
	}
	d.Audit.Write(ctx, d.Pool, d.auditContext(), "workflow.qualified", audit.Options{
		TargetType: "workflow", TargetID: draft.WorkflowID,
		Metadata: map[string]any{"draftId": draft.ID, "qualificationId": receipt.ID, "status": receipt.Status},
	})
	return ok(qualificationView(receipt))
}

func qualificationView(receipt store.DraftQualification) map[string]any {
	var checks, runs any
	_ = json.Unmarshal(receipt.Checks, &checks)
	_ = json.Unmarshal(receipt.FixtureRuns, &runs)
	view := map[string]any{
		"qualificationId": receipt.ID, "draftId": receipt.DraftID, "digest": receipt.Digest,
		"status": receipt.Status, "checks": checks, "fixtureRuns": runs,
		"createdAt": receipt.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
	switch receipt.Status {
	case "running":
		view["next"] = "qualifications.get until it settles"
	case "passed":
		view["next"] = "workflows.publish with this qualificationId"
	default:
		view["next"] = "fix every failed check, drafts.save, then workflows.qualify again"
	}
	return view
}

func (d Deps) getQualification(ctx context.Context, qualificationID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "qualifications.get", "workflows.read", false); !allowed {
		return expected(message)
	}
	receipt, draft, refused, err := d.loadReceipt(ctx, qualificationID)
	if refused != nil || err != nil {
		return refused, nil, err
	}
	_, _, fixtures, err := publishgate.DraftWorkflow(draft)
	if err != nil {
		return nil, nil, err
	}
	if receipt, err = d.gate().Settle(ctx, receipt, fixtures); err != nil {
		return nil, nil, err
	}
	return ok(qualificationView(receipt))
}

func (d Deps) loadReceipt(ctx context.Context, qualificationID string) (store.DraftQualification, store.WorkflowDraft, *mcp.CallToolResult, error) {
	notFound := func() (store.DraftQualification, store.WorkflowDraft, *mcp.CallToolResult, error) {
		result, _, _ := gateError("not_found", "qualification not found", "/qualificationId", "workflows.qualify returns one.")
		return store.DraftQualification{}, store.WorkflowDraft{}, result, nil
	}
	if !validMCPIdentifier(qualificationID) {
		return notFound()
	}
	receipt, err := store.New(d.Pool).GetDraftQualification(ctx, store.GetDraftQualificationParams{OrgID: d.OrgID, ID: qualificationID})
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound()
	}
	if err != nil {
		return store.DraftQualification{}, store.WorkflowDraft{}, nil, err
	}
	draft, refused, err := d.loadDraft(ctx, receipt.DraftID)
	if err != nil {
		return store.DraftQualification{}, store.WorkflowDraft{}, nil, err
	}
	if refused != nil {
		return notFound()
	}
	return receipt, draft, nil, nil
}

func (d Deps) publishDraft(ctx context.Context, args publishArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.publish", "workflows.write", true); !allowed {
		return expected(message)
	}
	receipt, draft, refused, err := d.loadReceipt(ctx, args.QualificationID)
	if refused != nil || err != nil {
		return refused, nil, err
	}
	if _, refused, err := d.loadActionableDraft(ctx, draft.ID); refused != nil || err != nil {
		return refused, nil, err
	}
	if draft.ID != args.DraftID {
		return gateError("invalid_argument", "the qualification belongs to another draft", "/qualificationId", "Pass the qualification workflows.qualify returned for this draft.")
	}
	gate := d.gate()
	if receipt, err = gate.UsableReceipt(ctx, draft, receipt); errors.Is(err, publishgate.ErrReceiptNotUsable) {
		return gateError("qualification_failed", "the qualification is "+receipt.Status+", stale or for another digest", "/qualificationId",
			"Run workflows.qualify on this draft and publish when it passes.")
	} else if err != nil {
		return nil, nil, err
	}
	wf, _, _, err := publishgate.DraftWorkflow(draft)
	if err != nil {
		return nil, nil, err
	}
	q := store.New(d.Pool)
	reasons, shrink, err := publishgate.Reasons(ctx, q, d.OrgID, draft.WorkflowID, wf)
	if err != nil {
		return nil, nil, err
	}
	if len(reasons) == 0 {
		saved, err := gate.Publish(ctx, publishgate.PublishInput{OrgID: d.OrgID, Actor: d.UserID, Draft: draft})
		if err != nil {
			return publishFailure(err)
		}
		d.Audit.Write(ctx, d.Pool, d.auditContext(), "workflow.published", audit.Options{
			TargetType: "workflow", TargetID: draft.WorkflowID,
			Metadata: map[string]any{"draftId": draft.ID, "qualificationId": receipt.ID, "version": saved.Version, "approval": "not_required"},
		})
		return ok(map[string]any{"status": "published", "workflowId": draft.WorkflowID, "versionId": saved.VersionID, "version": saved.Version})
	}
	return d.requestPublication(ctx, draft, receipt, reasons, shrink)
}

var reasonText = map[string]string{
	"first_publish":    "the workflow was never published",
	"writes":           "a step may change something outside Janusly",
	"outbound":         "a step or trigger reaches outside Janusly",
	"callers":          "other workflows call this one",
	"triggers_changed": "it removes, adds or changes triggers of the live version",
	"steps_removed":    "it removes steps of the live version",
	"outputs_removed":  "it removes outputs of the live version",
}

func publishWaitMessage(reasons []string) string {
	parts := make([]string, 0, len(reasons))
	for _, reason := range reasons {
		text, known := reasonText[reason]
		if !known {
			text = reason
		}
		parts = append(parts, text)
	}
	return "A person must approve this publication because " + strings.Join(parts, "; ") +
		". The live version keeps running unchanged until then."
}

func (d Deps) requestPublication(ctx context.Context, draft store.WorkflowDraft, receipt store.DraftQualification, reasons []string, shrink publishgate.Shrink) (*mcp.CallToolResult, any, error) {
	q := store.New(d.Pool)
	onBehalfOf := d.UserID
	if principal := d.agent(); principal != nil {
		onBehalfOf = principal.CreatedBy
	}
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The same lock a person's decision takes, so superseding never lands in
	// the middle of an approval.
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended('publish_workflow:' || $1 || ':' || $2, 0))`,
		d.OrgID, draft.WorkflowID).Scan(&locked); err != nil {
		return nil, nil, err
	}
	if !locked {
		return gateError("conflict", "a person is deciding a publish request for this workflow", "", "Retry workflows.publish in a moment.")
	}
	qtx := q.WithTx(tx)
	if err := qtx.SupersedePublishRequests(ctx, store.SupersedePublishRequestsParams{OrgID: d.OrgID, WorkflowID: draft.WorkflowID}); err != nil {
		return nil, nil, err
	}
	request, err := qtx.InsertPublishRequest(ctx, store.InsertPublishRequestParams{
		ID: "pub_" + uuid.NewString(), OrgID: d.OrgID, WorkflowID: draft.WorkflowID, DraftID: draft.ID,
		QualificationID: receipt.ID, Reasons: reasons, RequestedBy: d.UserID, OnBehalfOf: onBehalfOf,
		DraftedBy: draft.CreatedBy, ScopeTag: publishgate.OptionalText(d.scopeTag()),
		ExpiresAt: time.Now().Add(publishgate.RequestLifetime),
	})
	if err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	d.Audit.Write(ctx, d.Pool, d.auditContext(), "publish_request.created", audit.Options{
		TargetType: "workflow", TargetID: draft.WorkflowID,
		Metadata: map[string]any{"publishRequestId": request.ID, "draftId": draft.ID, "reasons": reasons},
	})
	view := map[string]any{
		"status": "approval_required", "workflowId": draft.WorkflowID, "publishRequestId": request.ID,
		"reasons": reasons, "message": publishWaitMessage(reasons), "expiresAt": request.ExpiresAt.UTC().Format(time.RFC3339),
		"next": "a person with workflows.write approves it in Janusly; poll publish.status",
	}
	if !shrink.Empty() {
		view["changes"] = shrink
	}
	return ok(view)
}

// scopeTag keeps a workflow a scoped client creates inside its scope.
func (d Deps) scopeTag() string {
	if principal := d.agent(); principal != nil && len(principal.ScopeTags) > 0 {
		return principal.ScopeTags[0]
	}
	return ""
}

func publishFailure(err error) (*mcp.CallToolResult, any, error) {
	switch {
	case errors.Is(err, publishgate.ErrStaleBase):
		return gateError("conflict", "the workflow changed since this draft", "/draftId",
			"Read the current version with workflows.get, draft again from it, and qualify the new draft.")
	case errors.Is(err, engine.ErrWorkflowSaveRolloutActive):
		return gateError("conflict", "an active rollout blocks a new version", "", "Finish the rollout, then publish.")
	case errors.Is(err, engine.ErrWorkflowSaveConflict):
		return gateError("conflict", "a concurrent save changed the workflow", "", "Retry workflows.publish.")
	case errors.Is(err, engine.ErrWorkflowSaveNotFound), errors.Is(err, engine.ErrWorkflowSaveIDTaken):
		return gateError("not_found", "workflow not found", "/draftId", "")
	default:
		return nil, nil, err
	}
}

func (d Deps) publishStatus(ctx context.Context, requestID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "publish.status", "workflows.read", false); !allowed {
		return expected(message)
	}
	notFound := func() (*mcp.CallToolResult, any, error) {
		return gateError("not_found", "publish request not found", "/publishRequestId", "workflows.publish returns one.")
	}
	if !validMCPIdentifier(requestID) {
		return notFound()
	}
	q := store.New(d.Pool)
	request, err := q.GetPublishRequest(ctx, store.GetPublishRequestParams{OrgID: d.OrgID, ID: requestID})
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound()
	}
	if err != nil {
		return nil, nil, err
	}
	if request.RequestedBy != d.UserID {
		if visible, err := d.workflowVisible(ctx, request.WorkflowID); err != nil {
			return nil, nil, err
		} else if !visible {
			return notFound()
		}
	}
	status := request.Status
	if status == "pending" && !time.Now().Before(request.ExpiresAt) {
		status = "expired"
	}
	view := map[string]any{
		"publishRequestId": request.ID, "workflowId": request.WorkflowID, "draftId": request.DraftID,
		"status": status, "reasons": request.Reasons, "expiresAt": request.ExpiresAt.UTC().Format(time.RFC3339),
	}
	if request.PublishedVersionID.Valid {
		view["versionId"] = request.PublishedVersionID.String
	}
	if request.DecidedAt != nil {
		view["decidedAt"] = request.DecidedAt.UTC().Format(time.RFC3339)
	}
	// The person's reason, so an agent can fix a rejected draft.
	if request.DecisionReason.Valid {
		view["reason"] = request.DecisionReason.String
	}
	return ok(view)
}

func (d Deps) requestCredential(ctx context.Context, args credentialRequestArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "credentials.request", "workflows.write", false); !allowed {
		return expected(message)
	}
	name := strings.TrimSpace(args.Name)
	if !credentialNamePattern.MatchString(name) {
		return gateError("invalid_argument", "name must start with a letter and use letters, digits, . _ or -", "/name", "")
	}
	return ok(map[string]any{
		"name": name, "kind": strings.TrimSpace(args.Kind),
		"setupUrl": strings.TrimRight(d.WebBaseURL, "/") + "/#/credentials",
		"message":  "A person creates this credential in Janusly; you never receive its value. Reference it by name, then qualify again.",
	})
}
