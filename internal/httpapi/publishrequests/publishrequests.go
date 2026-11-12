// Package publishrequests serves the people-only routes that review, approve
// and reject an agent's publish request.
package publishrequests

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/publishgate"
	"github.com/johnny4young/janusly/internal/store"
)

func init() {
	for _, action := range []audit.Action{"publish_request.approved", "publish_request.rejected"} {
		audit.RegisterRuntimeAction(action)
	}
}

// SecondPersonKey makes an organization require someone other than the
// agent's creator to approve its publications.
const SecondPersonKey = "agents.publishRequiresSecondPerson"

const (
	maxBodyBytes    = 4 << 10
	maxReasonLength = 500
)

// Deps are the shared API dependencies.
type Deps struct {
	Audit  audit.Writer
	Pool   *pgxpool.Pool
	Engine *engine.Engine
	Routes httpkit.Registrar
}

type service struct {
	audit audit.Writer
	pool  *pgxpool.Pool
	gate  publishgate.Gate
}

// Mount registers the publish request routes.
func Mount(mux *http.ServeMux, deps Deps) {
	s := &service{audit: deps.Audit, pool: deps.Pool,
		gate: publishgate.Gate{Engine: deps.Engine, Pool: deps.Pool, NewID: uuid.NewString}}
	read := httpkit.Gate{Role: auth.RoleViewer, Permission: "workflows.read"}
	decide := httpkit.Gate{Role: auth.RoleEditor, Permission: "workflows.write"}
	routes := []struct {
		pattern string
		gate    httpkit.Gate
		handle  func(*http.Request, httpkit.Request) httpkit.Result
	}{
		{"GET /publish-requests", read, s.list},
		{"GET /publish-requests/{id}", read, s.get},
		{"POST /publish-requests/{id}/approve", decide, func(r *http.Request, rc httpkit.Request) httpkit.Result { return s.decide(r, rc, true) }},
		{"POST /publish-requests/{id}/reject", decide, func(r *http.Request, rc httpkit.Request) httpkit.Result { return s.decide(r, rc, false) }},
	}
	for _, route := range routes {
		method, path, _ := strings.Cut(route.pattern, " ")
		handle := route.handle
		deps.Routes.Route(mux, route.pattern, route.gate, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
			httpkit.WriteUnversioned(w, handle(r, rc))
		})
		deps.Routes.Route(mux, method+" /v1"+path, route.gate, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
			httpkit.WriteVersioned(w, rc.ID, handle(r, rc))
		})
	}
}

func (s *service) list(r *http.Request, rc httpkit.Request) httpkit.Result {
	status := r.URL.Query().Get("status")
	switch status {
	case "", "pending", "published", "rejected", "expired", "superseded":
	default:
		return httpkit.Error(http.StatusBadRequest, "invalid_status", "status must be pending, published, rejected, expired or superseded", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	rows, err := q.ListPublishRequests(ctx, store.ListPublishRequestsParams{
		OrgID: rc.OrgID, FilterStatus: publishgate.OptionalText(status),
	})
	if err != nil {
		return internalError()
	}
	draftIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		draftIDs = append(draftIDs, row.DraftID)
	}
	names, err := q.ListDraftNames(ctx, store.ListDraftNamesParams{OrgID: rc.OrgID, Ids: draftIDs})
	if err != nil {
		return internalError()
	}
	workflowNames := make(map[string]string, len(names))
	for _, name := range names {
		workflowNames[name.ID] = name.Name
	}
	v, err := s.newViewer(ctx, rc, rows)
	if err != nil {
		return internalError()
	}
	requests := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		requests = append(requests, v.view(row, workflowNames[row.DraftID]))
	}
	return httpkit.OK(map[string]any{"requests": requests})
}

