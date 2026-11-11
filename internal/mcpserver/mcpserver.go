// The runtime's MCP surface: a thin in-process layer over the engine — no
// HTTP hop — exposing the operator loop to agents. Results return as JSON
// text plus structuredContent; EXPECTED failures (conflicts, not-found,
// validation) come back as isError tool results, matching the contract
// MCP server's posture, while transport/programming errors propagate.
package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/runstart"
	"github.com/johnny4young/janusly/internal/store"
	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

const (
	maxMCPRequestBytes  = 256_000
	maxMCPResponseBytes = 256_000
)

// Deps carries the in-process dependencies every tool shares.
type Deps struct {
	Audit  audit.Writer
	Engine *engine.Engine
	Pool   *pgxpool.Pool
	OrgID  string
	UserID string
	NewID  func() string
	// Permissions is the explicit stdio service-account ceiling. Nil or an
	// absent key denies that authority; write consent never implies a grant.
	Permissions map[string]bool
	// CatalogSource supplies tenant-opted-in external MCP tools to the exact
	// authoring CapabilityCatalog. Nil degrades that category to empty.
	CatalogSource authoring.McpCatalogSource
	// Limiter bounds MCP writes per the contract's guardMcpWrite: bucket
	// `mcp.<actionKey>`, org key, 60/min. Nil skips the check (tests).
	Limiter *ratelimit.Limiter
	// ResolveActor, when set, makes every tools call act as the agent client
	// it authenticates instead of the operator fields above.
	ResolveActor ActorResolver
	// Transport labels audit rows: "stdio" or "http".
	Transport string
	// WebBaseURL prefixes the links tools hand to people.
	WebBaseURL string

	actor *callActor
}

// auditContext derives the audit identity for MCP-originated writes. An
// agent client is recorded as itself; the operator actor keeps the service
// token identity the MCP proxy has always used.
func (d Deps) auditContext() *auth.Context {
	if principal := d.agent(); principal != nil {
		return &auth.Context{OrgID: d.OrgID, UserID: d.UserID,
			Mode: auth.ModeAgent, Source: auth.SourceMcp, AgentClientID: principal.ClientID}
	}
	return &auth.Context{OrgID: d.OrgID, UserID: d.UserID,
		Mode: auth.ModeServiceToken, Source: auth.SourceMcp}
}

