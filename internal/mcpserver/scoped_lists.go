package mcpserver

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/johnny4young/janusly/internal/store"
)

// The scoped lists filter in SQL, so a page never comes back short because
// rows outside the scope were dropped after the query.

func (d Deps) scopedWorkflows(ctx context.Context, page pageWindow) (*mcp.CallToolResult, any, error) {
	ids, err := d.scopeList(ctx)
	if err != nil {
		return nil, nil, err
	}
	rows, err := store.New(d.Pool).ListAgentScopedWorkflows(ctx, store.ListAgentScopedWorkflowsParams{
		OrgID: d.OrgID, WorkflowIds: ids, BeforeCreatedAt: page.before, BeforeID: page.beforeID,
		PageLimit: page.limit + 1,
	})
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

func (d Deps) scopedRuns(ctx context.Context, page pageWindow, workflowID, status string) (*mcp.CallToolResult, any, error) {
	ids, err := d.scopeList(ctx)
	if err != nil {
		return nil, nil, err
	}
	rows, err := store.New(d.Pool).ListAgentScopedRuns(ctx, store.ListAgentScopedRunsParams{
		OrgID: d.OrgID, WorkflowIds: ids, BeforeCreatedAt: page.before, BeforeID: page.beforeID,
		FilterWorkflowID: pgtype.Text{String: workflowID, Valid: workflowID != ""},
		FilterStatus:     pgtype.Text{String: status, Valid: status != ""},
		PageLimit:        page.limit + 1,
	})
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
			"runId": row.ID, "status": row.Status, "workflowId": row.WorkflowID.String,
			"workflowName": boundedMCPText(row.WorkflowName, 240),
			"createdAt":    createdAtISO(row.CreatedAt),
		})
	}
	payload := map[string]any{"runs": items, "hasMore": hasMore}
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		payload["nextCursor"] = createdAtISO(last.CreatedAt) + "|" + last.ID
	}
	return ok(payload)
}

func (d Deps) scopedDeadLetters(ctx context.Context, page pageWindow) (*mcp.CallToolResult, any, error) {
	ids, err := d.scopeList(ctx)
	if err != nil {
		return nil, nil, err
	}
	rows, err := store.New(d.Pool).ListAgentScopedDeadLetters(ctx, store.ListAgentScopedDeadLettersParams{
		OrgID: d.OrgID, WorkflowIds: ids, BeforeCreatedAt: page.before, BeforeID: page.beforeID,
		PageLimit: page.limit + 1,
	})
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
