package mcpserver

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	maxMCPVersionsListed = 20
	// maxMCPOutputValueBytes bounds each output value that enters a model's
	// context; larger values are replaced by their size.
	maxMCPOutputValueBytes = 32_000
)

type workflowGetArgs struct {
	WorkflowID      string `json:"workflowId" jsonschema:"active workflow id"`
	Version         int    `json:"version,omitempty" jsonschema:"exact version number; omit for the latest"`
	IncludeDocument *bool  `json:"includeDocument,omitempty" jsonschema:"default true; false returns only versions and schedules"`
}

type workflowRollbackArgs struct {
	WorkflowID      string `json:"workflowId" jsonschema:"active workflow id"`
	SourceVersionID string `json:"sourceVersionId" jsonschema:"version id to restore as a new immutable version"`
}

type workflowLifecycleArgs struct {
	WorkflowID string `json:"workflowId" jsonschema:"workflow id"`
}

type workflowPauseArgs struct {
	WorkflowID string `json:"workflowId" jsonschema:"workflow id"`
	Reason     string `json:"reason,omitempty" jsonschema:"short reason shown to operators, at most 500 characters"`
}

type runOutputArgs struct {
	RunID  string `json:"runId" jsonschema:"the run to read"`
	NodeID string `json:"nodeId,omitempty" jsonschema:"only this step's output"`
}

type runCancelArgs struct {
	RunID  string `json:"runId" jsonschema:"the run to cancel"`
	Reason string `json:"reason,omitempty" jsonschema:"bounded operator reason"`
}

func registerLifecycleTools(server *mcp.Server, deps Deps) {
	mcp.AddTool(server, readTool(
		"workflows.get", "Get workflow",
		"Read one active workflow: its document with secret-shaped literals removed, recent versions, and schedules with their next fire time.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args workflowGetArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).getWorkflow(ctx, args)
	})
	mcp.AddTool(server, writeTool(
		"workflows.rollback", "Roll back workflow",
		"Append an older version as the new latest immutable version and reconcile its schedules.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args workflowRollbackArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).rollbackWorkflow(ctx, args)
	})
	mcp.AddTool(server, writeTool(
		"workflows.deactivate", "Deactivate workflow",
		"Move a workflow to the trash: its schedules stop, its active rollout is cancelled and new runs are refused. workflows.reactivate undoes it until retention purges it.", true,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args workflowLifecycleArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).setWorkflowActive(ctx, args.WorkflowID, false)
	})
	mcp.AddTool(server, writeTool(
		"workflows.reactivate", "Reactivate workflow",
		"Restore a deactivated workflow and rebuild its schedules from the latest version.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args workflowLifecycleArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).setWorkflowActive(ctx, args.WorkflowID, true)
	})
	mcp.AddTool(server, writeTool(
		"workflows.pause", "Pause workflow",
		"Stop new runs of a workflow. Its versions, schedules and any active rollout stay as they are: schedule ticks are skipped, trigger events are held until workflows.resume, and runs in progress continue.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args workflowPauseArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).pauseWorkflow(ctx, args)
	})
	mcp.AddTool(server, writeTool(
		"workflows.resume", "Resume workflow",
		"Lift a manual or circuit-breaker pause and start the trigger events held while it was paused, oldest first.", false,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args workflowLifecycleArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).resumeWorkflow(ctx, args.WorkflowID)
	})
	mcp.AddTool(server, readTool(
		"runs.output", "Read run output",
		"Read a run's declared output and its steps' outputs, with secret-shaped literals removed and each value bounded to 32000 bytes.",
	), func(ctx context.Context, _ *mcp.CallToolRequest, args runOutputArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).runOutput(ctx, args)
	})
	mcp.AddTool(server, writeTool(
		"runs.cancel", "Cancel run",
		"Cancel a run that has not finished. Effects already applied are not undone.", true,
	), func(ctx context.Context, _ *mcp.CallToolRequest, args runCancelArgs) (*mcp.CallToolResult, any, error) {
		return deps.at(ctx).cancelRun(ctx, args)
	})
}