// NewServer builds the MCP server with the runtime's bounded operator tools.
func NewServer(deps Deps) *mcp.Server {
	if deps.Limiter == nil && deps.Pool != nil {
		deps.Limiter = ratelimit.New(deps.Pool, ratelimit.Hooks{})
	}
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "janusly",
		Title:   "Janusly",
		Version: "0.1.0",
	}, nil)
	server.AddReceivingMiddleware(deps.requestGuard)

	type saveArgs struct {
		Workflow map[string]any `json:"workflow" jsonschema:"the full workflow document to save as a new immutable version"`
	}
	mcp.AddTool(server, writeTool(
		"workflows.save", "Save workflow",
		"Validate a workflow document and save it as a new immutable version.", false,
	), func(ctx context.Context, req *mcp.CallToolRequest, args saveArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).saveWorkflow(ctx, args.Workflow)
	})

	mcp.AddTool(server, writeTool(
		"runs.start", "Start run",
		"Start a run from a saved workflowId or a workflow document; returns the run id. Pass idempotencyKey to make retries safe.", false,
	), func(ctx context.Context, req *mcp.CallToolRequest, args startArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).startRun(ctx, args)
	})

	type runArgs struct {
		RunID string `json:"runId" jsonschema:"the run to read"`
	}
	mcp.AddTool(server, readTool(
		"runs.status", "Run status",
		"Read a bounded run status projection: final status plus per-node status and attempts.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args runArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).runStatus(ctx, args.RunID)
	})
	mcp.AddTool(server, readTool(
		"runs.inspect", "Inspect run",
		"Read a bounded run projection with node status, redacted error summaries, and recent event types; never returns the workflow DAG or raw payloads.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args runArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).runInspect(ctx, args.RunID)
	})

	type pageArgs struct {
		Limit  int    `json:"limit,omitempty" jsonschema:"maximum rows to return (default 20, max 100)"`
		Cursor string `json:"cursor,omitempty" jsonschema:"keyset cursor from a previous page's nextCursor"`
	}
	type runsListArgs struct {
		Limit      int    `json:"limit,omitempty" jsonschema:"maximum rows to return (default 20, max 100)"`
		Cursor     string `json:"cursor,omitempty" jsonschema:"keyset cursor from a previous page's nextCursor"`
		WorkflowID string `json:"workflowId,omitempty" jsonschema:"only runs of this workflow"`
		Status     string `json:"status,omitempty" jsonschema:"only runs with this status (running, succeeded, failed, cancelled)"`
	}
	mcp.AddTool(server, readTool(
		"runs.list", "List runs",
		"List the organization's runs newest first, keyset-paginated; optional workflowId and status filters.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args runsListArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).runsList(ctx, args.Limit, args.Cursor, args.WorkflowID, args.Status)
	})
	mcp.AddTool(server, readTool(
		"workflows.list", "List workflows",
		"List the organization's active workflows newest first, keyset-paginated.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args pageArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).workflowsList(ctx, args.Limit, args.Cursor)
	})

	type assureArgs struct {
		WorkflowID string `json:"workflowId" jsonschema:"the active workflow whose latest immutable version should be inspected"`
	}
	mcp.AddTool(server, readTool(
		"workflows.assure", "Assure workflow",
		"Inspect the latest workflow version's Intent, Recovery, Qualification, validation, and readiness evidence without exposing its DAG or credentials.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args assureArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).assureWorkflow(ctx, args.WorkflowID)
	})

	mcp.AddTool(server, readTool(
		"dlq.list", "List dead letters",
		"List bounded dead-letter summaries for the organization newest first, keyset-paginated.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args pageArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).dlqList(ctx, args.Limit, args.Cursor)
	})

	type redriveArgs struct {
		DeadLetterID string `json:"deadLetterId" jsonschema:"the dead letter whose run should be revived"`
	}
	mcp.AddTool(server, writeTool(
		"dlq.redrive", "Redrive dead letter",
		"Claim one dead letter and revive its run: the failed node requeues and workers take over.", true,
	), func(ctx context.Context, req *mcp.CallToolRequest, args redriveArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).redrive(ctx, args.DeadLetterID)
	})

	registerAgentTools(server, deps)
	registerGateTools(server, deps)
	registerOperatorTools(server, deps)
	registerAuthoringTools(server, deps)
	registerLifecycleTools(server, deps)
	return server
}

// ok wraps a successful payload as JSON text + structuredContent.
func ok(payload any) (*mcp.CallToolResult, any, error) {
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	if len(raw) > maxMCPResponseBytes {
		return expected("MCP response exceeds the bounded response limit")
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}},
	}, payload, nil
}

// expected reports an EXPECTED failure as isError, keeping the session
// alive — agents read these and decide, they are not crashes.
func expected(message string) (*mcp.CallToolResult, any, error) {
	message = boundedMCPText(message, maxMCPErrorSummaryRunes)
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: message}},
	}, nil, nil
}

