// Package runmap serves the read models behind the run map: per-step state,
// time, cost, a stuck signal and agent lanes for one run, and the decisions
// waiting on the viewer across the organization.
package runmap

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	// A step is stuck when it runs three times longer than it usually takes,
	// and never before stuckFloor; without history, after stuckNoHistory.
	stuckFactor    = 3
	stuckFloor     = 30 * time.Second
	stuckNoHistory = 10 * time.Minute
	maxLaneEvents  = 200
)

// Deps are the shared API dependencies.
type Deps struct {
	Pool   *pgxpool.Pool
	Routes httpkit.Registrar
	Now    func() time.Time
}

type service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// Mount registers the run map routes.
func Mount(mux *http.ServeMux, deps Deps) {
	s := &service{pool: deps.Pool, now: deps.Now}
	if s.now == nil {
		s.now = time.Now
	}
	deps.Routes.Route(mux, "GET /runs/{runId}/map", httpkit.Gate{Role: auth.RoleViewer, Permission: "runs.read"},
		func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
			httpkit.WriteUnversioned(w, s.runMap(r, rc))
		})
	deps.Routes.Route(mux, "GET /needs-you", httpkit.Gate{Role: auth.RoleViewer},
		func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
			httpkit.WriteUnversioned(w, s.needsYou(r, rc))
		})
}

