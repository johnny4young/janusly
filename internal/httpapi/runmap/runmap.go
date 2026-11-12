// Package runmap serves the read models behind the run map: per-step state,
// time, cost, a stuck signal and agent lanes for one run, and the decisions
// waiting on the viewer across the organization.
package runmap

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/publishgate"
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
	read := httpkit.Gate{Role: auth.RoleViewer, Permission: "runs.read"}
	inbox := httpkit.Gate{Role: auth.RoleViewer}
	deps.Routes.Route(mux, "GET /runs/{runId}/map", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.runMap(r, rc))
	})
	deps.Routes.Route(mux, "GET /v1/runs/{runId}/map", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteVersioned(w, rc.ID, s.runMap(r, rc))
	})
	deps.Routes.Route(mux, "GET /needs-you", inbox, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.needsYou(r, rc))
	})
	deps.Routes.Route(mux, "GET /v1/needs-you", inbox, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteVersioned(w, rc.ID, s.needsYou(r, rc))
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
	permissions := map[string]bool{}
	if run.Status == "running" && !run.ReplayMode.Valid {
		permissions = s.deciderPermissions(r, rc)
	}
	pending, err := q.ListPendingToolApprovalRequesters(ctx, store.ListPendingToolApprovalRequestersParams{OrgID: rc.OrgID, RunID: runID})
	if err != nil {
		return internalError()
	}
	requesters := map[string][]string{}
	for _, row := range pending {
		requesters[row.NodeID] = append([]string{}, row.RequesterIds...)
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
	// Sessions name agent clients, so only viewers with agents.read see them.
	var linked []store.ListAgentSessionsForRunRow
	if s.viewerHolds(r, rc, "agents.read") {
		linked, err = q.ListAgentSessionsForRun(ctx, store.ListAgentSessionsForRunParams{OrgID: rc.OrgID, RunID: runID})
		if err != nil {
			return internalError()
		}
	}
	sessions := make([]map[string]any, 0, len(linked))
	for _, session := range linked {
		sessions = append(sessions, map[string]any{
			"id": session.ID, "agentClientName": session.AgentClientName, "runtime": session.Runtime,
		})
	}
	return httpkit.OK(map[string]any{
		"run": map[string]any{
			"id": run.ID, "status": run.Status, "workflowVersionId": run.WorkflowVersionID,
			"parentRunId": optionalText(run.ParentRunID),
		},
		"nodes": views, "lanes": lanes, "totals": totals, "sessions": sessions,
	})
}

// typicalDurations holds a median only for steps with history.
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
		Waiting     map[string]any `json:"waiting"`
		Subworkflow struct {
			ChildRunID string `json:"childRunId"`
		} `json:"subworkflow"`
	}
	_ = json.Unmarshal(node.StateJson, &state)
	// A redriven or reclaimed step keeps its previous attempt's finished_at.
	finishedAt := node.FinishedAt
	if slices.Contains([]string{"pending", "queued", "running", "waiting"}, node.Status) {
		finishedAt = nil
	}
	view := map[string]any{
		"nodeId": node.NodeID, "type": nodeType, "status": node.Status, "attempts": node.Attempts,
		"startedAt": optionalTime(node.StartedAt), "finishedAt": optionalTime(finishedAt),
		"elapsedMs": nil, "costUsd": cost.CostUsd, "tokens": cost.Tokens,
		"stuck": false, "needsYou": false, "waitingKind": nil, "childRunId": nil,
	}
	if node.StartedAt != nil {
		end := now
		if finishedAt != nil {
			end = *finishedAt
		}
		elapsed := end.Sub(*node.StartedAt)
		view["elapsedMs"] = elapsed.Milliseconds()
		if node.Status == "running" {
			median, ok := typical[node.NodeID]
			view["stuck"] = isStuck(elapsed, median, ok)
		}
	}
	if kind, _ := state.Waiting["kind"].(string); node.Status == "waiting" && kind != "" {
		view["waitingKind"] = kind
		view["needsYou"] = canDecide(kind, permissions, requesters, viewer) && formResumable(kind, state.Waiting, now)
	}
	if childRunID, _ := state.Waiting["childRunId"].(string); childRunID != "" {
		view["childRunId"] = childRunID
	} else if state.Subworkflow.ChildRunID != "" {
		view["childRunId"] = state.Subworkflow.ChildRunID
	} else if node.FailedChildRunID != "" {
		view["childRunId"] = node.FailedChildRunID
	}
	return view
}

