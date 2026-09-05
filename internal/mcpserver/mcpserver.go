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
}

// auditContext derives the audit identity for MCP-originated writes: the
// contract's MCP proxy reaches the API with the service token and the mcp
// source tag, which is exactly what the audit trail must show.
func (d Deps) auditContext() *auth.Context {
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
		"Validate a workflow document and save it as a new immutable version.", false, false,
	), func(ctx context.Context, req *mcp.CallToolRequest, args saveArgs) (*mcp.CallToolResult, any, error) {
		return deps.saveWorkflow(ctx, args.Workflow)
	})

	type startArgs struct {
		Workflow          map[string]any `json:"workflow" jsonschema:"the workflow document to execute"`
		WorkflowVersionID string         `json:"workflowVersionId,omitempty" jsonschema:"optional immutable version id that must exactly match the workflow document"`
		Input             map[string]any `json:"input,omitempty" jsonschema:"optional run input payload"`
	}
	mcp.AddTool(server, writeTool(
		"runs.start", "Start run",
		"Start a run for the given workflow document; returns the run id.", false, false,
	), func(ctx context.Context, req *mcp.CallToolRequest, args startArgs) (*mcp.CallToolResult, any, error) {
		return deps.startRun(ctx, args.Workflow, args.WorkflowVersionID, args.Input)
	})

	type runArgs struct {
		RunID string `json:"runId" jsonschema:"the run to read"`
	}
	mcp.AddTool(server, readTool(
		"runs.status", "Run status",
		"Read a bounded run status projection: final status plus per-node status and attempts.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args runArgs) (*mcp.CallToolResult, any, error) {
		return deps.runStatus(ctx, args.RunID)
	})
	mcp.AddTool(server, readTool(
		"runs.inspect", "Inspect run",
		"Read a bounded run projection with node status, redacted error summaries, and recent event types; never returns the workflow DAG or raw payloads.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args runArgs) (*mcp.CallToolResult, any, error) {
		return deps.runInspect(ctx, args.RunID)
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
		return deps.runsList(ctx, args.Limit, args.Cursor, args.WorkflowID, args.Status)
	})
	mcp.AddTool(server, readTool(
		"workflows.list", "List workflows",
		"List the organization's active workflows newest first, keyset-paginated.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args pageArgs) (*mcp.CallToolResult, any, error) {
		return deps.workflowsList(ctx, args.Limit, args.Cursor)
	})

	type assureArgs struct {
		WorkflowID string `json:"workflowId" jsonschema:"the active workflow whose latest immutable version should be inspected"`
	}
	mcp.AddTool(server, readTool(
		"workflows.assure", "Assure workflow",
		"Inspect the latest workflow version's Intent, Recovery, Qualification, validation, and readiness evidence without exposing its DAG or credentials.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args assureArgs) (*mcp.CallToolResult, any, error) {
		return deps.assureWorkflow(ctx, args.WorkflowID)
	})

	type dlqListArgs struct {
		Limit int `json:"limit,omitempty" jsonschema:"maximum rows to return (default 20, max 100)"`
	}
	mcp.AddTool(server, readTool(
		"dlq.list", "List dead letters",
		"List bounded dead-letter summaries for the organization, newest first.",
	), func(ctx context.Context, req *mcp.CallToolRequest, args dlqListArgs) (*mcp.CallToolResult, any, error) {
		return deps.dlqList(ctx, args.Limit)
	})

	type redriveArgs struct {
		DeadLetterID string `json:"deadLetterId" jsonschema:"the dead letter whose run should be revived"`
	}
	mcp.AddTool(server, writeTool(
		"dlq.redrive", "Redrive dead letter",
		"Claim one dead letter and revive its run: the failed node requeues and workers take over.", true, false,
	), func(ctx context.Context, req *mcp.CallToolRequest, args redriveArgs) (*mcp.CallToolResult, any, error) {
		return deps.redrive(ctx, args.DeadLetterID)
	})

	registerOperatorTools(server, deps)
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
	wf, issues := domain.Parse(raw)
	if wf == nil {
		return expected(fmt.Sprintf("workflow contract invalid: %s", issueSummary(issues)))
	}
	if !validOptionalMCPIdentifier(wf.ID) {
		return expected("workflow id must be at most 256 characters")
	}
	result := workflowvalidation.Validate(wf)
	var blocking []domain.Issue
	for _, issue := range result.Issues {
		if issue.Code != domain.CodeNodeTypeNotExecutable {
			blocking = append(blocking, issue)
		}
	}
	if len(blocking) > 0 {
		return expected(fmt.Sprintf("workflow validation failed: %s", issueSummary(blocking)))
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
	audit.Write(ctx, d.Pool, d.auditContext(), "workflow.saved", audit.Options{
		TargetType: "workflow", TargetID: workflowID,
		Metadata: map[string]any{"version": committed.Version, "attempts": committed.Attempts},
	})
	return ok(map[string]any{
		"workflowId": workflowID, "versionId": committed.VersionID, "version": committed.Version,
	})
}

