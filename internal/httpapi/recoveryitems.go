// Recovery Item ownership routes — the drawer's operational core:
// bounded list, lifecycle actions under the CAS pre-state table (a
// concurrent click's loser 409s), assign/escalate, bounded comments, and
// the durable handoff record. Handoff DELIVERY (Slack/Linear/GitHub)
// needs the integrations wave — the pilot records the durable dispatch
// row with outcome delivery_failed + dispatcher_unavailable, honestly.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

func recoveryItemView(row store.RecoveryItem) map[string]any {
	var comments any = json.RawMessage(row.Comments)
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "deadLetterId": row.DeadLetterID,
		"workflowId": textOrNull(row.WorkflowID), "owner": textOrNull(row.Owner),
		"severity": row.Severity, "status": row.Status,
		"slaTargetAt":      row.SlaTargetAt,
		"resolutionReason": textOrNull(row.ResolutionReason),
		"resolvedBy":       textOrNull(row.ResolvedBy), "resolvedAt": timeOrNull(row.ResolvedAt),
		"comments": comments, "errorSignature": textOrNull(row.ErrorSignature),
		"occurrenceCount": row.OccurrenceCount, "firstActionAt": timeOrNull(row.FirstActionAt),
		"createdAt": row.CreatedAt,
	}
}

func recoveryItemHandoffView(row store.RecoveryItemHandoff) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "recoveryItemId": row.RecoveryItemID,
		"destination": row.Destination, "credentialName": row.CredentialName,
		"externalId": textOrNull(row.ExternalID), "externalUrl": textOrNull(row.ExternalUrl),
		"idempotencyKey": row.IdempotencyKey, "lastOutcome": row.LastOutcome,
		"lastStatusCode": nullableInt(row.LastStatusCode), "lastError": textOrNull(row.LastError),
		"lastLatencyMs": nullableInt(row.LastLatencyMs), "dispatchCount": row.DispatchCount,
		"firstDispatchedAt": row.FirstDispatchedAt, "lastDispatchedAt": row.LastDispatchedAt,
		"createdBy": textOrNull(row.CreatedBy),
	}
}

func (s *V1Server) listRecoveryItemsCore(r *http.Request, rc v1Request) opResult {
	rows, err := store.New(s.pool).ListRecoveryItems(r.Context(), rc.orgID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, recoveryItemView(row))
	}
	return opOK(map[string]any{"items": items})
}