// get returns what a person reviews, in the order they decide: the effects,
// the reasons, what the draft takes away from production, the full documents
// and the qualification evidence.
func (s *service) get(r *http.Request, rc httpkit.Request) httpkit.Result {
	ctx := r.Context()
	q := store.New(s.pool)
	request, err := q.GetPublishRequest(ctx, store.GetPublishRequestParams{OrgID: rc.OrgID, ID: r.PathValue("id")})
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound()
	}
	if err != nil {
		return internalError()
	}
	draft, err := q.GetWorkflowDraft(ctx, store.GetWorkflowDraftParams{OrgID: rc.OrgID, ID: request.DraftID})
	if err != nil {
		return internalError()
	}
	receipt, err := q.GetDraftQualification(ctx, store.GetDraftQualificationParams{OrgID: rc.OrgID, ID: request.QualificationID})
	if err != nil {
		return internalError()
	}
	proposed := document(draft.Document)
	name, _ := proposed["name"].(string)
	v, err := s.newViewer(ctx, rc, []store.PublishRequest{request})
	if err != nil {
		return internalError()
	}
	view := v.view(request, name)
	wf, _ := domain.Parse(draft.Document)
	data := map[string]any{
		"request": view, "proposed": proposed, "effects": []any{}, "changes": nil,
		"qualification": map[string]any{"status": receipt.Status, "checks": jsonList(receipt.Checks), "fixtureRuns": jsonList(receipt.FixtureRuns)},
	}
	if wf != nil {
		data["effects"] = effects(wf)
	} else {
		data["effects"] = nil
	}
	currentID := ""
	latest, err := q.GetLatestWorkflowVersion(ctx, store.GetLatestWorkflowVersionParams{WorkflowID: request.WorkflowID, OrgID: rc.OrgID})
	switch {
	case err == nil:
		currentID = latest.ID
		data["current"] = map[string]any{"versionId": latest.ID, "version": latest.Version, "document": document(latest.DagJson)}
		if live, _ := domain.Parse(latest.DagJson); live != nil && wf != nil {
			data["changes"] = shrinkView(publishgate.Shrinks(live, wf))
		}
	case !errors.Is(err, pgx.ErrNoRows):
		return internalError()
	}
	// A request the decide route would refuse as stale says so before anyone
	// tries; the route still checks on its own.
	if view["status"] == "pending" && view["viewer"].(map[string]any)["refusal"] == nil {
		switch {
		case draft.BaseVersionID.String != currentID:
			view["viewer"] = map[string]any{"canDecide": false, "refusal": "stale_base"}
		case receipt.Status == "failed" || receipt.DraftID != draft.ID || receipt.Digest != draft.Digest ||
			time.Now().After(receipt.CreatedAt.Add(publishgate.ReceiptLifetime)):
			view["viewer"] = map[string]any{"canDecide": false, "refusal": "stale"}
		}
	}
	return httpkit.OK(data)
}

func shrinkView(shrink publishgate.Shrink) map[string]any {
	return map[string]any{
		"triggersChanged": nonNil(shrink.TriggersChanged), "stepsRemoved": nonNil(shrink.StepsRemoved),
		"outputsRemoved": nonNil(shrink.OutputsRemoved),
	}
}

var secretReference = regexp.MustCompile(`\{\{\s*secret\.([A-Za-z0-9_.-]+)\s*\}\}`)

// effects lists the steps that keep a draft from publishing on its receipt
// alone: what each one may write, where it reaches and which credentials it
// names. Only names travel; values never leave the credential store.
func effects(wf *domain.Workflow) []map[string]any {
	reaching := map[string]bool{}
	for _, id := range publishgate.ReachesOut(wf) {
		reaching[id] = true
	}
	out := []map[string]any{}
	for _, node := range wf.Nodes {
		if !reaching[node.ID] {
			continue
		}
		tool, _ := node.Config["tool"].(string)
		credentials := map[string]bool{}
		if input, ok := node.Config["input"].(map[string]any); ok {
			if name, ok := input["credential"].(string); ok && name != "" {
				credentials[name] = true
			}
		}
		raw, _ := json.Marshal(node.Config)
		for _, match := range secretReference.FindAllStringSubmatch(string(raw), -1) {
			credentials[match[1]] = true
		}
		out = append(out, map[string]any{
			"nodeId": node.ID, "type": node.Type, "tool": tool, "target": target(node.Config),
			"writes": engine.NodeMayHaveEffect(node), "credentials": slices.Sorted(maps.Keys(credentials)),
		})
	}
	return out
}

// target is the host a step calls, when its URL is literal.
func target(config map[string]any) string {
	raw, _ := config["url"].(string)
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || strings.Contains(raw, "{{") {
		return ""
	}
	return parsed.Host
}

// document decodes a stored workflow; a canonical document with no edges
// encodes them as null, which reads as an empty list.
func document(raw []byte) map[string]any {
	out := map[string]any{}
	_ = json.Unmarshal(raw, &out)
	for _, key := range []string{"nodes", "edges"} {
		if _, ok := out[key].([]any); !ok {
			out[key] = []any{}
		}
	}
	return out
}