func isStuck(elapsed time.Duration, medianMs float64, hasHistory bool) bool {
	if !hasHistory {
		return elapsed > stuckNoHistory
	}
	limit := max(time.Duration(medianMs*stuckFactor)*time.Millisecond, stuckFloor)
	return elapsed > limit
}

// canDecide mirrors the decision routes: person steps need runs.start, and a
// tool approval needs a live request and refuses the people who caused the call.
// requesters is nil when the step has no live request.
func canDecide(kind string, permissions map[string]bool, requesters []string, viewer string) bool {
	if !permissions["runs.start"] {
		return false
	}
	switch kind {
	case "approval", "human_form":
		return true
	case "tool_approval":
		return requesters != nil && !slices.Contains(requesters, viewer)
	}
	return false
}

// formResumable is false once a form's resume token has expired: nothing
// re-issues it, so the resume route refuses every submission.
func formResumable(kind string, waiting map[string]any, now time.Time) bool {
	if kind != "human_form" {
		return true
	}
	raw, _ := waiting["resumeTokenExpiresAt"].(string)
	expiresAt, err := time.Parse(time.RFC3339, raw)
	return err == nil && now.Before(expiresAt)
}

func (s *service) lanes(r *http.Request, rc httpkit.Request, runID string, types map[string]string) ([]map[string]any, error) {
	// One event past the bound tells a full lane from a truncated one.
	events, err := store.New(s.pool).ListRunAgentEvents(r.Context(), store.ListRunAgentEventsParams{OrgID: rc.OrgID, RunID: runID, PerNode: maxLaneEvents + 1})
	if err != nil {
		return nil, err
	}
	byNode := map[string][]map[string]any{}
	order := []string{}
	for _, event := range events {
		if _, seen := byNode[event.NodeID]; !seen {
			order = append(order, event.NodeID)
		}
		byNode[event.NodeID] = append(byNode[event.NodeID], laneStep(event))
	}
	lanes := make([]map[string]any, 0, len(order))
	for _, nodeID := range order {
		steps := byNode[nodeID]
		truncated := len(steps) > maxLaneEvents
		if truncated {
			steps = steps[len(steps)-maxLaneEvents:]
		}
		lanes = append(lanes, map[string]any{"nodeId": nodeID, "kind": types[nodeID], "steps": steps, "truncated": truncated})
	}
	return lanes, nil
}

// laneStep keeps only typed payload fields, so a malformed event cannot widen
// the wire.
func laneStep(event store.ListRunAgentEventsRow) map[string]any {
	var payload map[string]any
	_ = json.Unmarshal(event.Payload, &payload)
	step := map[string]any{"type": event.Type, "at": optionalTime(event.CreatedAt)}
	for _, key := range []string{"tool", "status", "agent", "name"} {
		if value, ok := payload[key].(string); ok && value != "" {
			step[key] = value
		}
	}
	// A planned step names its tool inside the plan.
	if plan, ok := payload["plan"].(map[string]any); ok && step["tool"] == nil {
		if tool, ok := plan["tool"].(string); ok && tool != "" {
			step["tool"] = tool
		}
	}
	for _, key := range []string{"iteration", "index"} {
		if value, ok := payload[key].(float64); ok && value >= 0 && value == float64(int64(value)) {
			step[key] = int64(value)
		}
	}
	return step
}

