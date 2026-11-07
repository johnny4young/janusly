// Package publishrequests serves the people-only routes that review, approve
// and reject an agent's publish request.
package publishrequests

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
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
	deps.Routes.Route(mux, "GET /publish-requests", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.list(r, rc))
	})
	deps.Routes.Route(mux, "GET /publish-requests/{id}", read, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.get(r, rc))
	})
	deps.Routes.Route(mux, "POST /publish-requests/{id}/approve", decide, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.decide(r, rc, true))
	})
	deps.Routes.Route(mux, "POST /publish-requests/{id}/reject", decide, func(w http.ResponseWriter, r *http.Request, rc httpkit.Request) {
		httpkit.WriteUnversioned(w, s.decide(r, rc, false))
	})
}

func (s *service) list(r *http.Request, rc httpkit.Request) httpkit.Result {
	status := r.URL.Query().Get("status")
	switch status {
	case "", "pending", "published", "rejected", "expired", "superseded":
	default:
		return httpkit.Error(http.StatusBadRequest, "invalid_status", "status must be pending, published, rejected, expired or superseded", nil)
	}
	rows, err := store.New(s.pool).ListPublishRequests(r.Context(), store.ListPublishRequestsParams{
		OrgID: rc.OrgID, FilterStatus: publishgate.OptionalText(status),
	})
	if err != nil {
		return internalError()
	}
	requests := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		requests = append(requests, view(row))
	}
	return httpkit.OK(map[string]any{"requests": requests})
}

// get returns what a person reviews: the draft, the production document it
// replaces, the reasons and the qualification evidence.
func (s *service) get(r *http.Request, rc httpkit.Request) httpkit.Result {
	q := store.New(s.pool)
	request, err := q.GetPublishRequest(r.Context(), store.GetPublishRequestParams{OrgID: rc.OrgID, ID: r.PathValue("id")})
	if errors.Is(err, pgx.ErrNoRows) {
		return notFound()
	}
	if err != nil {
		return internalError()
	}
	draft, err := q.GetWorkflowDraft(r.Context(), store.GetWorkflowDraftParams{OrgID: rc.OrgID, ID: request.DraftID})
	if err != nil {
		return internalError()
	}
	receipt, err := q.GetDraftQualification(r.Context(), store.GetDraftQualificationParams{OrgID: rc.OrgID, ID: request.QualificationID})
	if err != nil {
		return internalError()
	}
	var proposed, checks, fixtureRuns any
	_ = json.Unmarshal(draft.Document, &proposed)
	_ = json.Unmarshal(receipt.Checks, &checks)
	_ = json.Unmarshal(receipt.FixtureRuns, &fixtureRuns)
	data := map[string]any{
		"request": view(request), "proposed": proposed,
		"qualification": map[string]any{"status": receipt.Status, "checks": checks, "fixtureRuns": fixtureRuns},
	}
	if latest, err := q.GetLatestWorkflowVersion(r.Context(), store.GetLatestWorkflowVersionParams{
		WorkflowID: request.WorkflowID, OrgID: rc.OrgID,
	}); err == nil {
		var current any
		_ = json.Unmarshal(latest.DagJson, &current)
		data["current"] = map[string]any{"versionId": latest.ID, "version": latest.Version, "document": current}
	}
	return httpkit.OK(data)
}

func (s *service) decide(r *http.Request, rc httpkit.Request, approve bool) httpkit.Result {
	if rc.Auth == nil || !auth.IsPersonMode(rc.Auth.Mode) {
		return httpkit.Error(http.StatusForbidden, "person_required", "only a person decides a publish request", nil)
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
	_ = q.ExpirePublishRequest(ctx, store.ExpirePublishRequestParams{OrgID: rc.OrgID, ID: id})
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
		return s.settle(ctx, rc, request, "rejected", pgtype.Text{}, nil)
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
	case err != nil:
		return internalError()
	}
	return s.settle(ctx, rc, request, "published", pgtype.Text{String: saved.VersionID, Valid: true},
		map[string]any{"versionId": saved.VersionID, "version": saved.Version})
}

func (s *service) settle(ctx context.Context, rc httpkit.Request, request store.PublishRequest, status string, version pgtype.Text, extra map[string]any) httpkit.Result {
	row, err := store.New(s.pool).DecidePublishRequest(ctx, store.DecidePublishRequestParams{
		OrgID: rc.OrgID, ID: request.ID, Status: status, DecidedBy: rc.UserID, PublishedVersionID: version,
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
	maps.Copy(metadata, extra)
	s.audit.Write(ctx, s.pool, rc.Auth, action, audit.Options{TargetType: "workflow", TargetID: request.WorkflowID, Metadata: metadata})
	return httpkit.OK(map[string]any{"request": view(row)})
}

// secondPerson refuses the people accountable for the request, the creators
// of the requesting and the drafting agents, when the organization asks for
// a second person. An unreadable setting refuses too.
func (s *service) secondPerson(ctx context.Context, rc httpkit.Request, request store.PublishRequest) *httpkit.Result {
	raw, err := store.New(s.pool).GetOrgConfigValue(ctx, store.GetOrgConfigValueParams{OrgID: rc.OrgID, Key: SecondPersonKey})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		result := httpkit.Error(http.StatusServiceUnavailable, "publish_request_policy_unavailable",
			"the approval policy cannot be read; try again", nil)
		return &result
	}
	var required bool
	if json.Unmarshal(raw, &required) != nil || !required {
		return nil
	}
	accountable := map[string]bool{request.OnBehalfOf: true}
	if clientID, ok := strings.CutPrefix(request.DraftedBy, "agent:"); ok {
		client, err := store.New(s.pool).GetAgentClient(ctx, store.GetAgentClientParams{OrgID: rc.OrgID, ID: clientID})
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

func view(row store.PublishRequest) map[string]any {
	out := map[string]any{
		"id": row.ID, "workflowId": row.WorkflowID, "draftId": row.DraftID, "qualificationId": row.QualificationID,
		"reasons": row.Reasons, "requestedBy": row.RequestedBy, "onBehalfOf": row.OnBehalfOf, "status": row.Status,
		"createdAt": row.CreatedAt.UTC().Format(time.RFC3339), "expiresAt": row.ExpiresAt.UTC().Format(time.RFC3339),
		"decidedBy": nil, "decidedAt": nil, "publishedVersionId": nil,
	}
	if row.DecidedBy.Valid {
		out["decidedBy"] = row.DecidedBy.String
	}
	if row.DecidedAt != nil {
		out["decidedAt"] = row.DecidedAt.UTC().Format(time.RFC3339)
	}
	if row.PublishedVersionID.Valid {
		out["publishedVersionId"] = row.PublishedVersionID.String
	}
	return out
}

func notFound() httpkit.Result {
	return httpkit.Error(http.StatusNotFound, "publish_request_not_found", "publish request not found", nil)
}

func internalError() httpkit.Result {
	return httpkit.Error(http.StatusInternalServerError, "internal_error", "Internal error", nil)
}
