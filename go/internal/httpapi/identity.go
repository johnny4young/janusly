// Identity and plugin surfaces: membership projection, profile upsert,
// invitation acceptance, and the honest plugin-install stub.
package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/store"
)

// normalizedIdentityName mirrors the reference: trim, collapse interior
// whitespace, 2..max chars — or empty when out of contract.
func normalizedIdentityName(value string, maxLength int) string {
	normalized := strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	if len(normalized) < 2 || len(normalized) > maxLength {
		return ""
	}
	return normalized
}

// organizationsCore lists the caller's REAL memberships (org name + plan
// + role). Works for identities with zero memberships — the multi-org
// switcher needs the empty list, not a 403.
func (s *V1Server) organizationsCore(r *http.Request, rc identityRequest) opResult {
	rows, err := store.New(s.pool).ListUserMemberships(r.Context(), rc.userID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	organizations := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		organizations = append(organizations, map[string]any{
			"id": row.OrgID, "name": row.OrganizationName, "plan": textOrNullString(row.Plan),
			"role": row.Role,
		})
	}
	return opOK(map[string]any{"organizations": organizations})
}

func (s *V1Server) usersMeCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Name *string `json:"name"`
	}
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil)
	}
	name := pgtype.Text{}
	if body.Name != nil && *body.Name != "" {
		normalized := normalizedIdentityName(*body.Name, 100)
		if normalized == "" {
			return opError(http.StatusBadRequest, "profile_name_invalid", "Profile name must contain 2 to 100 characters", nil)
		}
		name = pgtype.Text{String: normalized, Valid: true}
	}
	email := pgtype.Text{String: rc.authContext.Email, Valid: rc.authContext.Email != ""}
	row, err := store.New(s.pool).UpsertUserProfile(r.Context(), store.UpsertUserProfileParams{
		ID: rc.userID, Name: name, Email: email,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "profile_update_failed", "Profile could not be updated", nil)
	}
	return opOK(map[string]any{
		"userId": row.ID, "name": textOrNull(row.Name), "email": textOrNull(row.Email),
	})
}

// invitationAcceptCore: verified-email identities only; the CAS flips a
// still-pending row exactly once and the membership lands with it.
func (s *V1Server) invitationAcceptCore(r *http.Request, rc identityRequest) opResult {
	identity := rc.identity
	if identity.Email == "" ||
		(identity.Mode != auth.ModeSupabase && identity.Mode != auth.ModeJanuslySession) {
		return opError(http.StatusForbidden, "identity_email_required", "A verified account email is required", nil)
	}
	var body struct {
		InvitationID string `json:"invitationId"`
	}
	if err := decodeBody(r, &body); err != nil || strings.TrimSpace(body.InvitationID) == "" {
		return opError(http.StatusBadRequest, "invitation_id_required", "Invitation id is required", nil)
	}
	invitationID := strings.TrimSpace(body.InvitationID)
	ctx := r.Context()
	q := store.New(s.pool)
	invitation, err := q.GetInvitationByID(ctx, invitationID)
	if err != nil {
		return opError(http.StatusNotFound, "invitation_not_found", "Invitation not found", nil)
	}
	if !strings.EqualFold(invitation.Email, identity.Email) {
		// Identical envelope to not-found: an invitation id must not leak
		// whose email it targets.
		return opError(http.StatusNotFound, "invitation_not_found", "Invitation not found", nil)
	}
	accepted, err := q.AcceptInvitation(ctx, invitationID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if accepted == 0 {
		return opError(http.StatusConflict, "invitation_not_pending", "Invitation is no longer pending", nil)
	}
	if _, err := q.InsertOrgMember(ctx, store.InsertOrgMemberParams{
		ID: uuid.NewString(), OrgID: invitation.OrgID, UserID: rc.userID, Role: invitation.Role,
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	auditContext := &auth.Context{
		OrgID: invitation.OrgID, UserID: identity.UserID,
		Mode: identity.Mode, Source: identity.Source,
		ServiceTokenSuffix: identity.ServiceTokenSuffix, BrowserSessionID: identity.BrowserSessionID,
	}
	audit.Write(ctx, s.pool, auditContext, "member.joined", audit.Options{
		TargetType: "invitation", TargetID: invitationID,
		Metadata: map[string]any{"organizationId": invitation.OrgID, "role": invitation.Role},
	})
	return opOK(map[string]any{
		"accepted": true, "organizationId": invitation.OrgID, "role": invitation.Role,
	})
}

// pluginInstallCore is the reference's honest stub: persist the install
// row + audit — no plugin runtime exists yet, and the row says exactly
// that.
func (s *V1Server) pluginInstallCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		PluginID string          `json:"pluginId"`
		Config   json.RawMessage `json:"config"`
	}
	if err := decodeBody(r, &body); err != nil || body.PluginID == "" {
		return opError(http.StatusBadRequest, "plugins_plugin_id_required", "pluginId is required", nil)
	}
	config := body.Config
	if len(config) == 0 || string(config) == "null" {
		config = json.RawMessage(`{}`)
	}
	id := uuid.NewString()
	if err := store.New(s.pool).InsertInstalledPlugin(r.Context(), store.InsertInstalledPluginParams{
		ID: id, OrgID: rc.orgID, PluginID: body.PluginID,
		ConfigJson: config, InstalledBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
	}); err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	var metadata map[string]any
	_ = json.Unmarshal(config, &metadata)
	audit.Write(r.Context(), s.pool, rc.authContext, "plugin.installed", audit.Options{
		TargetType: "plugin", TargetID: body.PluginID, Metadata: metadata,
	})
	return opOK(map[string]any{"id": id})
}

func (s *V1Server) mountIdentityRoutes(mux *http.ServeMux) {
	// Membership projection and invitation acceptance use provider identity;
	// profile updates remain tenant-authenticated like the reference.
	mux.HandleFunc("GET /organizations", s.identity(func(w http.ResponseWriter, r *http.Request, rc identityRequest) {
		writeLegacy(w, s.organizationsCore(r, rc))
	}))
	mux.HandleFunc("POST /users/me", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.usersMeCore(r, rc))
	}))
	mux.HandleFunc("POST /auth/invitations/accept", s.identity(func(w http.ResponseWriter, r *http.Request, rc identityRequest) {
		writeLegacy(w, s.invitationAcceptCore(r, rc))
	}))
	s.route(mux, "POST /plugins/install", routeGate{auth.RoleAdmin, "workflows.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.pluginInstallCore(r, rc))
	})
}
