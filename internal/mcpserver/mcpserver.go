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
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/ratelimit"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

// Deps carries the in-process dependencies every tool shares.
type Deps struct {
	Engine *engine.Engine
	Pool   *pgxpool.Pool
	OrgID  string
	UserID string
	NewID  func() string
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

// NewServer builds the MCP server with the runtime's eight tools registered.
func NewServer(deps Deps) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "janusly",
		Title:   "Janusly",
		Version: "0.1.0",
	}, nil)

	type saveArgs struct {
		Workflow map[string]any `json:"workflow" jsonschema:"the full workflow document to save as a new immutable version"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "workflows.save",
		Description: "Validate a workflow document and save it as a new immutable version.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args saveArgs) (*mcp.CallToolResult, any, error) {
		raw, err := json.Marshal(args.Workflow)
		if err != nil {
			return nil, nil, err
		}
		return deps.saveWorkflow(ctx, raw)
	})

	type startArgs struct {
		Workflow map[string]any `json:"workflow" jsonschema:"the workflow document to execute"`
		Input    map[string]any `json:"input,omitempty" jsonschema:"optional run input payload"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "runs.start",
		Description: "Start a run for the given workflow document; returns the run id.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args startArgs) (*mcp.CallToolResult, any, error) {
		raw, err := json.Marshal(args.Workflow)
		if err != nil {
			return nil, nil, err
		}
		return deps.startRun(ctx, raw, args.Input)
	})

	type runArgs struct {
		RunID string `json:"runId" jsonschema:"the run to read"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "runs.status",
		Description: "Read a run's status projection: final status plus per-node state and attempts.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args runArgs) (*mcp.CallToolResult, any, error) {
		return deps.runStatus(ctx, args.RunID)
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "runs.inspect",
		Description: "Read a run in depth: row, nodes with state and errors, and the recent timeline.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args runArgs) (*mcp.CallToolResult, any, error) {
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
	mcp.AddTool(server, &mcp.Tool{
		Name:        "runs.list",
		Description: "List the org's runs newest first, keyset-paginated; optional workflowId and status filters.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args runsListArgs) (*mcp.CallToolResult, any, error) {
		return deps.runsList(ctx, args.Limit, args.Cursor, args.WorkflowID, args.Status)
	})
	mcp.AddTool(server, &mcp.Tool{
		Name:        "workflows.list",
		Description: "List the org's active workflows newest first, keyset-paginated.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args pageArgs) (*mcp.CallToolResult, any, error) {
		return deps.workflowsList(ctx, args.Limit, args.Cursor)
	})

	type dlqListArgs struct {
		Limit int `json:"limit,omitempty" jsonschema:"maximum rows to return (default 20, max 100)"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "dlq.list",
		Description: "List dead letters for the org, newest first.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args dlqListArgs) (*mcp.CallToolResult, any, error) {
		return deps.dlqList(ctx, args.Limit)
	})

	type redriveArgs struct {
		DeadLetterID string `json:"deadLetterId" jsonschema:"the dead letter whose run should be revived"`
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:        "dlq.redrive",
		Description: "Claim one dead letter and revive its run: the failed node requeues and workers take over.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, args redriveArgs) (*mcp.CallToolResult, any, error) {
		return deps.redrive(ctx, args.DeadLetterID)
	})

	return server
}

// ok wraps a successful payload as JSON text + structuredContent.
func ok(payload any) (*mcp.CallToolResult, any, error) {
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return nil, nil, err
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}},
	}, payload, nil
}

// expected reports an EXPECTED failure as isError, keeping the session
// alive — agents read these and decide, they are not crashes.
func expected(message string) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: message}},
	}, nil, nil
}

func (d Deps) saveWorkflow(ctx context.Context, raw json.RawMessage) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardWrite(ctx, "workflows.save"); !allowed {
		return expected(message)
	}
	wf, issues := domain.Parse(raw)
	if wf == nil {
		return expected(fmt.Sprintf("workflow contract invalid: %s", issueSummary(issues)))
	}
	result := domain.ValidateWithSemanticFixtures(wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation)
	var blocking []domain.Issue
	for _, issue := range result.Issues {
		if issue.Code != domain.CodeNodeTypeNotExecutable {
			blocking = append(blocking, issue)
		}
	}
	if len(blocking) > 0 {
		return expected(fmt.Sprintf("workflow validation failed: %s", issueSummary(blocking)))
	}

	q := store.New(d.Pool)
	workflowID := wf.ID
	if workflowID == "" {
		workflowID = d.NewID()
	}
	if _, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: workflowID, OrgID: d.OrgID}); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, err
		}
		name := wf.Name
		if name == "" {
			name = workflowID
		}
		if err := q.InsertWorkflow(ctx, store.InsertWorkflowParams{
			ID: workflowID, OrgID: d.OrgID, Name: name,
			CreatedBy: pgtype.Text{String: d.UserID, Valid: d.UserID != ""},
		}); err != nil {
			return expected(fmt.Sprintf("workflow id is already taken: %s", workflowID))
		}
	}
	version, err := q.CountWorkflowVersions(ctx, store.CountWorkflowVersionsParams{
		WorkflowID: workflowID, OrgID: d.OrgID,
	})
	if err != nil {
		return nil, nil, err
	}
	versionID := d.NewID()
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: versionID, OrgID: d.OrgID, WorkflowID: workflowID,
		Version: version + 1, DagJson: raw,
		CreatedBy: pgtype.Text{String: d.UserID, Valid: d.UserID != ""},
	}); err != nil {
		return nil, nil, err
	}
	audit.Write(ctx, d.Pool, d.auditContext(), "workflow.saved", audit.Options{
		TargetType: "workflow", TargetID: workflowID,
		Metadata: map[string]any{"version": version + 1},
	})
	return ok(map[string]any{"workflowId": workflowID, "versionId": versionID, "version": version + 1})
}