func jsonList(raw []byte) []any {
	out := []any{}
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		return []any{}
	}
	return out
}

type decisionBody struct {
	Reason string `json:"reason"`
}

func (s *service) decide(r *http.Request, rc httpkit.Request, approve bool) httpkit.Result {
	if rc.Auth == nil || !auth.IsPersonMode(rc.Auth.Mode) {
		return httpkit.Error(http.StatusForbidden, "person_required", "only a person decides a publish request", nil)
	}
	var body decisionBody
	if r.ContentLength != 0 {
		if err := httpkit.DecodeBodyBounded(r, &body, maxBodyBytes); err != nil {
			return httpkit.Error(http.StatusBadRequest, "invalid_body", "request body is not a valid decision", nil)
		}
	}
	reason := strings.TrimSpace(body.Reason)
	if utf8.RuneCountInString(reason) > maxReasonLength {
		return httpkit.Error(http.StatusBadRequest, "invalid_reason", "reason must be at most 500 characters",
			map[string]any{"max": maxReasonLength})
	}
	ctx := r.Context()
	id := r.PathValue("id")
	q := store.New(s.pool)
	found, err := q.GetPublishRequest(ctx, store.GetPublishRequestParams{OrgID: rc.OrgID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound()
	}
	if err != nil {
		return internalError()
	}
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return internalError()
	}
	defer conn.Release()
	// One lock per workflow, shared with superseding: two decisions, or a
	// decision and a newer request, never interleave.
	key := "publish_workflow:" + rc.OrgID + ":" + found.WorkflowID
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, key).Scan(&locked); err != nil {
		return internalError()
	}
	if !locked {
		return httpkit.Error(http.StatusConflict, "publish_request_busy", "another decision for this workflow is in progress", nil)
	}
	defer func() {
		_, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, key)
	}()
	if err := q.ExpirePublishRequest(ctx, store.ExpirePublishRequestParams{OrgID: rc.OrgID, ID: id}); err != nil {
		return internalError()
	}
	request, err := q.GetPublishRequest(ctx, store.GetPublishRequestParams{OrgID: rc.OrgID, ID: id})
	if err != nil {
		return internalError()
	}
	if request.Status != "pending" {
		return httpkit.Error(http.StatusConflict, "publish_request_settled", "this request is already "+request.Status, nil)
	}
	if rc.UserID == request.RequestedBy {
		return httpkit.Error(http.StatusForbidden, "publish_request_requester", "the requester cannot decide its own request", nil)
	}
	if approve {
		if refused := s.secondPerson(ctx, rc, request); refused != nil {
			return *refused
		}
	}
	if !approve {
		return s.settle(ctx, rc, request, "rejected", pgtype.Text{}, reason, nil)
	}
	draft, err := q.GetWorkflowDraft(ctx, store.GetWorkflowDraftParams{OrgID: rc.OrgID, ID: request.DraftID})
	if err != nil {
		return internalError()
	}
	receipt, err := q.GetDraftQualification(ctx, store.GetDraftQualificationParams{OrgID: rc.OrgID, ID: request.QualificationID})
	if err != nil {
		return internalError()
	}
	if _, err := s.gate.UsableReceipt(ctx, draft, receipt); errors.Is(err, publishgate.ErrReceiptNotUsable) {
		return httpkit.Error(http.StatusConflict, "publish_request_stale", "the qualification expired; the agent must qualify again", nil)
	} else if err != nil {
		return internalError()
	}
	tag := ""
	if request.ScopeTag.Valid && slices.Contains(request.Reasons, "first_publish") {
		tag = request.ScopeTag.String
	}
	saved, err := s.gate.Publish(ctx, publishgate.PublishInput{OrgID: rc.OrgID, Actor: rc.UserID, Draft: draft, Tag: tag})
	switch {
	case errors.Is(err, publishgate.ErrStaleBase):
		return httpkit.Error(http.StatusConflict, "publish_request_stale_base",
			"the workflow changed since the agent drafted this; reject it and let the agent draft again", nil)
	case errors.Is(err, engine.ErrWorkflowSaveRolloutActive):
		return httpkit.Error(http.StatusConflict, "workflow_rollout_active", "finish the active rollout before publishing", nil)
	case errors.Is(err, engine.ErrWorkflowSaveConflict):
		return httpkit.Error(http.StatusConflict, "workflow_save_conflict", "a concurrent save changed the workflow; try again", nil)
	case errors.Is(err, engine.ErrWorkflowSaveNotFound), errors.Is(err, engine.ErrWorkflowSaveIDTaken):
		return httpkit.Error(http.StatusConflict, "workflow_unavailable", "the workflow no longer exists; reject this request", nil)
	case err != nil:
		return internalError()
	}
	return s.settle(ctx, rc, request, "published", pgtype.Text{String: saved.VersionID, Valid: true}, reason,
		map[string]any{"versionId": saved.VersionID, "version": saved.Version})
}