type workflowSnapshot struct {
	Workflow struct {
		Nodes []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"nodes"`
	} `json:"workflow"`
}

func (s *service) runMap(r *http.Request, rc httpkit.Request) httpkit.Result {
	ctx := r.Context()
	q := store.New(s.pool)
	runID := r.PathValue("runId")
	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: rc.OrgID})
	if errors.Is(err, pgx.ErrNoRows) {
		return httpkit.Error(http.StatusNotFound, "run_not_found", "run not found", nil)
	}
	if err != nil {
		return internalError()
	}
	var snapshot workflowSnapshot
	_ = json.Unmarshal(run.InputJson, &snapshot)
	types := map[string]string{}
	for _, node := range snapshot.Workflow.Nodes {
		types[node.ID] = node.Type
	}
	nodes, err := q.ListRunMapNodes(ctx, store.ListRunMapNodesParams{OrgID: rc.OrgID, RunID: runID})
	if err != nil {
		return internalError()
	}
	costs, err := q.ListRunNodeCosts(ctx, store.ListRunNodeCostsParams{OrgID: rc.OrgID, RunID: pgtype.Text{String: runID, Valid: true}})
	if err != nil {
		return internalError()
	}
	costByNode := map[string]store.ListRunNodeCostsRow{}
	totals := map[string]any{"costUsd": 0.0, "tokens": int64(0)}
	for _, cost := range costs {
		costByNode[cost.NodeID] = cost
		totals["costUsd"] = totals["costUsd"].(float64) + cost.CostUsd
		totals["tokens"] = totals["tokens"].(int64) + cost.Tokens
	}
	typical := s.typicalDurations(r, rc, runID, nodes)
	permissions := s.deciderPermissions(r, rc)
	pending, err := q.ListPendingToolApprovalRequesters(ctx, store.ListPendingToolApprovalRequestersParams{OrgID: rc.OrgID, RunID: runID})
	if err != nil {
		return internalError()
	}
	requesters := map[string][]string{}
	for _, row := range pending {
		requesters[row.NodeID] = row.RequesterIds
	}
	now := s.now()
	views := make([]map[string]any, 0, len(nodes))
	for _, node := range nodes {
		views = append(views, s.nodeView(node, types[node.NodeID], costByNode[node.NodeID], typical, permissions, requesters[node.NodeID], rc.UserID, now))
	}
	lanes, err := s.lanes(r, rc, runID, types)
	if err != nil {
		return internalError()
	}
	return httpkit.OK(map[string]any{
		"run": map[string]any{
			"id": run.ID, "status": run.Status, "workflowVersionId": run.WorkflowVersionID,
			"parentRunId": run.ParentRunID.String,
		},
		"nodes": views, "lanes": lanes, "totals": totals,
	})
}

func (s *service) typicalDurations(r *http.Request, rc httpkit.Request, runID string, nodes []store.ListRunMapNodesRow) map[string]float64 {
	workflowID, err := store.New(s.pool).GetRunWorkflowForOrg(r.Context(), store.GetRunWorkflowForOrgParams{OrgID: rc.OrgID, ID: runID})
	out := map[string]float64{}
	if err != nil || workflowID.WorkflowID == "" {
		return out
	}
	running := []string{}
	for _, node := range nodes {
		if node.Status == "running" {
			running = append(running, node.NodeID)
		}
	}
	if len(running) == 0 {
		return out
	}
	rows, err := store.New(s.pool).ListRunNodeTypicalDurations(r.Context(), store.ListRunNodeTypicalDurationsParams{
		OrgID: rc.OrgID, WorkflowID: workflowID.WorkflowID, RunID: runID, NodeIds: running,
	})
	if err != nil {
		return out
	}
	for _, row := range rows {
		out[row.NodeID] = row.MedianMs
	}
	return out
}

func (s *service) nodeView(node store.ListRunMapNodesRow, nodeType string, cost store.ListRunNodeCostsRow,
	typical map[string]float64, permissions map[string]bool, requesters []string, viewer string, now time.Time) map[string]any {
	var state struct {
		Waiting    map[string]any `json:"waiting"`
		ChildRunID string         `json:"childRunId"`
	}
	_ = json.Unmarshal(node.StateJson, &state)
	view := map[string]any{
		"nodeId": node.NodeID, "type": nodeType, "status": node.Status, "attempts": node.Attempts,
		"startedAt": optionalTime(node.StartedAt), "finishedAt": optionalTime(node.FinishedAt),
		"elapsedMs": nil, "costUsd": cost.CostUsd, "tokens": cost.Tokens,
		"stuck": false, "needsYou": false, "waitingKind": nil, "childRunId": nil,
	}
	if node.StartedAt != nil {
		end := now
		if node.FinishedAt != nil {
			end = *node.FinishedAt
		}
		elapsed := end.Sub(*node.StartedAt)
		view["elapsedMs"] = elapsed.Milliseconds()
		if node.Status == "running" {
			view["stuck"] = isStuck(elapsed, typical[node.NodeID])
		}
	}
	if kind, _ := state.Waiting["kind"].(string); node.Status == "waiting" && kind != "" {
		view["waitingKind"] = kind
		view["needsYou"] = canDecide(kind, permissions, requesters, viewer)
	}
	if childRunID, _ := state.Waiting["childRunId"].(string); childRunID != "" {
		view["childRunId"] = childRunID
	} else if state.ChildRunID != "" {
		view["childRunId"] = state.ChildRunID
	}
	return view
}

func isStuck(elapsed time.Duration, medianMs float64) bool {
	if medianMs <= 0 {
		return elapsed > stuckNoHistory
	}
	limit := max(time.Duration(medianMs*stuckFactor)*time.Millisecond, stuckFloor)
	return elapsed > limit
}

// canDecide mirrors the decision routes: person steps need runs.start, and a
// tool approval also refuses the people who caused the call.
func canDecide(kind string, permissions map[string]bool, requesters []string, viewer string) bool {
	if !permissions["runs.start"] {
		return false
	}
	switch kind {
	case "approval", "human_form":
		return true
	case "tool_approval":
		return !slices.Contains(requesters, viewer)
	}
	return false
}

func (s *service) lanes(r *http.Request, rc httpkit.Request, runID string, types map[string]string) ([]map[string]any, error) {
	events, err := store.New(s.pool).ListRunAgentEvents(r.Context(), store.ListRunAgentEventsParams{OrgID: rc.OrgID, RunID: runID})
	if err != nil {
		return nil, err
	}
	byNode := map[string][]map[string]any{}
	order := []string{}
	for _, event := range events {
		if _, seen := byNode[event.NodeID]; !seen {
			order = append(order, event.NodeID)
		}
		if len(byNode[event.NodeID]) >= maxLaneEvents {
			continue
		}
		var payload map[string]any
		_ = json.Unmarshal(event.Payload, &payload)
		step := map[string]any{"type": event.Type, "at": optionalTime(event.CreatedAt)}
		for _, key := range []string{"tool", "status", "step", "agent"} {
			if value, ok := payload[key]; ok {
				step[key] = value
			}
		}
		byNode[event.NodeID] = append(byNode[event.NodeID], step)
	}
	lanes := make([]map[string]any, 0, len(order))
	for _, nodeID := range order {
		lanes = append(lanes, map[string]any{"nodeId": nodeID, "kind": types[nodeID], "steps": byNode[nodeID]})
	}
	return lanes, nil
}

// deciderPermissions is the viewer's grant when they can decide at all: a
// person with at least editor rank, as every decision route requires.
func (s *service) deciderPermissions(r *http.Request, rc httpkit.Request) map[string]bool {
	if rc.Auth == nil || !auth.IsPersonMode(rc.Auth.Mode) {
		return map[string]bool{}
	}
	q := store.New(s.pool)
	role, err := auth.ResolveRoleFromMembership(r.Context(), q, rc.OrgID, rc.Auth.MembershipRole, rc.Auth.Mode)
	if err != nil || role == nil || auth.Rank[role.InheritsFrom] < auth.Rank[auth.RoleEditor] {
		return map[string]bool{}
	}
	permissions, err := auth.EffectivePermissions(r.Context(), q, rc.OrgID, role)
	if err != nil || permissions == nil {
		return map[string]bool{}
	}
	return permissions
}

// needsYou lists the decisions waiting on the viewer: tool approvals they did
// not cause, approval and form steps, and agent publish requests.
func (s *service) needsYou(r *http.Request, rc httpkit.Request) httpkit.Result {
	ctx := r.Context()
	q := store.New(s.pool)
	permissions := s.deciderPermissions(r, rc)
	items := []map[string]any{}
	if permissions["runs.start"] {
		approvals, err := q.ListPendingToolApprovalsForOrg(ctx, rc.OrgID)
		if err != nil {
			return internalError()
		}
		for _, row := range approvals {
			if slices.Contains(row.RequesterIds, rc.UserID) {
				continue
			}
			items = append(items, map[string]any{"kind": "tool_approval", "id": row.ID, "runId": row.RunID,
				"nodeId": row.NodeID, "workflowId": row.WorkflowID, "tool": row.Tool,
				"expiresAt": row.ExpiresAt.UTC().Format(time.RFC3339)})
		}
		steps, err := q.ListWaitingPersonStepsForOrg(ctx, rc.OrgID)
		if err != nil {
			return internalError()
		}
		for _, row := range steps {
			items = append(items, map[string]any{"kind": row.Kind, "runId": row.RunID, "nodeId": row.NodeID,
				"workflowId": row.WorkflowID, "since": optionalTime(row.StartedAt)})
		}
	}
	if permissions["workflows.write"] {
		requests, err := q.ListPublishRequests(ctx, store.ListPublishRequestsParams{OrgID: rc.OrgID, FilterStatus: pendingStatus()})
		if err != nil {
			return internalError()
		}
		secondPerson, err := s.secondPersonRequired(r, rc)
		if err != nil {
			secondPerson = true
		}
		now := s.now()
		for _, row := range requests {
			if row.RequestedBy == rc.UserID || !now.Before(row.ExpiresAt) {
				continue
			}
			if secondPerson && s.accountableFor(r, rc, row) {
				continue
			}
			items = append(items, map[string]any{"kind": "publish_request", "id": row.ID, "workflowId": row.WorkflowID,
				"reasons": row.Reasons, "requestedBy": row.RequestedBy, "expiresAt": row.ExpiresAt.UTC().Format(time.RFC3339)})
		}
	}
	return httpkit.OK(map[string]any{"items": items})
}

// secondPersonRequired and accountableFor mirror the approval route, so the
// inbox never offers a decision that route would refuse.
func (s *service) secondPersonRequired(r *http.Request, rc httpkit.Request) (bool, error) {
	raw, err := store.New(s.pool).GetOrgConfigValue(r.Context(), store.GetOrgConfigValueParams{OrgID: rc.OrgID, Key: secondPersonKey})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var required bool
	return json.Unmarshal(raw, &required) == nil && required, nil
}

func (s *service) accountableFor(r *http.Request, rc httpkit.Request, row store.PublishRequest) bool {
	if row.OnBehalfOf == rc.UserID || row.DraftedBy == rc.UserID {
		return true
	}
	clientID, ok := strings.CutPrefix(row.DraftedBy, "agent:")
	if !ok {
		return false
	}
	client, err := store.New(s.pool).GetAgentClient(r.Context(), store.GetAgentClientParams{OrgID: rc.OrgID, ID: clientID})
	return err != nil || client.CreatedBy == rc.UserID
}

// secondPersonKey is publishrequests.SecondPersonKey; feature packages do not
// import each other.
const secondPersonKey = "agents.publishRequiresSecondPerson"

func optionalTime(at *time.Time) any {
	if at == nil {
		return nil
	}
	return at.UTC().Format(time.RFC3339Nano)
}

func internalError() httpkit.Result {
	return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
}

func pendingStatus() pgtype.Text { return pgtype.Text{String: "pending", Valid: true} }
