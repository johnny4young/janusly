// Signed Slack recovery actions (reference slack-interactions.ts +
// slack-interactions-routes.ts): admin routes configure a team, a
// dedicated signing-secret credential, and bounded Slack-user →
// Janusly-member mappings; the PUBLIC callback resolves only an opaque
// connection id, verifies Slack's exact raw-body HMAC (`v0=<hex>` over
// `v0:<ts>:<body>`, ±5 min, constant-time), checks the signed team,
// authorizes the MAPPED member through the normal role/permission layer
// (mode "supabase" — no dev auto-admin), and claims replay protection
// ATOMICALLY with the recovery-item mutation.
package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/secretstore"
	"github.com/johnny4young/janusly/go/internal/store"
	"github.com/johnny4young/janusly/go/internal/webhooksig"
)

const (
	slackSignatureMaxAgeSeconds = 5 * 60
	slackBodyMaxBytes           = 64_000
	slackReceiptTTL             = 24 * time.Hour
	slackConnectionNameMax      = 120
	slackTeamIDMax              = 64
	slackUserIDMax              = 128
	slackUserMappingsMax        = 100

	slackActionAcknowledge = "janusly_recovery_acknowledge"
	slackActionAssignToMe  = "janusly_recovery_assign_to_me"
	slackActionOpen        = "janusly_recovery_open"
)

var slackTeamIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// verifySlackSignature checks Slack's v0 HMAC over the EXACT raw body.
func verifySlackSignature(timestampHeader, signatureHeader, rawBody, secret string, nowUnix int64) (int64, string) {
	if secret == "" {
		return 0, "missing_secret"
	}
	// Slack's provider quirks stay here: separate timestamp header with
	// its own digit bound, and a v0= prefixed hex signature.
	if matched, _ := regexp.MatchString(`^\d{1,12}$`, timestampHeader); !matched {
		return 0, "malformed_timestamp"
	}
	if matched, _ := regexp.MatchString(`^v0=[a-f0-9]{64}$`, signatureHeader); !matched {
		return 0, "malformed_signature"
	}
	timestamp, reason := webhooksig.Verify(timestampHeader,
		[]string{strings.TrimPrefix(signatureHeader, "v0=")}, rawBody, secret, nowUnix,
		webhooksig.Posture{
			Compose:          func(t, body string) string { return "v0:" + t + ":" + body },
			ToleranceSeconds: slackSignatureMaxAgeSeconds,
		})
	return timestamp, reason
}

type slackInteraction struct {
	TeamID      string
	SlackUserID string
	ActionID    string
	Value       string
}

// parseSlackInteractionPayload parses the form-encoded `payload` field —
// exactly one — AFTER the signature passed.
func parseSlackInteractionPayload(rawBody string) *slackInteraction {
	form, err := url.ParseQuery(rawBody)
	if err != nil || len(form["payload"]) != 1 {
		return nil
	}
	var payload struct {
		Type string `json:"type"`
		Team struct {
			ID string `json:"id"`
		} `json:"team"`
		User struct {
			ID string `json:"id"`
		} `json:"user"`
		Actions []struct {
			ActionID string `json:"action_id"`
			Value    string `json:"value"`
		} `json:"actions"`
	}
	if json.Unmarshal([]byte(form["payload"][0]), &payload) != nil {
		return nil
	}
	if payload.Type != "block_actions" || payload.Team.ID == "" || payload.User.ID == "" ||
		len(payload.Actions) != 1 {
		return nil
	}
	action := payload.Actions[0]
	if action.Value == "" || len(action.Value) > 256 {
		return nil
	}
	switch action.ActionID {
	case slackActionAcknowledge, slackActionAssignToMe, slackActionOpen:
	default:
		return nil
	}
	return &slackInteraction{
		TeamID: payload.Team.ID, SlackUserID: payload.User.ID,
		ActionID: action.ActionID, Value: action.Value,
	}
}