func (d Deps) getWorkflow(ctx context.Context, args workflowGetArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.get", "workflows.read", false); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(args.WorkflowID) {
		return expected("workflowId is required and must be at most 256 characters")
	}
	if args.Version < 0 {
		return expected("version must be a positive version number")
	}
	if visible, err := d.workflowVisible(ctx, args.WorkflowID); err != nil || !visible {
		return hiddenResult(err, "workflow not found or deactivated; workflows.list shows active workflows")
	}
	q := store.New(d.Pool)
	parent, err := q.GetWorkflow(ctx, store.GetWorkflowParams{ID: args.WorkflowID, OrgID: d.OrgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("workflow not found or deactivated; workflows.list shows active workflows")
		}
		return nil, nil, err
	}
	rows, err := q.ListWorkflowVersions(ctx, store.ListWorkflowVersionsParams{
		WorkflowID: args.WorkflowID, OrgID: d.OrgID, PageLimit: maxMCPVersionsListed,
	})
	if err != nil {
		return nil, nil, err
	}
	versions := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		versions = append(versions, map[string]any{
			"versionId": row.ID, "version": row.Version, "createdAt": createdAtISO(row.CreatedAt),
		})
	}
	entries, err := q.ListScheduleEntriesForWorkflow(ctx, store.ListScheduleEntriesForWorkflowParams{
		OrgID: d.OrgID, WorkflowID: args.WorkflowID,
	})
	if err != nil {
		return nil, nil, err
	}
	schedules := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		schedules = append(schedules, map[string]any{
			"nodeId": entry.NodeID, "cronExpression": entry.CronExpression, "enabled": entry.Enabled,
			"nextFireAt": createdAtISO(entry.NextFireAt), "lastRunAt": createdAtISO(entry.LastRunAt),
		})
	}
	view := map[string]any{
		"workflowId": args.WorkflowID, "name": boundedMCPText(parent.Name, 240), "status": parent.Status,
		"versions": versions, "schedules": schedules,
	}
	if len(rows) == 0 {
		return ok(view)
	}
	selected := rows[0]
	if args.Version > 0 {
		exact, err := q.ListWorkflowVersions(ctx, store.ListWorkflowVersionsParams{
			WorkflowID: args.WorkflowID, OrgID: d.OrgID, PageLimit: 1,
			ExactVersion: pgtype.Int4{Int32: int32(args.Version), Valid: true},
		})
		if err != nil {
			return nil, nil, err
		}
		if len(exact) == 0 {
			return expected("workflow version not found; versions lists the recent ones")
		}
		selected = exact[0]
	}
	view["version"], view["versionId"] = selected.Version, selected.ID
	if args.IncludeDocument == nil || *args.IncludeDocument {
		var document any
		if json.Unmarshal(selected.DagJson, &document) != nil {
			return expected("saved workflow version is unreadable")
		}
		view["document"] = scrubSecretShapes(document)
	}
	return ok(view)
}

func (d Deps) rollbackWorkflow(ctx context.Context, args workflowRollbackArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.rollback", "workflows.write", true); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(args.WorkflowID) || !validMCPIdentifier(args.SourceVersionID) {
		return expected("workflowId and sourceVersionId are required and must be at most 256 characters")
	}
	if visible, err := d.workflowVisible(ctx, args.WorkflowID); err != nil || !visible {
		return hiddenResult(err, "workflow not found")
	}
	committed, err := d.Engine.RollbackWorkflowVersion(ctx, engine.RollbackWorkflowInput{
		OrgID: d.OrgID, UserID: d.UserID, WorkflowID: args.WorkflowID,
		SourceVersionID: args.SourceVersionID, NewID: d.NewID,
	})
	switch {
	case err == nil:
	case errors.Is(err, engine.ErrWorkflowLifecycleNotFound):
		return expected("workflow not found")
	case errors.Is(err, engine.ErrRollbackSourceNotFound):
		return expected("source version not found; workflows.get lists versions")
	case errors.Is(err, engine.ErrWorkflowVersionMalformed):
		return expected("source version is malformed")
	case errors.Is(err, engine.ErrWorkflowRollbackRolloutLive):
		return expected("finish the active workflow rollout before rolling back")
	case errors.Is(err, engine.ErrWorkflowRollbackConflict):
		return expected("concurrent rollback conflict; retry")
	default:
		return nil, nil, err
	}
	d.Audit.Write(ctx, d.Pool, d.auditContext(), "workflow.rolled_back", audit.Options{
		TargetType: "workflow", TargetID: args.WorkflowID,
		Metadata: map[string]any{
			"sourceVersionId": args.SourceVersionID, "sourceVersion": committed.SourceVersion,
			"newVersion": committed.Version, "attempts": committed.Attempts,
		},
	})
	return ok(map[string]any{
		"workflowId": args.WorkflowID, "versionId": committed.VersionID,
		"version": committed.Version, "sourceVersion": committed.SourceVersion,
	})
}