func (s *V1Server) recoveryItemDetailCore(r *http.Request, rc v1Request, id string) opResult {
	q := store.New(s.pool)
	item, err := q.GetRecoveryItemByID(r.Context(), store.GetRecoveryItemByIDParams{
		OrgID: rc.orgID, ID: id,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "recovery_item_not_found", "Recovery item not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	handoffRows, err := q.ListRecoveryItemHandoffs(r.Context(), store.ListRecoveryItemHandoffsParams{
		OrgID: rc.orgID, RecoveryItemID: id,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	handoffs := make([]map[string]any, 0, len(handoffRows))
	for _, row := range handoffRows {
		handoffs = append(handoffs, recoveryItemHandoffView(row))
	}
	return opOK(map[string]any{"item": recoveryItemView(item), "handoffs": handoffs})
}

func (s *V1Server) recoveryItemActionCore(r *http.Request, rc v1Request, id, action string) opResult {
	var body struct {
		Owner            string `json:"owner"`
		Severity         string `json:"severity"`
		ResolutionReason string `json:"resolutionReason"`
		Comment          string `json:"comment"`
	}
	_ = decodeBody(r, &body)
	q := store.New(s.pool)
	item, err := q.GetRecoveryItemByID(r.Context(), store.GetRecoveryItemByIDParams{OrgID: rc.orgID, ID: id})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "recovery_item_not_found", "Recovery item not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	newOwner := pgtype.Text{}
	newSeverity := pgtype.Text{}
	resolution := pgtype.Text{}
	auditAction := ""
	var fromStatuses []string
	toStatus := item.Status

	switch action {
	case "assign":
		if body.Owner == "" {
			return opError(http.StatusBadRequest, "recovery_item_invalid_body", "owner is required", nil)
		}
		newOwner = pgtype.Text{String: body.Owner, Valid: true}
		fromStatuses = []string{item.Status} // any state; CAS still guards races
		auditAction = "recovery.item.assigned"
	case "escalate":
		newSeverity = pgtype.Text{String: domain.EscalateRecoveryItemSeverity(item.Severity), Valid: true}
		fromStatuses = []string{item.Status}
		auditAction = "recovery.item.escalated"
	case "acknowledge", "in_progress", "waiting_external", "resolve", "reopen":
		fromStatuses = domain.RecoveryItemAllowedPreStates[action]
		toStatus = domain.RecoveryItemActionTarget[action]
		switch action {
		case "acknowledge":
			if body.Owner != "" {
				newOwner = pgtype.Text{String: body.Owner, Valid: true}
			}
			if body.Severity != "" {
				if !domain.RecoveryItemSeverities[body.Severity] {
					return opError(http.StatusBadRequest, "recovery_item_invalid_body", "invalid severity", nil)
				}
				newSeverity = pgtype.Text{String: body.Severity, Valid: true}
			}
			auditAction = "recovery.item.acknowledged"
		case "in_progress":
			auditAction = "recovery.item.in_progress"
		case "waiting_external":
			auditAction = "recovery.item.waiting_external"
		case "resolve":
			if !domain.RecoveryItemResolutionReasons[body.ResolutionReason] ||
				body.ResolutionReason == "sandbox_replay_succeeded" {
				// The sandbox reason is written ONLY by the terminal-impact
				// path — an operator cannot claim it by hand.
				return opError(http.StatusBadRequest, "recovery_item_invalid_body",
					"resolutionReason must be one of the operator-closed set", nil)
			}
			resolution = pgtype.Text{String: body.ResolutionReason, Valid: true}
			auditAction = "recovery.item.resolved"
		case "reopen":
			auditAction = "recovery.item.reopened"
		}
	default:
		return opError(http.StatusNotFound, "recovery_item_not_found", "Unknown action", nil)
	}

	moved, err := q.TransitionRecoveryItem(r.Context(), store.TransitionRecoveryItemParams{
		OrgID: rc.orgID, ID: id, ToStatus: toStatus,
		NewOwner: newOwner, NewSeverity: newSeverity,
		ResolutionReason: resolution,
		Actor:            pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		FromStatuses:     fromStatuses,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if moved == 0 {
		return opError(http.StatusConflict, "recovery_item_conflict",
			"Recovery item changed state — refresh and retry", map[string]any{"status": item.Status})
	}
	if body.Comment != "" {
		if len(body.Comment) > domain.RecoveryItemCommentBodyMax {
			body.Comment = body.Comment[:domain.RecoveryItemCommentBodyMax]
		}
		comment, _ := json.Marshal([]map[string]any{{
			"id": s.newID(), "authorUserId": rc.userID, "body": body.Comment,
			"createdAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		}})
		_, _ = q.AppendRecoveryItemComment(r.Context(), store.AppendRecoveryItemCommentParams{
			OrgID: rc.orgID, ID: id, Comment: comment,
		})
	}
	audit.Write(r.Context(), s.pool, rc.authContext, audit.Action(auditAction), audit.Options{
		TargetType: "recovery-item", TargetID: id,
		Metadata: map[string]any{"from": item.Status, "to": toStatus},
	})
	updated, err := q.GetRecoveryItemByID(r.Context(), store.GetRecoveryItemByIDParams{OrgID: rc.orgID, ID: id})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(map[string]any{"item": recoveryItemView(updated)})
}

func (s *V1Server) recoveryItemHandoffCore(r *http.Request, rc v1Request, id string) opResult {
	var body struct {
		Destination    string `json:"destination"`
		CredentialName string `json:"credentialName"`
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if err := decodeBody(r, &body); err != nil || !domain.RecoveryHandoffDestinations[body.Destination] {
		return opError(http.StatusBadRequest, "recovery_item_invalid_body",
			"destination must be one of slack, linear, github, webhook", nil)
	}
	q := store.New(s.pool)
	if _, err := q.GetRecoveryItemByID(r.Context(), store.GetRecoveryItemByIDParams{OrgID: rc.orgID, ID: id}); err != nil {
		return opError(http.StatusNotFound, "recovery_item_not_found", "Recovery item not found", nil)
	}
	idempotencyKey := body.IdempotencyKey
	if idempotencyKey == "" {
		idempotencyKey = id + ":" + body.Destination
	}
	// Delivery needs the integrations wave; the durable dispatch row and
	// its audit land NOW so the drawer's history is honest either way.
	row, err := q.UpsertRecoveryItemHandoff(r.Context(), store.UpsertRecoveryItemHandoffParams{
		ID: s.newID(), OrgID: rc.orgID, RecoveryItemID: id,
		Destination:    body.Destination,
		CredentialName: body.CredentialName,
		IdempotencyKey: idempotencyKey,
		LastOutcome:    "delivery_failed",
		LastError:      pgtype.Text{String: "dispatcher_unavailable", Valid: true},
		CreatedBy:      pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	auditName := "recovery.handoff." + body.Destination
	if body.Destination == "webhook" {
		auditName = "recovery.handoff.slack" // closest catalog action; metadata names the real destination
	}
	audit.Write(r.Context(), s.pool, rc.authContext, audit.Action(auditName), audit.Options{
		TargetType: "recovery-item", TargetID: id,
		Metadata: map[string]any{"destination": body.Destination, "outcome": row.LastOutcome},
	})
	return opOK(map[string]any{"handoff": map[string]any{
		"destination": row.Destination, "outcome": row.LastOutcome,
		"error": textOrNull(row.LastError), "dispatchCount": row.DispatchCount,
	}})
}

func (s *V1Server) mountRecoveryItemRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /recovery/items", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.listRecoveryItemsCore(r, rc))
	}))
	mux.HandleFunc("GET /recovery/items/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.recoveryItemDetailCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("POST /recovery/items/{id}/{action}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		action := r.PathValue("action")
		if action == "handoff" {
			writeUnversioned(w, s.recoveryItemHandoffCore(r, rc, r.PathValue("id")))
			return
		}
		writeUnversioned(w, s.recoveryItemActionCore(r, rc, r.PathValue("id"), action))
	}))
}