// slackReceiptID digests one verified callback into its durable
// replay-claim id.
func slackReceiptID(connectionID string, timestamp int64, rawBody string) string {
	raw, _ := json.Marshal([]any{connectionID, timestamp, rawBody})
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

type slackMapping struct {
	SlackUserID string `json:"slackUserId"`
	UserID      string `json:"userId"`
}

func slackConnectionView(row store.SlackInteractionConnection) map[string]any {
	var mappings []slackMapping
	_ = json.Unmarshal(row.UserMappings, &mappings)
	return map[string]any{
		"id": row.ID, "name": row.Name, "teamId": row.TeamID,
		"signingCredentialName": row.SigningCredentialName,
		"userMappings":          mappings, "enabled": row.Enabled,
		"callbackUrl": "/webhooks/slack/interactions/" + url.PathEscape(row.ID),
		"createdAt":   row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

// parseSlackConnectionBody validates the admin body (shared create/update).
func (s *V1Server) parseSlackConnectionBody(r *http.Request, rc v1Request) (name, teamID, credentialName string, mappingsJSON []byte, enabled bool, bad *opResult) {
	fail := func(code, message string) *opResult {
		res := opError(http.StatusBadRequest, code, message, nil)
		return &res
	}
	var body struct {
		Name                  string         `json:"name"`
		TeamID                string         `json:"teamId"`
		SigningCredentialName string         `json:"signingCredentialName"`
		UserMappings          []slackMapping `json:"userMappings"`
		Enabled               *bool          `json:"enabled"`
	}
	if err := decodeBody(r, &body); err != nil {
		return "", "", "", nil, false, fail("slack_interaction_invalid_request", "invalid body")
	}
	body.Name, body.TeamID = strings.TrimSpace(body.Name), strings.TrimSpace(body.TeamID)
	body.SigningCredentialName = strings.TrimSpace(body.SigningCredentialName)
	if body.Name == "" || len(body.Name) > slackConnectionNameMax ||
		body.TeamID == "" || len(body.TeamID) > slackTeamIDMax || !slackTeamIDPattern.MatchString(body.TeamID) ||
		body.SigningCredentialName == "" || len(body.UserMappings) > slackUserMappingsMax {
		return "", "", "", nil, false, fail("slack_interaction_invalid_request", "invalid connection fields")
	}
	seen := map[string]bool{}
	for _, mapping := range body.UserMappings {
		if mapping.SlackUserID == "" || len(mapping.SlackUserID) > slackUserIDMax ||
			mapping.UserID == "" || len(mapping.UserID) > slackUserIDMax || seen[mapping.SlackUserID] {
			return "", "", "", nil, false, fail("slack_interaction_invalid_request", "invalid or duplicate user mapping")
		}
		seen[mapping.SlackUserID] = true
	}
	// The signing credential must exist (kind slack_signing_secret) and
	// RESOLVE before the callback URL is handed to Slack.
	q := store.New(s.pool)
	credential, err := q.GetCredentialByName(r.Context(), store.GetCredentialByNameParams{
		OrgID: rc.orgID, Kind: "slack_signing_secret", Name: body.SigningCredentialName,
	})
	if err != nil || !secretstore.HasCredentialSecretRef(r.Context(), q, rc.orgID, credential.SecretRef) {
		res := opError(http.StatusBadRequest, "slack_interaction_invalid_request",
			"signing credential not found or unresolvable", nil)
		return "", "", "", nil, false, &res
	}
	mappingsJSON, _ = json.Marshal(body.UserMappings)
	enabled = true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	return body.Name, body.TeamID, body.SigningCredentialName, mappingsJSON, enabled, nil
}

func (s *V1Server) slackCallbackHandler(w http.ResponseWriter, r *http.Request) {
	connectionID := r.PathValue("id")
	q := store.New(s.pool)
	connection, err := q.GetSlackInteractionConnectionForCallback(r.Context(), connectionID)
	if err != nil || !connection.Enabled {
		writeLegacy(w, opError(http.StatusNotFound, "slack_interaction_not_found", "interaction connection not found", nil))
		return
	}
	secret := ""
	if credential, err := q.GetCredentialByName(r.Context(), store.GetCredentialByNameParams{
		OrgID: connection.OrgID, Kind: "slack_signing_secret", Name: connection.SigningCredentialName,
	}); err == nil {
		secret = secretstore.ResolveCredentialSecretRef(r.Context(), q, connection.OrgID, credential.SecretRef)
	}
	rawBody, _ := io.ReadAll(io.LimitReader(r.Body, slackBodyMaxBytes))
	timestamp, reason := verifySlackSignature(
		r.Header.Get("x-slack-request-timestamp"), r.Header.Get("x-slack-signature"),
		string(rawBody), secret, time.Now().Unix())
	if reason != "" {
		writeLegacy(w, opError(http.StatusUnauthorized, "slack_interaction_invalid_signature", "invalid Slack signature", nil))
		return
	}
	rejected := func(reason string, metadata map[string]any) {
		payload := map[string]any{"reason": reason}
		for key, value := range metadata {
			payload[key] = value
		}
		audit.Write(r.Context(), s.pool, &auth.Context{OrgID: connection.OrgID, UserID: "slack:interaction"},
			"slack.interaction.rejected", audit.Options{
				TargetType: "slack-interaction", TargetID: connection.ID, Metadata: payload,
			})
	}
	interaction := parseSlackInteractionPayload(string(rawBody))
	if interaction == nil {
		rejected("invalid_payload", nil)
		writeLegacy(w, opError(http.StatusBadRequest, "slack_interaction_invalid_request", "invalid Slack interaction payload", nil))
		return
	}
	if interaction.TeamID != connection.TeamID {
		rejected("team_mismatch", map[string]any{"signedTeamId": interaction.TeamID})
		writeLegacy(w, opError(http.StatusForbidden, "slack_interaction_unauthorized", "Slack team is not authorized", nil))
		return
	}
	var mappings []slackMapping
	_ = json.Unmarshal(connection.UserMappings, &mappings)
	mappedUserID := ""
	for _, mapping := range mappings {
		if mapping.SlackUserID == interaction.SlackUserID {
			mappedUserID = mapping.UserID
			break
		}
	}
	if mappedUserID == "" {
		rejected("user_unmapped", map[string]any{"slackUserId": interaction.SlackUserID})
		writeLegacy(w, opError(http.StatusForbidden, "slack_interaction_unauthorized", "Slack user is not authorized", nil))
		return
	}
	// Authorization through the NORMAL layer, mode supabase — a mapped
	// user without a real membership (or below editor + recovery.write)
	// is refused; no dev auto-admin applies here.
	role, err := auth.ResolveMemberRole(r.Context(), q, connection.OrgID, mappedUserID, auth.ModeSupabase)
	permitted := false
	if err == nil && role != nil && auth.Rank[role.InheritsFrom] >= auth.Rank[auth.RoleEditor] {
		permissions, err := auth.EffectivePermissions(r.Context(), q, connection.OrgID, role)
		permitted = err == nil && permissions["recovery.write"]
	}
	if !permitted {
		rejected("permission_denied", map[string]any{
			"slackUserId": interaction.SlackUserID, "mappedUserId": mappedUserID,
		})
		writeLegacy(w, opError(http.StatusForbidden, "slack_interaction_unauthorized", "mapped user lacks recovery permission", nil))
		return
	}
	actor := &auth.Context{OrgID: connection.OrgID, UserID: mappedUserID}
	slackMetadata := map[string]any{
		"source": "slack",
		"slack": map[string]any{
			"connectionId": connection.ID, "teamId": connection.TeamID,
			"slackUserId": interaction.SlackUserID,
		},
	}
	if interaction.ActionID == slackActionOpen {
		audit.Write(r.Context(), s.pool, actor, "slack.interaction.opened", audit.Options{
			TargetType: "recovery-item", TargetID: interaction.Value, Metadata: slackMetadata,
		})
		writeLegacy(w, opOK(map[string]any{"ok": true}))
		return
	}

	// Replay claim + mutation in ONE transaction: the receipt insert is
	// the idempotency boundary (PK = digest of connection+ts+raw body).
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txq := store.New(tx)
	_ = txq.PurgeExpiredSlackReceipts(ctx, store.PurgeExpiredSlackReceiptsParams{
		OrgID: connection.OrgID, ConnectionID: connection.ID,
		CreatedAt: time.Now().Add(-slackReceiptTTL),
	})
	claimed, err := txq.InsertSlackInteractionReceipt(ctx, store.InsertSlackInteractionReceiptParams{
		ID: slackReceiptID(connection.ID, timestamp, string(rawBody)), OrgID: connection.OrgID,
		ConnectionID: connection.ID,
	})
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	if claimed == 0 {
		writeLegacy(w, opOK(map[string]any{"ok": true, "duplicate": true}))
		return
	}
	item, err := txq.GetRecoveryItemByID(ctx, store.GetRecoveryItemByIDParams{
		OrgID: connection.OrgID, ID: interaction.Value,
	})
	if err != nil {
		writeLegacy(w, opError(http.StatusNotFound, "recovery_item_not_found", "recovery item not found", nil))
		return
	}
	var fromStatuses []string
	toStatus := item.Status
	newOwner := pgtype.Text{String: mappedUserID, Valid: true}
	actionKind, auditName := "assign_to_me", "recovery.item.assigned"
	if interaction.ActionID == slackActionAcknowledge {
		actionKind, auditName = "acknowledge", "recovery.item.acknowledged"
		fromStatuses = []string{"open", "reopened"}
		toStatus = "acknowledged"
	} else {
		fromStatuses = []string{item.Status}
	}
	moved, err := txq.TransitionRecoveryItem(ctx, store.TransitionRecoveryItemParams{
		OrgID: connection.OrgID, ID: interaction.Value, ToStatus: toStatus,
		NewOwner:     newOwner,
		Actor:        pgtype.Text{String: mappedUserID, Valid: true},
		FromStatuses: fromStatuses,
	})
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	if moved == 0 {
		writeLegacy(w, opError(http.StatusConflict, "recovery_item_transition_invalid",
			"recovery action is no longer available", map[string]any{"currentStatus": item.Status}))
		return
	}
	after, _ := txq.GetRecoveryItemByID(ctx, store.GetRecoveryItemByIDParams{
		OrgID: connection.OrgID, ID: interaction.Value,
	})
	transitionMetadata := map[string]any{
		"before": map[string]any{"status": item.Status, "owner": textOrNull(item.Owner)},
		"after":  map[string]any{"status": after.Status, "owner": textOrNull(after.Owner)},
	}
	for key, value := range slackMetadata {
		transitionMetadata[key] = value
	}
	auditMetadataJSON, _ := json.Marshal(transitionMetadata)
	if err := txq.InsertAuditLogRow(ctx, store.InsertAuditLogRowParams{
		ID: s.newID(), OrgID: connection.OrgID,
		UserID:     pgtype.Text{String: mappedUserID, Valid: true},
		Action:     auditName,
		TargetType: pgtype.Text{String: "recovery-item", Valid: true},
		TargetID:   pgtype.Text{String: interaction.Value, Valid: true},
		Metadata:   auditMetadataJSON,
	}); err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	message := "Janusly assigned the recovery item to you."
	if actionKind == "acknowledge" {
		message = "Janusly acknowledged the recovery item."
	}
	writeLegacy(w, opOK(map[string]any{"ok": true, "response_type": "ephemeral", "text": message}))
}

func (s *V1Server) mountSlackInteractionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /webhooks/slack/interactions/{id}", s.slackCallbackHandler)
	mux.HandleFunc("POST /webhooks/pagerduty/{workflowId}/{nodeId}", s.pagerDutyCallbackHandler)
	mux.HandleFunc("GET /integrations/slack/interactions", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).ListSlackInteractionConnections(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		connections := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			connections = append(connections, slackConnectionView(row))
		}
		writeLegacy(w, opOK(map[string]any{"connections": connections}))
	}))
	mux.HandleFunc("POST /integrations/slack/interactions", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		name, teamID, credentialName, mappingsJSON, enabled, bad := s.parseSlackConnectionBody(r, rc)
		if bad != nil {
			writeLegacy(w, *bad)
			return
		}
		id := s.newID()
		if err := store.New(s.pool).InsertSlackInteractionConnection(r.Context(), store.InsertSlackInteractionConnectionParams{
			ID: id, OrgID: rc.orgID, Name: name, TeamID: teamID,
			SigningCredentialName: credentialName, UserMappings: mappingsJSON,
			Enabled: enabled, CreatedBy: rc.userID,
		}); err != nil {
			writeLegacy(w, opError(http.StatusConflict, "slack_interaction_conflict", "connection name or team already exists", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "slack.interaction.created", audit.Options{
			TargetType: "slack-interaction", TargetID: id, Metadata: map[string]any{"teamId": teamID},
		})
		row, _ := store.New(s.pool).GetSlackInteractionConnection(r.Context(), store.GetSlackInteractionConnectionParams{OrgID: rc.orgID, ID: id})
		writeLegacy(w, opOK(map[string]any{"connection": slackConnectionView(row)}))
	}))
	mux.HandleFunc("POST /integrations/slack/interactions/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		id := r.PathValue("id")
		name, teamID, credentialName, mappingsJSON, enabled, bad := s.parseSlackConnectionBody(r, rc)
		if bad != nil {
			writeLegacy(w, *bad)
			return
		}
		updated, err := store.New(s.pool).UpdateSlackInteractionConnection(r.Context(), store.UpdateSlackInteractionConnectionParams{
			OrgID: rc.orgID, ID: id, Name: name, TeamID: teamID,
			SigningCredentialName: credentialName, UserMappings: mappingsJSON, Enabled: enabled,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusConflict, "slack_interaction_conflict", "connection name or team already exists", nil))
			return
		}
		if updated == 0 {
			writeLegacy(w, opError(http.StatusNotFound, "slack_interaction_not_found", "interaction connection not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "slack.interaction.updated", audit.Options{
			TargetType: "slack-interaction", TargetID: id,
		})
		row, _ := store.New(s.pool).GetSlackInteractionConnection(r.Context(), store.GetSlackInteractionConnectionParams{OrgID: rc.orgID, ID: id})
		writeLegacy(w, opOK(map[string]any{"connection": slackConnectionView(row)}))
	}))
	mux.HandleFunc("DELETE /integrations/slack/interactions/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		id := r.PathValue("id")
		deleted, err := store.New(s.pool).DeleteSlackInteractionConnection(r.Context(), store.DeleteSlackInteractionConnectionParams{
			OrgID: rc.orgID, ID: id,
		})
		if err != nil || deleted == 0 {
			writeLegacy(w, opError(http.StatusNotFound, "slack_interaction_not_found", "interaction connection not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "slack.interaction.deleted", audit.Options{
			TargetType: "slack-interaction", TargetID: id,
		})
		writeLegacy(w, opOK(map[string]any{"ok": true}))
	}))
}
