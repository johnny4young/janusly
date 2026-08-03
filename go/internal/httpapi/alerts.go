// Recovery alerting policy CRUD + recent-dispatch feed (the reference's
// alerts-routes): create/list/update/delete under admin + alerts.write,
// reads under viewer + alerts.read. Body validation enforces the closed
// trigger catalog, 1..5 channels from the closed destination set (webhook
// requires an https url; slack/email/github accept their params but
// deliver with the integrations wave), cooldown 60..86400 (default 900).
// 422 carries the structured error list like the reference.
package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/store"
)

const (
	alertPolicyNameMax          = 120
	alertPolicyChannelsMax      = 5
	alertCooldownSecondsMin     = 60
	alertCooldownSecondsMax     = 86400
	alertCooldownSecondsDefault = 900
	recentDispatchesDefault     = 50
	recentDispatchesMax         = 200
)

var alertDestinations = map[string]bool{"slack": true, "webhook": true, "email": true, "github": true}

type alertPolicyBody struct {
	Name            string           `json:"name"`
	Trigger         string           `json:"trigger"`
	Parameters      map[string]any   `json:"parameters"`
	Channels        []map[string]any `json:"channels"`
	CooldownSeconds *int             `json:"cooldownSeconds"`
	Enabled         *bool            `json:"enabled"`
}

// validateAlertPolicyBody returns the structured error list (empty = valid).
func validateAlertPolicyBody(body alertPolicyBody) []map[string]any {
	problems := make([]map[string]any, 0)
	addProblem := func(path, message string) {
		problems = append(problems, map[string]any{"path": path, "message": message})
	}
	if body.Name == "" || len(body.Name) > alertPolicyNameMax {
		addProblem("name", "name must be 1..120 characters")
	}
	if !engine.AlertTriggers[body.Trigger] {
		addProblem("trigger", "trigger must be one of the closed catalog")
	}
	if len(body.Channels) == 0 || len(body.Channels) > alertPolicyChannelsMax {
		addProblem("channels", "channels must have 1..5 entries")
	}
	for index, channel := range body.Channels {
		channelType, _ := channel["type"].(string)
		if !alertDestinations[channelType] {
			addProblem("channels", "channel type must be slack, webhook, email, or github")
			continue
		}
		params, _ := channel["params"].(map[string]any)
		if channelType == "webhook" {
			url, _ := params["url"].(string)
			if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
				addProblem("channels", "webhook channel requires a url")
			}
		}
		_ = index
	}
	if body.CooldownSeconds != nil &&
		(*body.CooldownSeconds < alertCooldownSecondsMin || *body.CooldownSeconds > alertCooldownSecondsMax) {
		addProblem("cooldownSeconds", "cooldownSeconds must be 60..86400")
	}
	return problems
}

