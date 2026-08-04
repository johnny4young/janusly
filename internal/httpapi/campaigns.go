// Replay-campaign API — named, paced, abortable DLQ cohorts. The cohort is
// resolved server-side (never trusting a client-supplied signature): every
// entry must be an OPEN dead letter, all sharing ONE normalized failure
// signature, minimum two. Mirrors the contract's routes under
// /recovery/campaigns with the same codes and validation bounds.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	replayCampaignMaxItems     = 100
	replayCampaignNameMax      = 120
	replayCampaignMinPacingMs  = 1_000
	replayCampaignMaxPacingMs  = 60_000
	replayCampaignListDefault  = 20
	replayCampaignListMaxLimit = 100
)

type cohortEntry struct {
	DeadLetterID string `json:"deadLetterId"`
	RunID        string `json:"runId"`
	NodeID       string `json:"nodeId"`
}

type cohortRejection struct {
	DeadLetterID string `json:"deadLetterId"`
	Reason       string `json:"reason"`
}

type cohortPreview struct {
	CanCreate        bool              `json:"canCreate"`
	ClusterSignature *string           `json:"clusterSignature"`
	Eligible         []cohortEntry     `json:"eligible"`
	Rejected         []cohortRejection `json:"rejected"`
}

// previewCohort resolves one immutable cohort from requested DLQ ids.
func (s *V1Server) previewCohort(r *http.Request, orgID string, requestedIDs []string) (cohortPreview, error) {
	// Order-preserving dedupe, like the contract's Set spread.
	seen := map[string]bool{}
	ids := make([]string, 0, len(requestedIDs))
	for _, id := range requestedIDs {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	rows, err := store.New(s.pool).ListReplayCampaignDeadLetters(r.Context(),
		store.ListReplayCampaignDeadLettersParams{OrgID: orgID, Ids: ids})
	if err != nil {
		return cohortPreview{}, err
	}
	type row = store.ListReplayCampaignDeadLettersRow
	byID := map[string]row{}
	for _, item := range rows {
		byID[item.ID] = item
	}

	type candidate struct {
		entry cohortEntry
		sig   string
	}
	var candidates []candidate
	preview := cohortPreview{Eligible: []cohortEntry{}, Rejected: []cohortRejection{}}
	for _, id := range ids {
		item, ok := byID[id]
		if !ok {
			preview.Rejected = append(preview.Rejected, cohortRejection{DeadLetterID: id, Reason: "not_found"})
			continue
		}
		if item.Status != "open" {
			preview.Rejected = append(preview.Rejected, cohortRejection{DeadLetterID: id, Reason: "already_" + item.Status})
			continue
		}
		var node struct {
			Type   string         `json:"type"`
			Config map[string]any `json:"config"`
		}
		if err := json.Unmarshal(item.NodeJson, &node); err != nil || node.Type == "" {
			preview.Rejected = append(preview.Rejected, cohortRejection{DeadLetterID: id, Reason: "invalid_node_snapshot"})
			continue
		}
		toolName, _ := node.Config["tool"].(string)
		sig := signature.NormalizeJSON(item.ErrorJson, signature.Context{
			NodeType: node.Type, NodeID: item.NodeID, ToolName: toolName,
		}).Signature
		candidates = append(candidates, candidate{
			entry: cohortEntry{DeadLetterID: id, RunID: item.RunID, NodeID: item.NodeID}, sig: sig,
		})
	}

	if len(candidates) > 0 {
		clusterSig := candidates[0].sig
		preview.ClusterSignature = &clusterSig
		for _, c := range candidates {
			if c.sig == clusterSig {
				preview.Eligible = append(preview.Eligible, c.entry)
			} else {
				preview.Rejected = append(preview.Rejected, cohortRejection{DeadLetterID: c.entry.DeadLetterID, Reason: "different_cluster"})
			}
		}
	}
	preview.CanCreate = len(preview.Eligible) >= 2 && len(preview.Rejected) == 0 && len(preview.Eligible) == len(ids)
	return preview, nil
}

type campaignBody struct {
	DeadLetterIDs []string `json:"deadLetterIds"`
	Name          string   `json:"name"`
	PacingMs      *float64 `json:"pacingMs"`
}

func validCohortIDs(ids []string) bool {
	if len(ids) < 1 || len(ids) > replayCampaignMaxItems {
		return false
	}
	for _, id := range ids {
		trimmed := strings.TrimSpace(id)
		if trimmed == "" || len(trimmed) > 256 {
			return false
		}
	}
	return true
}

func (s *V1Server) campaignPreviewCore(r *http.Request, rc v1Request) opResult {
	var body campaignBody
	if err := decodeBody(r, &body); err != nil || !validCohortIDs(body.DeadLetterIDs) {
		return opError(http.StatusBadRequest, "replay_campaign_invalid_body", "Invalid replay campaign cohort", nil)
	}
	preview, err := s.previewCohort(r, rc.orgID, body.DeadLetterIDs)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(map[string]any{
		"canCreate": preview.CanCreate, "clusterSignature": preview.ClusterSignature,
		"eligible": preview.Eligible, "rejected": preview.Rejected,
	})
}

func (s *V1Server) campaignCreateCore(r *http.Request, rc v1Request) opResult {
	var body campaignBody
	name := ""
	if err := decodeBody(r, &body); err == nil {
		name = strings.TrimSpace(body.Name)
	}
	pacingOK := body.PacingMs != nil && *body.PacingMs == float64(int64(*body.PacingMs)) &&
		*body.PacingMs >= replayCampaignMinPacingMs && *body.PacingMs <= replayCampaignMaxPacingMs
	if !validCohortIDs(body.DeadLetterIDs) || name == "" || len(name) > replayCampaignNameMax || !pacingOK {
		return opError(http.StatusBadRequest, "replay_campaign_invalid_body", "Invalid replay campaign", nil)
	}
	preview, err := s.previewCohort(r, rc.orgID, body.DeadLetterIDs)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if !preview.CanCreate || preview.ClusterSignature == nil {
		return opError(http.StatusConflict, "replay_campaign_invalid_cohort",
			"Replay campaign entries must be open members of one failure cluster",
			map[string]any{"rejectedCount": len(preview.Rejected), "eligibleCount": len(preview.Eligible)})
	}

	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	campaignID := uuid.NewString()
	filterJSON, _ := json.Marshal(map[string]any{
		"kind": "failure_cluster", "clusterSignature": *preview.ClusterSignature,
	})
	if err := q.InsertReplayCampaign(ctx, store.InsertReplayCampaignParams{
		ID: campaignID, OrgID: rc.orgID, Name: name,
		ClusterSignature: *preview.ClusterSignature, FilterJson: filterJSON,
		PacingMs: int32(*body.PacingMs), TotalCount: int32(len(preview.Eligible)),
		CreatedBy: rc.userID,
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	for position, entry := range preview.Eligible {
		if err := q.InsertReplayCampaignItem(ctx, store.InsertReplayCampaignItemParams{
			ID: uuid.NewString(), OrgID: rc.orgID, CampaignID: campaignID,
			DeadLetterID: entry.DeadLetterID, Position: int32(position),
		}); err != nil {
			return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	detail, result := s.campaignDetail(r, rc, campaignID)
	if detail == nil {
		return result
	}
	// The due clock is the runtime's only dispatch substrate — there is no
	// queue publication to lose, so this is always false.
	detail["publicationDeferred"] = false
	audit.Write(ctx, s.pool, rc.authContext, "recovery.campaign.created", audit.Options{
		TargetType: "replay_campaign", TargetID: campaignID,
		Metadata: map[string]any{
			"total": len(preview.Eligible), "pacingMs": int32(*body.PacingMs),
			"clusterSignature": *preview.ClusterSignature, "publicationDeferred": false,
		},
	})
	return opResult{status: http.StatusAccepted, data: detail}
}

func (s *V1Server) campaignDetail(r *http.Request, rc v1Request, id string) (map[string]any, opResult) {
	ctx := r.Context()
	q := store.New(s.pool)
	campaign, err := q.GetReplayCampaign(ctx, store.GetReplayCampaignParams{OrgID: rc.orgID, ID: id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, opError(http.StatusNotFound, "replay_campaign_not_found", "Replay campaign not found", nil)
		}
		return nil, opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	items, err := q.ListReplayCampaignItems(ctx, store.ListReplayCampaignItemsParams{OrgID: rc.orgID, CampaignID: id})
	if err != nil {
		return nil, opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	itemViews := make([]map[string]any, 0, len(items))
	for _, item := range items {
		itemViews = append(itemViews, map[string]any{
			"id": item.ID, "orgId": item.OrgID, "campaignId": item.CampaignID,
			"deadLetterId": item.DeadLetterID, "position": item.Position,
			"status": item.Status, "attemptCount": item.AttemptCount,
			"error": textOrNull(item.Error), "completedAt": timeOrNull(item.CompletedAt),
			"createdAt": isoMillis(item.CreatedAt),
		})
	}
	return map[string]any{"campaign": campaignView(campaign), "items": itemViews}, opResult{}
}

func campaignView(campaign store.ReplayCampaign) map[string]any {
	return map[string]any{
		"id": campaign.ID, "orgId": campaign.OrgID, "name": campaign.Name,
		"clusterSignature": campaign.ClusterSignature, "filterJson": rawOrNull(campaign.FilterJson),
		"pacingMs": campaign.PacingMs, "status": campaign.Status,
		"totalCount": campaign.TotalCount, "replayedCount": campaign.ReplayedCount,
		"failedCount": campaign.FailedCount, "cancelledCount": campaign.CancelledCount,
		"createdBy": campaign.CreatedBy, "cancelledBy": textOrNull(campaign.CancelledBy),
		"nextDispatchAt": isoMillis(campaign.NextDispatchAt), "startedAt": isoMillis(campaign.StartedAt),
		"completedAt": timeOrNull(campaign.CompletedAt), "cancelledAt": timeOrNull(campaign.CancelledAt),
		"createdAt": isoMillis(campaign.CreatedAt), "updatedAt": isoMillis(campaign.UpdatedAt),
	}
}

func (s *V1Server) campaignCancelCore(r *http.Request, rc v1Request, id string) opResult {
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := store.New(tx)
	_, err = q.CancelRunningReplayCampaign(ctx, store.CancelRunningReplayCampaignParams{
		OrgID: rc.orgID, ID: id, CancelledBy: pgtype.Text{String: rc.userID, Valid: true},
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Distinguish missing from no-longer-running, like the contract.
			if _, err := store.New(s.pool).GetReplayCampaign(ctx, store.GetReplayCampaignParams{OrgID: rc.orgID, ID: id}); err != nil {
				return opError(http.StatusNotFound, "replay_campaign_not_found", "Replay campaign not found", nil)
			}
			return opError(http.StatusConflict, "replay_campaign_not_running", "Replay campaign is no longer running", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if _, err := q.CancelPendingReplayCampaignItems(ctx, store.CancelPendingReplayCampaignItemsParams{
		OrgID: rc.orgID, CampaignID: id,
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if err := tx.Commit(ctx); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	detail, result := s.campaignDetail(r, rc, id)
	if detail == nil {
		return result
	}
	cancelled, _ := detail["campaign"].(map[string]any)
	audit.Write(ctx, s.pool, rc.authContext, "recovery.campaign.cancelled", audit.Options{
		TargetType: "replay_campaign", TargetID: id,
		Metadata: map[string]any{
			"replayed": cancelled["replayedCount"], "failed": cancelled["failedCount"],
			"cancelled": cancelled["cancelledCount"],
		},
	})
	return opOK(detail)
}

func (s *V1Server) campaignListCore(r *http.Request, rc v1Request) opResult {
	limit := int32(replayCampaignListDefault)
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = int32(min(replayCampaignListMaxLimit, parsed))
		}
	}
	rows, err := store.New(s.pool).ListReplayCampaigns(r.Context(), store.ListReplayCampaignsParams{
		OrgID: rc.orgID, Limit: limit,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	views := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		views = append(views, campaignView(row))
	}
	return opOK(map[string]any{"campaigns": views})
}

func (s *V1Server) mountCampaignRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /recovery/campaigns/preview", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.campaignPreviewCore(r, rc))
	}))
	mux.HandleFunc("POST /recovery/campaigns", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.campaignCreateCore(r, rc))
	}))
	mux.HandleFunc("POST /recovery/campaigns/{id}/cancel", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.campaignCancelCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("GET /recovery/campaigns/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		detail, result := s.campaignDetail(r, rc, r.PathValue("id"))
		if detail == nil {
			writeUnversioned(w, result)
			return
		}
		writeUnversioned(w, opOK(detail))
	}))
	mux.HandleFunc("GET /recovery/campaigns", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.campaignListCore(r, rc))
	}))
}

// isoMillis formats a NOT NULL timestamptz in the wire's millisecond ISO shape.
func isoMillis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