// viewerHolds reports whether the viewer's live grant includes permission,
// resolved the way the route gate resolves it.
func (s *service) viewerHolds(r *http.Request, rc httpkit.Request, permission string) bool {
	if rc.Auth == nil {
		return false
	}
	q := store.New(s.pool)
	role, err := auth.ResolveRoleFromMembership(r.Context(), q, rc.OrgID, rc.Auth.MembershipRole, rc.Auth.Mode)
	if err != nil || role == nil {
		return false
	}
	permissions, err := auth.EffectivePermissions(r.Context(), q, rc.OrgID, role)
	return err == nil && permissions[permission]
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
// not cause, approval and form steps (runs.start and runs.read, since each
// names a run), and agent publish requests.
func (s *service) needsYou(r *http.Request, rc httpkit.Request) httpkit.Result {
	ctx := r.Context()
	q := store.New(s.pool)
	permissions := s.deciderPermissions(r, rc)
	items := []map[string]any{}
	if permissions["runs.start"] && permissions["runs.read"] {
		approvals, err := q.ListPendingToolApprovalsForOrg(ctx, store.ListPendingToolApprovalsForOrgParams{OrgID: rc.OrgID, Viewer: rc.UserID})
		if err != nil {
			return internalError()
		}
		for _, row := range approvals {
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
		requests, err := q.ListPublishRequests(ctx, store.ListPublishRequestsParams{OrgID: rc.OrgID, FilterStatus: publishgate.OptionalText("pending")})
		if err != nil {
			return internalError()
		}
		secondPerson, err := s.secondPersonRequired(r, rc)
		if err != nil {
			secondPerson = true
		}
		var creators map[string]string
		if secondPerson {
			creators = s.agentCreators(r, rc, requests)
		}
		now := s.now()
		for _, row := range requests {
			if row.RequestedBy == rc.UserID || !now.Before(row.ExpiresAt) {
				continue
			}
			if secondPerson && accountableFor(rc.UserID, row, creators) {
				continue
			}
			reasons := row.Reasons
			if reasons == nil {
				reasons = []string{}
			}
			items = append(items, map[string]any{"kind": "publish_request", "id": row.ID, "workflowId": row.WorkflowID,
				"reasons": reasons, "requestedBy": row.RequestedBy, "expiresAt": row.ExpiresAt.UTC().Format(time.RFC3339)})
		}
	}
	if permissions["agents.write"] && permissions["agents.read"] {
		gates, err := q.ListPendingAgentGatesForOrg(ctx, store.ListPendingAgentGatesForOrgParams{OrgID: rc.OrgID, Now: s.now().UTC()})
		if err != nil {
			return internalError()
		}
		secondPerson := len(gates) > 0
		if secondPerson {
			if secondPerson, err = s.secondPersonRequired(r, rc); err != nil {
				secondPerson = true
			}
		}
		for _, gate := range gates {
			if secondPerson && gate.ClientCreatedBy == rc.UserID {
				continue
			}
			items = append(items, map[string]any{"kind": "agent_gate", "id": gate.ID, "sessionId": gate.SessionID,
				"tool": gate.Tool, "agentClientName": gate.AgentClientName, "expiresAt": gate.ExpiresAt.UTC().Format(time.RFC3339)})
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

// accountableFor fails closed: a drafting agent whose creator is unknown
// counts as the viewer's.
func accountableFor(viewer string, row store.PublishRequest, creators map[string]string) bool {
	if row.OnBehalfOf == viewer || row.DraftedBy == viewer {
		return true
	}
	clientID, ok := strings.CutPrefix(row.DraftedBy, "agent:")
	if !ok {
		return false
	}
	creator, known := creators[clientID]
	return !known || creator == viewer
}

// agentCreators reads the creators of every drafting agent in one query.
func (s *service) agentCreators(r *http.Request, rc httpkit.Request, requests []store.PublishRequest) map[string]string {
	seen := map[string]struct{}{}
	for _, row := range requests {
		if clientID, ok := strings.CutPrefix(row.DraftedBy, "agent:"); ok {
			seen[clientID] = struct{}{}
		}
	}
	creators := map[string]string{}
	if len(seen) == 0 {
		return creators
	}
	ids := slices.Collect(maps.Keys(seen))
	rows, err := store.New(s.pool).ListAgentClientCreators(r.Context(), store.ListAgentClientCreatorsParams{OrgID: rc.OrgID, Ids: ids})
	if err != nil {
		return creators
	}
	for _, row := range rows {
		creators[row.ID] = row.CreatedBy
	}
	return creators
}

// secondPersonKey is publishrequests.SecondPersonKey; feature packages do not
// import each other.
const secondPersonKey = "agents.publishRequiresSecondPerson"

func optionalText(value pgtype.Text) any {
	if !value.Valid || value.String == "" {
		return nil
	}
	return value.String
}

func optionalTime(at *time.Time) any {
	if at == nil {
		return nil
	}
	return at.UTC().Format(time.RFC3339Nano)
}

func internalError() httpkit.Result {
	return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
}