func (d Deps) startRun(ctx context.Context, raw json.RawMessage, input map[string]any) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardWrite(ctx, "runs.start"); !allowed {
		return expected(message)
	}
	wf, issues := domain.Parse(raw)
	if wf == nil {
		return expected(fmt.Sprintf("workflow contract invalid: %s", issueSummary(issues)))
	}
	if result := domain.ValidateWithSemanticFixtures(wf, grammar.DomainValidator, recovery.FixtureOutcomesForValidation); !result.Valid {
		return expected(fmt.Sprintf("workflow validation failed: %s", issueSummary(result.Issues)))
	}
	var startInput any
	if input != nil {
		startInput = input
	}
	runID, err := d.Engine.StartRun(ctx, engine.StartInput{
		OrgID: d.OrgID, Workflow: wf, Input: startInput, CreatedBy: d.UserID,
	})
	if err != nil {
		var invalid *engine.InputValidationError
		if errors.As(err, &invalid) {
			return expected(err.Error())
		}
		return nil, nil, err
	}
	audit.Write(ctx, d.Pool, d.auditContext(), "run.started.adhoc", audit.Options{
		TargetType: "run", TargetID: runID,
		Metadata: map[string]any{"workflowId": wf.ID, "adhoc": true},
	})
	return ok(map[string]any{"runId": runID})
}

func (d Deps) runStatus(ctx context.Context, runID string) (*mcp.CallToolResult, any, error) {
	q := store.New(d.Pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: d.OrgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("run not found")
		}
		return nil, nil, err
	}
	nodes, err := q.ListRunNodesByRun(ctx, runID)
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
		"outputJson": json.RawMessage(orEmptyObject(run.OutputJson)),
	})
}

func (d Deps) runInspect(ctx context.Context, runID string) (*mcp.CallToolResult, any, error) {
	q := store.New(d.Pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: d.OrgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("run not found")
		}
		return nil, nil, err
	}
	nodes, err := q.ListRunNodesByRun(ctx, runID)
	if err != nil {
		return nil, nil, err
	}
	events, err := q.ListRunEvents(ctx, store.ListRunEventsParams{
		RunID: runID, BeforeCreatedAt: farFuture(), BeforeID: "￿", PageLimit: 50,
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
			"stateJson": json.RawMessage(orEmptyObject(node.StateJson)),
			"errorJson": json.RawMessage(orEmptyObject(node.ErrorJson)),
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
			"payload": json.RawMessage(orEmptyObject(event.Payload)),
		})
	}
	return ok(map[string]any{
		"runId": run.ID, "status": run.Status,
		"inputJson":  json.RawMessage(orEmptyObject(run.InputJson)),
		"outputJson": json.RawMessage(orEmptyObject(run.OutputJson)),
		"nodes":      nodeViews, "recentEvents": eventViews,
	})
}

func (d Deps) dlqList(ctx context.Context, limit int) (*mcp.CallToolResult, any, error) {
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
			"errorJson": json.RawMessage(orEmptyObject(row.ErrorJson)),
		})
	}
	return ok(map[string]any{"deadLetters": items})
}

func (d Deps) redrive(ctx context.Context, deadLetterID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardWrite(ctx, "dlq.redrive"); !allowed {
		return expected(message)
	}
	if deadLetterID == "" {
		return expected("deadLetterId is required")
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
	summary := issues[0].Message
	if len(issues) > 1 {
		summary = fmt.Sprintf("%s (+%d more)", summary, len(issues)-1)
	}
	return summary
}

func farFuture() time.Time {
	return time.Now().Add(24 * time.Hour)
}

func orEmptyObject(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
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
			"workflowId": row.WorkflowID, "workflowName": stringOrEmpty(row.WorkflowName),
			"createdAt": createdAtISO(row.CreatedAt),
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
			"workflowId": row.ID, "name": row.Name,
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

// guardWrite is the two-flag write consent, implements the contract's
// guardMcpWrite: process-wide env opt-in AND the tenant's org-config
// consent row must BOTH be true before any MCP write tool acts. Denials
// return the contract's verbatim messages as expected (isError) results
// — the runtime's MCP is in-process, so the contract's HTTP 403 surfaces
// as a tool error instead. The per-action rate limit mirrors the
// contract's guardMcpWrite: bucket `mcp.<actionKey>`, org key, 60/min.
func (d Deps) guardWrite(ctx context.Context, actionKey string) (bool, string) {
	if os.Getenv("JANUSLY_MCP_WRITES_ENABLED") != "true" {
		return false, "MCP writes are disabled at the process level (JANUSLY_MCP_WRITES_ENABLED is not 'true')."
	}
	// The tenant consent reads through the catalog snapshot — the same
	// layer chain as every governed setting. mcp.writeConsent has NO env
	// fallback by design, which the catalog's empty EnvKeys encodes.
	if !orgconfig.LoadBool(ctx, d.Pool, d.OrgID, "mcp.writeConsent") {
		return false, "MCP writes are not consented for this organization (mcp.writeConsent is false)."
	}
	if d.Limiter != nil {
		if err := d.Limiter.Enforce(ctx, d.OrgID, ratelimit.Options{
			Name: "mcp." + actionKey, Max: 60, Window: time.Minute,
		}); err != nil {
			return false, err.Error()
		}
	}
	return true, ""
}