func (s *service) settle(ctx context.Context, rc httpkit.Request, request store.PublishRequest, status string, version pgtype.Text, reason string, extra map[string]any) httpkit.Result {
	row, err := store.New(s.pool).DecidePublishRequest(ctx, store.DecidePublishRequestParams{
		OrgID: rc.OrgID, ID: request.ID, Status: status, DecidedBy: rc.UserID, PublishedVersionID: version,
		DecisionReason: publishgate.OptionalText(reason),
	})
	if err != nil {
		return internalError()
	}
	action := audit.Action("publish_request.rejected")
	if status == "published" {
		action = "publish_request.approved"
	}
	metadata := map[string]any{"publishRequestId": request.ID, "draftId": request.DraftID,
		"requestedBy": request.RequestedBy, "reasons": request.Reasons}
	if reason != "" {
		metadata["reason"] = reason
	}
	maps.Copy(metadata, extra)
	s.audit.Write(ctx, s.pool, rc.Auth, action, audit.Options{TargetType: "workflow", TargetID: request.WorkflowID, Metadata: metadata})
	var name string
	if draft, err := store.New(s.pool).GetWorkflowDraft(ctx, store.GetWorkflowDraftParams{OrgID: rc.OrgID, ID: row.DraftID}); err == nil {
		name, _ = document(draft.Document)["name"].(string)
	}
	v, err := s.newViewer(ctx, rc, []store.PublishRequest{row})
	if err != nil {
		return internalError()
	}
	return httpkit.OK(map[string]any{"request": v.view(row, name)})
}

// secondPerson refuses the people accountable for the request, the creators
// of the requesting and the drafting agents, when the organization asks for
// a second person. An unreadable setting refuses too.
func (s *service) secondPerson(ctx context.Context, rc httpkit.Request, request store.PublishRequest) *httpkit.Result {
	required, err := s.secondPersonRequired(ctx, rc.OrgID)
	if err != nil {
		result := httpkit.Error(http.StatusServiceUnavailable, "publish_request_policy_unavailable",
			"the approval policy cannot be read; try again", nil)
		return &result
	}
	if !required {
		return nil
	}
	accountable := map[string]bool{request.OnBehalfOf: true}
	if clientID, ok := strings.CutPrefix(request.DraftedBy, "agent:"); ok {
		client, err := store.New(s.pool).GetAgentClient(ctx, store.GetAgentClientParams{OrgID: rc.OrgID, ID: clientID})
		if errors.Is(err, pgx.ErrNoRows) {
			result := httpkit.Error(http.StatusConflict, "publish_request_creator_unknown",
				"the drafting agent client no longer exists, so a second person cannot be confirmed; reject this request", nil)
			return &result
		}
		if err != nil {
			result := internalError()
			return &result
		}
		accountable[client.CreatedBy] = true
	} else {
		accountable[request.DraftedBy] = true
	}
	if accountable[rc.UserID] {
		result := httpkit.Error(http.StatusForbidden, "publish_request_second_person",
			"this organization requires someone other than the agent's creator to approve", nil)
		return &result
	}
	return nil
}

// secondPersonRequired reads the policy; a value that is not a boolean is an
// error, so the caller fails closed.
func (s *service) secondPersonRequired(ctx context.Context, orgID string) (bool, error) {
	raw, err := store.New(s.pool).GetOrgConfigValue(ctx, store.GetOrgConfigValueParams{OrgID: orgID, Key: SecondPersonKey})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var required bool
	if err := json.Unmarshal(raw, &required); err != nil {
		return false, err
	}
	return required, nil
}

// viewer answers, per request, whether the caller may decide it now and the
// refusal the decide route would give, so the screen offers nothing the API
// denies. The route still checks on its own.
type viewer struct {
	userID       string
	permitted    bool
	secondPerson bool
	policyError  bool
	agents       map[string]store.ListAgentClientNamesRow
}