func (d Deps) setWorkflowActive(ctx context.Context, workflowID string, active bool) (*mcp.CallToolResult, any, error) {
	toolName, action := "workflows.deactivate", audit.Action("workflow.deleted")
	if active {
		toolName, action = "workflows.reactivate", "workflow.restored"
	}
	if allowed, message := d.guardTool(ctx, toolName, "workflows.write", true); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(workflowID) {
		return expected("workflowId is required and must be at most 256 characters")
	}
	if visible, err := d.workflowVisible(ctx, workflowID); err != nil || !visible {
		if active {
			return hiddenResult(err, "workflow not found or already active")
		}
		return hiddenResult(err, "workflow not found or already deactivated")
	}
	var err error
	if active {
		err = d.Engine.ReactivateWorkflow(ctx, d.OrgID, workflowID, d.UserID)
	} else {
		err = d.Engine.DeactivateWorkflow(ctx, d.OrgID, workflowID)
	}
	switch {
	case err == nil:
	case errors.Is(err, engine.ErrWorkflowLifecycleNotFound) && active:
		return expected("workflow not found or already active")
	case errors.Is(err, engine.ErrWorkflowLifecycleNotFound):
		return expected("workflow not found or already deactivated")
	case errors.Is(err, engine.ErrWorkflowVersionMalformed):
		return expected("latest workflow version is malformed")
	default:
		return nil, nil, err
	}
	options := audit.Options{TargetType: "workflow", TargetID: workflowID}
	if !active {
		options.Metadata = map[string]any{"soft": true}
	}
	d.Audit.Write(ctx, d.Pool, d.auditContext(), action, options)
	return ok(map[string]any{"workflowId": workflowID, "active": active})
}

func (d Deps) pauseWorkflow(ctx context.Context, args workflowPauseArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.pause", "workflows.write", true); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(args.WorkflowID) {
		return expected("workflowId is required and must be at most 256 characters")
	}
	if visible, err := d.workflowVisible(ctx, args.WorkflowID); err != nil || !visible {
		return hiddenResult(err, "workflow not found")
	}
	reason := boundedMCPText(args.Reason, engine.MaxPauseReasonRunes)
	previous, err := d.Engine.PauseWorkflow(ctx, d.OrgID, args.WorkflowID, reason)
	switch {
	case err == nil:
	case errors.Is(err, engine.ErrWorkflowLifecycleNotFound):
		return expected("workflow not found")
	default:
		return nil, nil, err
	}
	changed := previous != engine.WorkflowStatusPausedManual
	if changed {
		d.Audit.Write(ctx, d.Pool, d.auditContext(), "workflow.paused", audit.Options{
			TargetType: "workflow", TargetID: args.WorkflowID,
			Metadata: map[string]any{"previousStatus": previous, "hasReason": reason != ""},
		})
	}
	return ok(map[string]any{"workflowId": args.WorkflowID, "status": engine.WorkflowStatusPausedManual, "changed": changed})
}

func (d Deps) resumeWorkflow(ctx context.Context, workflowID string) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "workflows.resume", "workflows.write", true); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(workflowID) {
		return expected("workflowId is required and must be at most 256 characters")
	}
	if visible, err := d.workflowVisible(ctx, workflowID); err != nil || !visible {
		return hiddenResult(err, "workflow not found")
	}
	outcome, lifted, err := d.Engine.ResumeWorkflow(ctx, d.OrgID, workflowID, d.UserID)
	var notResumable *engine.ErrWorkflowNotResumable
	switch {
	case err == nil:
	case errors.Is(err, engine.ErrWorkflowNotFoundForResume):
		return expected("workflow not found")
	case errors.As(err, &notResumable):
		return expected("an upstream this workflow depends on is degraded; it resumes when the upstream recovers (status: " + notResumable.Status + ")")
	default:
		return nil, nil, err
	}
	if lifted == engine.WorkflowStatusPausedManual {
		d.Audit.Write(ctx, d.Pool, d.auditContext(), "workflow.resumed", audit.Options{TargetType: "workflow", TargetID: workflowID})
	}
	if outcome.Backfilled > 0 || outcome.Failed > 0 {
		d.Audit.Write(ctx, d.Pool, d.auditContext(), "workflow.trigger_backfill", audit.Options{
			TargetType: "workflow", TargetID: workflowID,
			Metadata: map[string]any{
				"backfilled": outcome.Backfilled, "failed": outcome.Failed, "remaining": outcome.Remaining,
			},
		})
	}
	return ok(map[string]any{
		"workflowId": workflowID, "status": "active", "changed": lifted != "",
		"backfilled": outcome.Backfilled, "failed": outcome.Failed, "remaining": outcome.Remaining,
	})
}