func (d Deps) saveWorkflow(ctx context.Context, document map[string]any) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.save", "workflows.write", true); !allowed {
		return expected(message)
	}
	raw, err := json.Marshal(document)
	if err != nil || len(raw) > maxMCPWorkflowDocumentBytes {
		return expected("workflow document is invalid or exceeds 128000 bytes")
	}
	wf, _ := domain.Parse(raw)
	if wf == nil {
		return expectedReport("workflow contract invalid", d.validationReport(ctx, document))
	}
	if !validOptionalMCPIdentifier(wf.ID) {
		return expected("workflow id must be at most 256 characters")
	}
	for _, issue := range workflowvalidation.Validate(wf).Issues {
		if issue.Code != domain.CodeNodeTypeNotExecutable {
			return expectedReport("workflow validation failed", d.validationReport(ctx, document))
		}
	}

	workflowID := wf.ID
	if workflowID == "" {
		if d.NewID == nil {
			return expected("workflow save is unavailable")
		}
		workflowID = d.NewID()
	}
	name := wf.Name
	if name == "" {
		name = workflowID
	}
	wf.ID = workflowID
	wf.Name = name
	committed, err := d.Engine.SaveWorkflowVersion(ctx, engine.SaveWorkflowVersionInput{
		OrgID: d.OrgID, UserID: d.UserID, Workflow: wf, NewID: d.NewID,
	})
	switch {
	case err == nil:
	case errors.Is(err, engine.ErrWorkflowSaveNotFound):
		return expected("workflow not found")
	case errors.Is(err, engine.ErrWorkflowSaveIDTaken):
		return expected("workflow id is already taken")
	case errors.Is(err, engine.ErrWorkflowSaveRolloutActive):
		return expected("finish the active workflow rollout before saving a new version")
	case errors.Is(err, engine.ErrWorkflowSaveConflict):
		return expected("concurrent workflow save conflict; retry with the latest workflow state")
	default:
		return expected("workflow save failed")
	}
	d.Audit.Write(ctx, d.Pool, d.auditContext(), "workflow.saved", audit.Options{
		TargetType: "workflow", TargetID: workflowID,
		Metadata: map[string]any{"version": committed.Version, "attempts": committed.Attempts},
	})
	return ok(map[string]any{
		"workflowId": workflowID, "versionId": committed.VersionID, "version": committed.Version,
	})
}

type startArgs struct {
	WorkflowID        string         `json:"workflowId,omitempty" jsonschema:"saved workflow to run at its latest version; pass this or workflow"`
	Workflow          map[string]any `json:"workflow,omitempty" jsonschema:"the workflow document to execute; pass this or workflowId"`
	WorkflowVersionID string         `json:"workflowVersionId,omitempty" jsonschema:"optional immutable version id: with workflow it must match the document; with workflowId it must be the latest version"`
	Input             map[string]any `json:"input,omitempty" jsonschema:"optional run input payload"`
	IdempotencyKey    string         `json:"idempotencyKey,omitempty" jsonschema:"retrying with the same key returns the first run instead of starting another"`
}