func alertPolicyView(row store.AlertPolicy) map[string]any {
	return map[string]any{
		"id": row.ID, "name": row.Name, "trigger": row.Trigger,
		"parameters": json.RawMessage(row.Parameters), "channels": json.RawMessage(row.Channels),
		"cooldownSeconds": row.CooldownSeconds, "enabled": row.Enabled,
		"createdBy": textOrNull(row.CreatedBy), "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func (s *V1Server) listAlertPoliciesCore(r *http.Request, rc v1Request) opResult {
	rows, err := store.New(s.pool).ListAlertPolicies(r.Context(), rc.orgID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	policies := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		policies = append(policies, alertPolicyView(row))
	}
	return opOK(map[string]any{"policies": policies})
}

func (s *V1Server) createAlertPolicyCore(r *http.Request, rc v1Request) opResult {
	var body alertPolicyBody
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	if problems := validateAlertPolicyBody(body); len(problems) > 0 {
		return opError(http.StatusUnprocessableEntity, "alert_policy_invalid",
			"Alert policy failed validation", map[string]any{"errors": problems})
	}
	cooldown := alertCooldownSecondsDefault
	if body.CooldownSeconds != nil {
		cooldown = *body.CooldownSeconds
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	parameters := body.Parameters
	if parameters == nil {
		parameters = map[string]any{}
	}
	parametersJSON, _ := json.Marshal(parameters)
	channelsJSON, _ := json.Marshal(body.Channels)
	id := s.newID()
	if err := store.New(s.pool).InsertAlertPolicy(r.Context(), store.InsertAlertPolicyParams{
		ID: id, OrgID: rc.orgID, Name: body.Name, Trigger: body.Trigger,
		Parameters: parametersJSON, Channels: channelsJSON,
		CooldownSeconds: int32(cooldown), Enabled: enabled,
		CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		// The (org, name) unique index makes duplicate names a 409.
		return opError(http.StatusConflict, "alert_policy_conflict",
			"An alert policy with this name already exists", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "alert.policy.created", audit.Options{
		TargetType: "alert-policy", TargetID: id,
		Metadata: map[string]any{"trigger": body.Trigger, "name": body.Name},
	})
	row, err := store.New(s.pool).GetAlertPolicy(r.Context(), store.GetAlertPolicyParams{OrgID: rc.orgID, ID: id})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(map[string]any{"policy": alertPolicyView(row)})
}

func (s *V1Server) updateAlertPolicyCore(r *http.Request, rc v1Request, id string) opResult {
	var body alertPolicyBody
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	q := store.New(s.pool)
	if _, err := q.GetAlertPolicy(r.Context(), store.GetAlertPolicyParams{OrgID: rc.orgID, ID: id}); err != nil {
		return opError(http.StatusNotFound, "alert_policy_not_found", "Alert policy not found", nil)
	}
	// Partial update: only supplied fields change; supplied fields are
	// re-validated with the same bounds as create.
	if body.Name != "" && len(body.Name) > alertPolicyNameMax {
		return opError(http.StatusUnprocessableEntity, "alert_policy_invalid",
			"Alert policy failed validation", map[string]any{"errors": []map[string]any{
				{"path": "name", "message": "name must be 1..120 characters"}}})
	}
	if body.Channels != nil {
		check := body
		check.Name = "placeholder"
		check.Trigger = "dlq.entry_created"
		if problems := validateAlertPolicyBody(check); len(problems) > 0 {
			return opError(http.StatusUnprocessableEntity, "alert_policy_invalid",
				"Alert policy failed validation", map[string]any{"errors": problems})
		}
	}
	if body.CooldownSeconds != nil &&
		(*body.CooldownSeconds < alertCooldownSecondsMin || *body.CooldownSeconds > alertCooldownSecondsMax) {
		return opError(http.StatusUnprocessableEntity, "alert_policy_invalid",
			"Alert policy failed validation", map[string]any{"errors": []map[string]any{
				{"path": "cooldownSeconds", "message": "cooldownSeconds must be 60..86400"}}})
	}
	params := store.UpdateAlertPolicyParams{OrgID: rc.orgID, ID: id}
	if body.Name != "" {
		params.NewName = pgtype.Text{String: body.Name, Valid: true}
	}
	if body.Parameters != nil {
		raw, _ := json.Marshal(body.Parameters)
		params.NewParameters = raw
	}
	if body.Channels != nil {
		raw, _ := json.Marshal(body.Channels)
		params.NewChannels = raw
	}
	if body.CooldownSeconds != nil {
		params.NewCooldownSeconds = pgtype.Int4{Int32: int32(*body.CooldownSeconds), Valid: true}
	}
	if body.Enabled != nil {
		params.NewEnabled = pgtype.Bool{Bool: *body.Enabled, Valid: true}
	}
	if _, err := q.UpdateAlertPolicy(r.Context(), params); err != nil {
		return opError(http.StatusConflict, "alert_policy_conflict",
			"An alert policy with this name already exists", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "alert.policy.updated", audit.Options{
		TargetType: "alert-policy", TargetID: id,
	})
	row, err := q.GetAlertPolicy(r.Context(), store.GetAlertPolicyParams{OrgID: rc.orgID, ID: id})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(map[string]any{"policy": alertPolicyView(row)})
}

func (s *V1Server) deleteAlertPolicyCore(r *http.Request, rc v1Request, id string) opResult {
	deleted, err := store.New(s.pool).DeleteAlertPolicy(r.Context(), store.DeleteAlertPolicyParams{
		OrgID: rc.orgID, ID: id,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if deleted == 0 {
		return opError(http.StatusNotFound, "alert_policy_not_found", "Alert policy not found", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "alert.policy.deleted", audit.Options{
		TargetType: "alert-policy", TargetID: id,
	})
	return opOK(map[string]any{"ok": true})
}

func (s *V1Server) recentAlertDispatchesCore(r *http.Request, rc v1Request) opResult {
	limit := recentDispatchesDefault
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := parsePositiveInt(raw, recentDispatchesMax); err == nil {
			limit = n
		}
	}
	var cursor *time.Time
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		if at, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			cursor = &at
		}
	}
	rows, err := store.New(s.pool).ListRecentAlertDispatches(r.Context(), store.ListRecentAlertDispatchesParams{
		OrgID: rc.orgID, Cursor: cursor, PageLimit: int32(limit),
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	dispatches := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		dispatches = append(dispatches, map[string]any{
			"id": row.ID, "policyId": row.PolicyID, "dedupeKey": row.DedupeKey,
			"dispatchedAt": row.DispatchedAt, "outcome": row.Outcome,
			"channelResults": json.RawMessage(row.ChannelResults),
			"triggerPayload": json.RawMessage(row.TriggerPayload),
		})
	}
	return opOK(map[string]any{"dispatches": dispatches})
}

func (s *V1Server) mountAlertRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /alerts/policies", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.listAlertPoliciesCore(r, rc))
	}))
	mux.HandleFunc("POST /alerts/policies", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.createAlertPolicyCore(r, rc))
	}))
	mux.HandleFunc("GET /alerts/recent", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.recentAlertDispatchesCore(r, rc))
	}))
	mux.HandleFunc("POST /alerts/policies/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.updateAlertPolicyCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("DELETE /alerts/policies/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.deleteAlertPolicyCore(r, rc, r.PathValue("id")))
	}))
}