func (d Deps) startRun(
	ctx context.Context,
	document map[string]any,
	requestedVersionID string,
	input map[string]any,
) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "runs.start", "runs.start", true); !allowed {
		return expected(message)
	}
	requestedVersionID = strings.TrimSpace(requestedVersionID)
	if !validOptionalMCPIdentifier(requestedVersionID) {
		return expected("workflowVersionId must be at most 256 characters")
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
	wf, issues := domain.Parse(raw)
	if wf == nil {
		return expected(fmt.Sprintf("workflow contract invalid: %s", issueSummary(issues)))
	}
	if !validOptionalMCPIdentifier(wf.ID) {
		return expected("workflow id must be at most 256 characters")
	}
	var startInput any
	if input != nil {
		startInput = input
	}
	started, err := (runstart.Service{
		Engine: d.Engine, Pool: d.Pool, NewID: d.NewID,
	}).Start(ctx, runstart.Request{
		OrgID: d.OrgID, CreatedBy: d.UserID, Workflow: wf,
		RequestedVersionID: requestedVersionID, Input: startInput,
	})
	if err != nil {
		var rejection *runstart.Rejection
		if errors.As(err, &rejection) {
			if rejection.Code == runstart.CodeValidationFailed {
				return expected(fmt.Sprintf("workflow validation failed: %s", issueSummary(rejection.Issues)))
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
		return ok(map[string]any{"runId": started.RunID})
	}
	startAction := audit.Action("run.started")
	if !started.Binding.Bound {
		startAction = "run.started.adhoc"
	}
	audit.Write(ctx, d.Pool, d.auditContext(), startAction, audit.Options{
		TargetType: "run", TargetID: started.RunID,
		Metadata: map[string]any{
			"workflowId":        started.Workflow.ID,
			"workflowVersionId": started.Binding.VersionID, "adhoc": !started.Binding.Bound,
		},
	})
	return ok(map[string]any{"runId": started.RunID})
}

func (d Deps) runStatus(ctx context.Context, runID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "runs.status", "runs.read", false); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(runID) {
		return expected("runId is required and must be at most 256 characters")
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

func (d Deps) dlqList(ctx context.Context, limit int) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "dlq.list", "dlq.read", false); !allowed {
		return expected(message)
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	rows, err := store.New(d.Pool).ListDeadLetterSummaries(ctx, store.ListDeadLetterSummariesParams{
		OrgID: d.OrgID, PageLimit: int32(limit),
	})
	if err != nil {
		return nil, nil, err
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{
			"id": row.ID, "runId": row.RunID, "nodeId": row.NodeID,
			"attempt": row.Attempt, "status": row.Status,
			"error": safeErrorProjection(row.ErrorJson),
		})
	}
	return ok(map[string]any{"deadLetters": items})
}

func (d Deps) redrive(ctx context.Context, deadLetterID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "dlq.redrive", "dlq.replay", true); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(deadLetterID) {
		return expected("deadLetterId is required and must be at most 256 characters")
	}
	err := d.Engine.RedriveDeadLetter(ctx, d.OrgID, deadLetterID)
	switch {
	case err == nil:
		audit.Write(ctx, d.Pool, d.auditContext(), "dlq.replayed", audit.Options{
			TargetType: "dlq", TargetID: deadLetterID,
		})
		return ok(map[string]any{"redriven": true, "deadLetterId": deadLetterID})
	case errors.Is(err, engine.ErrDeadLetterNotFound):
		return expected("dead letter not found")
	case errors.Is(err, engine.ErrRedriveConflict):
		return expected("dead letter replay already claimed")
	default:
		return nil, nil, err
	}
}

func issueSummary(issues []domain.Issue) string {
	if len(issues) == 0 {
		return "unknown issue"
	}
	summary := boundedMCPText(issues[0].Message, maxMCPErrorSummaryRunes)
	if len(issues) > 1 {
		summary = fmt.Sprintf("%s (+%d more)", summary, len(issues)-1)
	}
	return summary
}

func farFuture() time.Time {
	return time.Now().Add(24 * time.Hour)
}

// pageBounds normalizes the shared limit contract (default 20, max 100)
// and decodes the `<iso>|<id>` keyset cursor; a malformed cursor means
// page one, never an error — same posture as the HTTP list surfaces.
func pageBounds(limit int, cursor string) (int32, time.Time, string) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	before := farFuture()
	beforeID := "￿"
	if at, id, found := strings.Cut(cursor, "|"); found {
		if parsed, err := time.Parse(time.RFC3339Nano, at); err == nil {
			before, beforeID = parsed, id
		}
	}
	return int32(limit), before, beforeID
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
	pageLimit, before, beforeID := pageBounds(limit, cursor)
	rows, err := store.New(d.Pool).ListRunSummaries(ctx, store.ListRunSummariesParams{
		OrgID: d.OrgID, BeforeCreatedAt: before, BeforeID: beforeID,
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
	pageLimit, before, beforeID := pageBounds(limit, cursor)
	rows, err := store.New(d.Pool).ListWorkflowRows(ctx, store.ListWorkflowRowsParams{
		OrgID: d.OrgID, BeforeCreatedAt: before, BeforeID: beforeID,
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