func (d Deps) startRun(ctx context.Context, args startArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "runs.start", "runs.start", true); !allowed {
		return expected(message)
	}
	document, input := args.Workflow, args.Input
	requestedVersionID := strings.TrimSpace(args.WorkflowVersionID)
	workflowID := strings.TrimSpace(args.WorkflowID)
	idempotencyKey := strings.TrimSpace(args.IdempotencyKey)
	if !validOptionalMCPIdentifier(requestedVersionID) || !validOptionalMCPIdentifier(workflowID) ||
		!validOptionalMCPIdentifier(idempotencyKey) {
		return expected("workflowId, workflowVersionId and idempotencyKey must be at most 256 characters")
	}
	if (workflowID == "") == (document == nil) {
		return expected("pass exactly one of workflowId or workflow; workflows.list shows saved ids")
	}
	if principal := d.agent(); principal != nil {
		if document != nil {
			// An unsaved document would reach production without publication.
			return expected("an agent client starts saved workflows by workflowId; it cannot run an unsaved document")
		}
		if idempotencyKey != "" {
			// A per-client key space: a replay never returns someone else's run.
			idempotencyKey = principal.ActorID() + ":" + idempotencyKey
		}
	}
	if workflowID != "" {
		if visible, err := d.workflowVisible(ctx, workflowID); err != nil || !visible {
			return hiddenResult(err, "workflow not found or deactivated; workflows.list shows active workflows")
		}
		latest, result := d.latestWorkflowDocument(ctx, workflowID)
		if result != nil {
			return result, nil, nil
		}
		// Agents pass the version they just published; accept it while it is
		// still the latest, which is what a workflowId start runs.
		if requestedVersionID != "" && requestedVersionID != latest.versionID {
			return expected("workflowVersionId is not this workflow's latest version; omit it to run the latest, or read the latest with workflows.get")
		}
		document, requestedVersionID = latest.document, latest.versionID
	}
	requestRaw, err := json.Marshal(map[string]any{
		"workflow": document, "workflowVersionId": requestedVersionID, "input": input,
	})
	if err != nil || len(requestRaw) > maxMCPRequestBytes {
		return expected("run request is invalid or exceeds 256000 bytes")
	}
	raw, err := json.Marshal(document)
	if err != nil || len(raw) > maxMCPWorkflowDocumentBytes {
		return expected("workflow document is invalid or exceeds 128000 bytes")
	}
	wf, _ := domain.Parse(raw)
	if wf == nil {
		return expectedReport("workflow contract invalid", d.validationReport(ctx, document))
	}
	if !validOptionalMCPIdentifier(wf.ID) {
		return expected("workflow id must be at most 256 characters")
	}
	if visible, err := d.workflowVisible(ctx, wf.ID); err != nil {
		return nil, nil, err
	} else if !visible {
		return expected("a scoped agent client starts only workflows in its scope; pass a workflowId from workflows.list")
	}
	var startInput any
	if input != nil {
		startInput = input
	}
	started, err := (runstart.Service{
		Engine: d.Engine, Pool: d.Pool, NewID: d.NewID,
	}).Start(ctx, runstart.Request{
		OrgID: d.OrgID, CreatedBy: d.UserID, ServicePrincipal: d.UserID, Workflow: wf,
		RequestedVersionID: requestedVersionID, Input: startInput, IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		var rejection *runstart.Rejection
		if errors.As(err, &rejection) {
			if rejection.Code == runstart.CodeValidationFailed {
				return expectedReport("workflow validation failed", d.validationReport(ctx, document))
			}
			return expected(rejection.Code + ": " + rejection.Message)
		}
		var invalid *engine.InputValidationError
		if errors.As(err, &invalid) {
			return expected(err.Error())
		}
		return nil, nil, err
	}
	if started.Replayed {
		if d.agent() != nil && !d.startedBySelf(ctx, started.RunID) {
			// Someone else claimed this key in the agent's namespace; never
			// hand their run to the agent.
			return expected("idempotencyKey was already used by another caller; choose a new key")
		}
		return ok(map[string]any{"runId": started.RunID, "replayed": true})
	}
	startAction := audit.Action("run.started")
	if !started.Binding.Bound {
		startAction = "run.started.adhoc"
	}
	d.Audit.Write(ctx, d.Pool, d.auditContext(), startAction, audit.Options{
		TargetType: "run", TargetID: started.RunID,
		Metadata: map[string]any{
			"workflowId":        started.Workflow.ID,
			"workflowVersionId": started.Binding.VersionID, "adhoc": !started.Binding.Bound,
		},
	})
	return ok(map[string]any{"runId": started.RunID})
}

func (d Deps) startedBySelf(ctx context.Context, runID string) bool {
	run, err := store.New(d.Pool).GetRun(ctx, store.GetRunParams{ID: runID, OrgID: d.OrgID})
	return err == nil && run.CreatedBy.Valid && run.CreatedBy.String == d.UserID
}

type latestWorkflow struct {
	document  map[string]any
	versionID string
}

// latestWorkflowDocument loads the active workflow's newest immutable version
// so a start by id binds to it exactly like a start with that document.
func (d Deps) latestWorkflowDocument(ctx context.Context, workflowID string) (latestWorkflow, *mcp.CallToolResult) {
	q := store.New(d.Pool)
	reject := func(message string) (latestWorkflow, *mcp.CallToolResult) {
		result, _, _ := expected(message)
		return latestWorkflow{}, result
	}
	if _, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflowID, OrgID: d.OrgID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return reject("workflow not found or deactivated; workflows.list shows active workflows")
		}
		return reject("workflow lookup failed")
	}
	latest, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{WorkflowID: workflowID, OrgID: d.OrgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return reject("workflow has no saved version")
		}
		return reject("workflow lookup failed")
	}
	var document map[string]any
	if json.Unmarshal(latest.DagJson, &document) != nil || document == nil {
		return reject("saved workflow version is unreadable")
	}
	return latestWorkflow{document: document, versionID: latest.ID}, nil
}