func (d Deps) runOutput(ctx context.Context, args runOutputArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "runs.output", "runs.read", false); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(args.RunID) || !validOptionalMCPIdentifier(args.NodeID) {
		return expected("runId is required; runId and nodeId must be at most 256 characters")
	}
	if visible, err := d.runVisible(ctx, args.RunID); err != nil || !visible {
		return hiddenResult(err, "run not found")
	}
	q := store.New(d.Pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: args.RunID, OrgID: d.OrgID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("run not found")
		}
		return nil, nil, err
	}
	nodes, err := q.ListRunNodesByRunForOrg(ctx, store.ListRunNodesByRunForOrgParams{RunID: args.RunID, OrgID: d.OrgID})
	if err != nil {
		return nil, nil, err
	}
	view := map[string]any{"runId": run.ID, "status": run.Status, "workflowVersionId": run.WorkflowVersionID}
	if args.NodeID == "" && len(run.OutputJson) > 0 {
		view["output"] = boundedOutputValue(run.OutputJson)
	}
	steps := map[string]any{}
	for _, node := range nodes {
		if args.NodeID != "" && node.NodeID != args.NodeID {
			continue
		}
		var state struct {
			Output json.RawMessage `json:"output"`
		}
		if json.Unmarshal(node.StateJson, &state) != nil || len(state.Output) == 0 {
			continue
		}
		steps[node.NodeID] = boundedOutputValue(state.Output)
	}
	if args.NodeID != "" && len(steps) == 0 {
		return expected("step has no recorded output")
	}
	view["steps"] = steps
	return ok(view)
}

// boundedOutputValue keeps one persisted output out of the model's context
// when it is large, and scrubs secret-shaped literals from the rest.
func boundedOutputValue(raw json.RawMessage) any {
	if len(raw) > maxMCPOutputValueBytes {
		return map[string]any{"omitted": "exceeds 32000 bytes", "bytes": len(raw)}
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return map[string]any{"omitted": "unreadable"}
	}
	return scrubSecretShapes(value)
}

func (d Deps) cancelRun(ctx context.Context, args runCancelArgs) (*mcp.CallToolResult, any, error) {
	if allowed, message := d.guardTool(ctx, "runs.cancel", "runs.cancel", true); !allowed {
		return expected(message)
	}
	if !validMCPIdentifier(args.RunID) {
		return expected("runId is required and must be at most 256 characters")
	}
	if visible, err := d.runVisible(ctx, args.RunID); err != nil || !visible {
		return hiddenResult(err, "run not found")
	}
	if _, err := store.New(d.Pool).GetRun(ctx, store.GetRunParams{ID: args.RunID, OrgID: d.OrgID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return expected("run not found")
		}
		return nil, nil, err
	}
	var reason any
	if text := boundedMCPText(args.Reason, maxMCPErrorSummaryRunes); text != "" {
		reason = text
	}
	if err := d.Engine.CancelRun(ctx, args.RunID, reason); err != nil {
		if errors.Is(err, engine.ErrRunAlreadyTerminal) {
			return expected("run already finished; nothing to cancel")
		}
		return nil, nil, err
	}
	d.Audit.Write(ctx, d.Pool, d.auditContext(), "run.cancelled", audit.Options{
		TargetType: "run", TargetID: args.RunID, Metadata: map[string]any{"reason": reason},
	})
	return ok(map[string]any{"runId": args.RunID, "status": "cancelled"})
}