func (s *service) newViewer(ctx context.Context, rc httpkit.Request, rows []store.PublishRequest) (*viewer, error) {
	q := store.New(s.pool)
	v := &viewer{userID: rc.UserID, agents: map[string]store.ListAgentClientNamesRow{}}
	if rc.Auth != nil && auth.IsPersonMode(rc.Auth.Mode) {
		role, err := auth.ResolveRoleFromMembership(ctx, q, rc.OrgID, rc.Auth.MembershipRole, rc.Auth.Mode)
		if err != nil {
			return nil, err
		}
		if role != nil && auth.Rank[role.InheritsFrom] >= auth.Rank[auth.RoleEditor] {
			permissions, err := auth.EffectivePermissions(ctx, q, rc.OrgID, role)
			if err != nil {
				return nil, err
			}
			v.permitted = permissions["workflows.write"]
		}
	}
	if v.permitted {
		required, err := s.secondPersonRequired(ctx, rc.OrgID)
		v.secondPerson, v.policyError = required, err != nil
	}
	ids := map[string]bool{}
	for _, row := range rows {
		for _, actor := range []string{row.RequestedBy, row.DraftedBy} {
			if id, ok := strings.CutPrefix(actor, "agent:"); ok {
				ids[id] = true
			}
		}
	}
	if len(ids) > 0 {
		agents, err := q.ListAgentClientNames(ctx, store.ListAgentClientNamesParams{OrgID: rc.OrgID, Ids: slices.Collect(maps.Keys(ids))})
		if err != nil {
			return nil, err
		}
		for _, agent := range agents {
			v.agents[agent.ID] = agent
		}
	}
	return v, nil
}

func (v *viewer) refusal(row store.PublishRequest, status string) any {
	switch {
	case status != "pending":
		return "settled"
	case !v.permitted:
		return "permission"
	case row.RequestedBy == v.userID:
		return "requester"
	case v.policyError:
		return "policy_unavailable"
	case v.secondPerson:
		if row.OnBehalfOf == v.userID {
			return "second_person"
		}
		clientID, isAgent := strings.CutPrefix(row.DraftedBy, "agent:")
		if !isAgent {
			if row.DraftedBy == v.userID {
				return "second_person"
			}
			return nil
		}
		agent, known := v.agents[clientID]
		if !known {
			return "creator_unknown"
		}
		if agent.CreatedBy == v.userID {
			return "second_person"
		}
	}
	return nil
}

func (v *viewer) agentName(actor string) any {
	if id, ok := strings.CutPrefix(actor, "agent:"); ok {
		if agent, known := v.agents[id]; known {
			return agent.Name
		}
	}
	return nil
}

// view renders a request; a pending request past its expiry reads as expired,
// as publish.status reports it, until a decision attempt records it.
func (v *viewer) view(row store.PublishRequest, workflowName string) map[string]any {
	status := row.Status
	if status == "pending" && !time.Now().Before(row.ExpiresAt) {
		status = "expired"
	}
	refusal := v.refusal(row, status)
	out := map[string]any{
		"id": row.ID, "workflowId": row.WorkflowID, "workflowName": nil, "draftId": row.DraftID, "qualificationId": row.QualificationID,
		"reasons": nonNil(row.Reasons), "requestedBy": row.RequestedBy, "requesterName": v.agentName(row.RequestedBy),
		"onBehalfOf": row.OnBehalfOf, "draftedBy": row.DraftedBy, "drafterName": v.agentName(row.DraftedBy), "status": status,
		"createdAt": row.CreatedAt.UTC().Format(time.RFC3339), "expiresAt": row.ExpiresAt.UTC().Format(time.RFC3339),
		"decidedBy": nil, "decidedAt": nil, "decisionReason": nil, "publishedVersionId": nil,
		"viewer": map[string]any{"canDecide": refusal == nil, "refusal": refusal},
	}
	if workflowName != "" {
		out["workflowName"] = workflowName
	}
	if row.DecidedBy.Valid {
		out["decidedBy"] = row.DecidedBy.String
	}
	if row.DecidedAt != nil {
		out["decidedAt"] = row.DecidedAt.UTC().Format(time.RFC3339)
	}
	if row.DecisionReason.Valid {
		out["decisionReason"] = row.DecisionReason.String
	}
	if row.PublishedVersionID.Valid {
		out["publishedVersionId"] = row.PublishedVersionID.String
	}
	return out
}

func nonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func notFound() httpkit.Result {
	return httpkit.Error(http.StatusNotFound, "publish_request_not_found", "publish request not found", nil)
}

func internalError() httpkit.Result {
	return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
}