func (d Deps) runStatus(ctx context.Context, runID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "runs.status", "runs.read", false); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(runID) {
		return expected("runId is required and must be at most 256 characters")
	}
	if visible, err := d.runVisible(ctx, runID); err != nil || !visible {
		return hiddenResult(err, "run not found")
	}
	q := store.New(d.Pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: d.OrgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("run not found")
		}
		return nil, nil, err
	}
	nodes, err := q.ListRunNodesByRunForOrg(ctx, store.ListRunNodesByRunForOrgParams{RunID: runID, OrgID: d.OrgID})
	if err != nil {
		return nil, nil, err
	}
	nodeViews := map[string]any{}
	for _, node := range nodes {
		attempts := int32(0)
		if node.Attempts.Valid {
			attempts = node.Attempts.Int32
		}
		nodeViews[node.NodeID] = map[string]any{"status": node.Status, "attempts": attempts}
	}
	return ok(map[string]any{
		"runId": run.ID, "status": run.Status, "nodes": nodeViews,
		"outputAvailable": len(run.OutputJson) > 0,
	})
}

func (d Deps) runInspect(ctx context.Context, runID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "runs.inspect", "runs.read", false); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(runID) {
		return expected("runId is required and must be at most 256 characters")
	}
	if visible, err := d.runVisible(ctx, runID); err != nil || !visible {
		return hiddenResult(err, "run not found")
	}
	q := store.New(d.Pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: d.OrgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("run not found")
		}
		return nil, nil, err
	}
	nodes, err := q.ListRunNodesByRunForOrg(ctx, store.ListRunNodesByRunForOrgParams{RunID: runID, OrgID: d.OrgID})
	if err != nil {
		return nil, nil, err
	}
	events, err := q.ListRunEventsForOrg(ctx, store.ListRunEventsForOrgParams{
		RunID: runID, OrgID: d.OrgID, BeforeCreatedAt: farFuture(), BeforeID: "￿", PageLimit: 50,
	})
	if err != nil {
		return nil, nil, err
	}
	nodeViews := make([]map[string]any, 0, len(nodes))
	for _, node := range nodes {
		attempts := int32(0)
		if node.Attempts.Valid {
			attempts = node.Attempts.Int32
		}
		nodeViews = append(nodeViews, map[string]any{
			"nodeId": node.NodeID, "status": node.Status, "attempts": attempts,
			"stateAvailable": len(node.StateJson) > 0,
			"error":          safeErrorProjection(node.ErrorJson),
		})
	}
	eventViews := make([]map[string]any, 0, len(events))
	for _, event := range events {
		nodeID := ""
		if event.NodeID.Valid {
			nodeID = event.NodeID.String
		}
		eventViews = append(eventViews, map[string]any{
			"type": event.Type, "nodeId": nodeID,
		})
	}
	return ok(map[string]any{
		"runId": run.ID, "status": run.Status,
		"inputAvailable": len(run.InputJson) > 0, "outputAvailable": len(run.OutputJson) > 0,
		"nodes": nodeViews, "recentEvents": eventViews,
	})
}

func (d Deps) dlqList(ctx context.Context, limit int, cursor string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "dlq.list", "dlq.read", false); !allowed {
		return expected(message)
	}
	if !validOptionalMCPCursor(cursor) {
		return expected("dead-letter list cursor exceeds 1024 characters")
	}
	page, problem := pageBounds(limit, cursor)
	if problem != "" {
		return expected(problem)
	}
	if d.scoped() {
		return d.scopedDeadLetters(ctx, page)
	}
	params := store.ListDeadLetterSummariesParams{OrgID: d.OrgID, PageLimit: page.limit + 1}
	if cursor != "" {
		params.BeforeCreatedAt = &page.before
		params.BeforeID = pgtype.Text{String: page.beforeID, Valid: true}
	}
	rows, err := store.New(d.Pool).ListDeadLetterSummaries(ctx, params)
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
			"id": row.ID, "runId": row.RunID, "nodeId": row.NodeID,
			"attempt": row.Attempt, "status": row.Status,
			"error": safeErrorProjection(row.ErrorJson),
		})
	}
	payload := map[string]any{"deadLetters": items, "hasMore": hasMore}
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		payload["nextCursor"] = createdAtISO(last.CreatedAt) + "|" + last.ID
	}
	return ok(payload)
}

func (d Deps) redrive(ctx context.Context, deadLetterID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "dlq.redrive", "dlq.replay", true); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(deadLetterID) {
		return expected("deadLetterId is required and must be at most 256 characters")
	}
	if visible, err := d.deadLetterVisible(ctx, deadLetterID); err != nil || !visible {
		return hiddenResult(err, "dead letter not found")
	}
	err := d.Engine.RedriveDeadLetterWithOptions(ctx, d.OrgID, deadLetterID, engine.RedriveOptions{Actor: d.UserID})
	switch {
	case err == nil:
		d.Audit.Write(ctx, d.Pool, d.auditContext(), "dlq.replayed", audit.Options{
			TargetType: "dlq", TargetID: deadLetterID,
		})
		payload := map[string]any{"redriven": true, "deadLetterId": deadLetterID}
		maps.Copy(payload, d.redriveVersionView(ctx, deadLetterID))
		return ok(payload)
	case errors.Is(err, engine.ErrDeadLetterNotFound):
		return expected("dead letter not found")
	case errors.Is(err, engine.ErrRedriveRerunExists):
		return expected(err.Error())
	case errors.Is(err, engine.ErrRedriveConflict):
		return expected("dead letter replay already claimed")
	default:
		return nil, nil, err
	}
}

// redriveVersionView says which version the revived run executes. A redrive
// keeps the run's original snapshot, so right after a workflow fix it fails
// the same way unless the agent starts a new run. Lookup failures omit it.
func (d Deps) redriveVersionView(ctx context.Context, deadLetterID string) map[string]any {
	q := store.New(d.Pool)
	dead, err := q.GetDeadLetter(ctx, store.GetDeadLetterParams{ID: deadLetterID, OrgID: d.OrgID})
	if err != nil {
		return nil
	}
	run, err := q.GetRun(ctx, store.GetRunParams{ID: dead.RunID, OrgID: d.OrgID})
	if err != nil || run.WorkflowVersionID == "" {
		return nil
	}
	pinned, err := q.GetWorkflowVersionAnyWorkflow(ctx, store.GetWorkflowVersionAnyWorkflowParams{
		ID: run.WorkflowVersionID, OrgID: d.OrgID,
	})
	if err != nil {
		return nil
	}
	latest, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{
		WorkflowID: pinned.WorkflowID, OrgID: d.OrgID,
	})
	if err != nil {
		return nil
	}
	view := map[string]any{
		"runId": dead.RunID, "runVersion": pinned.Version, "latestVersion": latest.Version,
		"staleVersion": latest.ID != pinned.ID,
	}
	if latest.ID != pinned.ID {
		view["hint"] = fmt.Sprintf("the revived run keeps version %d; runs.start with workflowId %q runs version %d",
			pinned.Version, pinned.WorkflowID, latest.Version)
	}
	return view
}

func farFuture() time.Time {
	return time.Now().Add(24 * time.Hour)
}

type pageWindow struct {
	limit    int32
	before   time.Time
	beforeID string
}

// pageBounds applies the shared limit contract (default 20, at most 100) and
// decodes the `<iso>|<id>` keyset cursor. Unlike the HTTP lists, which fall
// back to page one, MCP rejects a bad cursor or limit: an agent that keeps
// receiving page one never learns its loop is broken.
func pageBounds(limit int, cursor string) (pageWindow, string) {
	if limit < 0 || limit > 100 {
		return pageWindow{}, "limit must be between 1 and 100; omit it for 20"
	}
	if limit == 0 {
		limit = 20
	}
	page := pageWindow{limit: int32(limit), before: farFuture(), beforeID: "￿"}
	if cursor == "" {
		return page, ""
	}
	at, id, found := strings.Cut(cursor, "|")
	parsed, err := time.Parse(time.RFC3339Nano, at)
	if !found || err != nil || id == "" {
		return pageWindow{}, "cursor is malformed; pass nextCursor from the previous page unchanged"
	}
	page.before, page.beforeID = parsed, id
	return page, ""
}

func (d Deps) runsList(ctx context.Context, limit int, cursor, workflowID, status string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "runs.list", "runs.read", false); !allowed {
		return expected(message)
	}
	if !validOptionalMCPCursor(cursor) || !validOptionalMCPIdentifier(workflowID) {
		return expected("runs list cursor or workflowId exceeds its bounded length")
	}
	if status != "" && status != "running" && status != "succeeded" && status != "failed" && status != "cancelled" {
		return expected("run status must be running, succeeded, failed, or cancelled")
	}
	page, problem := pageBounds(limit, cursor)
	if problem != "" {
		return expected(problem)
	}
	if d.scoped() {
		return d.scopedRuns(ctx, page, workflowID, status)
	}
	pageLimit := page.limit
	rows, err := store.New(d.Pool).ListRunSummaries(ctx, store.ListRunSummariesParams{
		OrgID: d.OrgID, BeforeCreatedAt: page.before, BeforeID: page.beforeID,
		FilterWorkflowID: pgtype.Text{String: workflowID, Valid: workflowID != ""},
		FilterStatus:     pgtype.Text{String: status, Valid: status != ""},
		PageLimit:        pageLimit + 1,
	})
	if err != nil {
		return nil, nil, err
	}
	hasMore := len(rows) > int(pageLimit)
	if hasMore {
		rows = rows[:pageLimit]
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		item := map[string]any{
			"runId": row.ID, "status": row.Status,
			"workflowId":   row.WorkflowID,
			"workflowName": boundedMCPText(stringOrEmpty(row.WorkflowName), 240),
			"createdAt":    createdAtISO(row.CreatedAt),
		}
		items = append(items, item)
	}
	payload := map[string]any{"runs": items, "hasMore": hasMore}
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		payload["nextCursor"] = createdAtISO(last.CreatedAt) + "|" + last.ID
	}
	return ok(payload)
}

func (d Deps) workflowsList(ctx context.Context, limit int, cursor string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.list", "workflows.read", false); !allowed {
		return expected(message)
	}
	if !validOptionalMCPCursor(cursor) {
		return expected("workflow list cursor exceeds 1024 characters")
	}
	page, problem := pageBounds(limit, cursor)
	if problem != "" {
		return expected(problem)
	}
	if d.scoped() {
		return d.scopedWorkflows(ctx, page)
	}
	pageLimit := page.limit
	rows, err := store.New(d.Pool).ListWorkflowRows(ctx, store.ListWorkflowRowsParams{
		OrgID: d.OrgID, BeforeCreatedAt: page.before, BeforeID: page.beforeID,
		PageLimit: pageLimit + 1,
	})
	if err != nil {
		return nil, nil, err
	}
	hasMore := len(rows) > int(pageLimit)
	if hasMore {
		rows = rows[:pageLimit]
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{
			"workflowId": row.ID, "name": boundedMCPText(row.Name, 240),
			"createdAt": createdAtISO(row.CreatedAt),
			"runCount":  row.RunCount, "lastRunStatus": row.LastRunStatus,
		})
	}
	payload := map[string]any{"workflows": items, "hasMore": hasMore}
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		payload["nextCursor"] = createdAtISO(last.CreatedAt) + "|" + last.ID
	}
	return ok(payload)
}

// stringOrEmpty flattens the coalesced lateral projection (interface{})
// back to its plain string for the MCP result table.
func stringOrEmpty(value any) string {
	text, _ := value.(string)
	return text
}

func createdAtISO(at *time.Time) string {
	if at == nil {
		return ""
	}
	return at.UTC().Format(time.RFC3339Nano)
}
