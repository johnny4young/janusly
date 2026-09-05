// Identity and plugin surfaces: membership projection, profile upsert,
// invitation acceptance, and the honest plugin-install stub.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

func decodeIdentityRecord(r *http.Request) (map[string]any, *opResult) {
	return decodeJSONRecord(r)
}

// normalizedIdentityName mirrors the contract: trim, collapse interior
// whitespace, 2..max chars — or empty when out of contract.
func normalizedIdentityName(value string, maxLength int) string {
	normalized := strings.Join(strings.Fields(strings.TrimSpace(value)), " ")
	// JavaScript String.length counts UTF-16 code units. Match the Node baseline
	// for non-ASCII names instead of accidentally enforcing a UTF-8 byte limit.
	length := len(utf16.Encode([]rune(normalized)))
	if length < 2 || length > maxLength {
		return ""
	}
	return normalized
}

func selectedIdentityContext(s *V1Server, r *http.Request, rc identityRequest, orgID string, status int) opResult {
	selected := *rc.identity
	selected.OrgHint = orgID
	rc.identity = &selected
	result := s.authContextCore(r.Context(), rc)
	if result.data != nil {
		result.status = status
	}
	return result
}

func identityText(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}

// organizationCreateCore commits the global profile, organization, founder
// grant, and forensic event together. Browser SSO sessions deliberately cannot
// create another tenant; the Node bootstrap contract requires a personal
// Supabase/dev identity for this operation.
func (s *V1Server) organizationCreateCore(r *http.Request, rc identityRequest) opResult {
	identity := rc.identity
	if identity.Mode == auth.ModeServiceToken || identity.Mode == auth.ModeJanuslySession {
		return opError(http.StatusForbidden, "identity_human_required", "Use a personal account to create an organization", nil)
	}
	body, rejection := decodeIdentityRecord(r)
	if rejection != nil {
		return *rejection
	}
	rawName, _ := body["name"].(string)
	organizationName := normalizedIdentityName(rawName, 80)
	if organizationName == "" {
		return opError(http.StatusBadRequest, "organization_name_invalid", "Organization name must contain 2 to 80 characters", nil)
	}

	profileName := ""
	if raw, present := body["profileName"]; present && raw != nil && raw != "" {
		value, ok := raw.(string)
		if !ok {
			return opError(http.StatusBadRequest, "profile_name_invalid", "Profile name must contain 2 to 100 characters", nil)
		}
		profileName = normalizedIdentityName(value, 100)
		if profileName == "" {
			return opError(http.StatusBadRequest, "profile_name_invalid", "Profile name must contain 2 to 100 characters", nil)
		}
	}

	orgID := "org_" + s.newID()
	memberID := s.newID()
	ctx := r.Context()
	err := audit.WithIdentityAuditTx(ctx, s.pool, identity, func(tx pgx.Tx, txAudit audit.IdentityTxAudit) error {
		q := store.New(tx)
		if _, err := q.UpsertIdentityProfile(ctx, store.UpsertIdentityProfileParams{
			ID: identity.UserID, Name: identityText(profileName), Email: identityText(identity.Email),
		}); err != nil {
			return err
		}
		if err := q.InsertIdentityOrganization(ctx, store.InsertIdentityOrganizationParams{
			ID: orgID, OwnerUserID: identity.UserID, Name: organizationName,
		}); err != nil {
			return err
		}
		if err := q.InsertFounderMembership(ctx, store.InsertFounderMembershipParams{
			ID: memberID, OrgID: orgID, UserID: identity.UserID, Email: identityText(identity.Email),
		}); err != nil {
			return err
		}
		return txAudit(orgID, "org.created", audit.Options{
			TargetType: "organization", TargetID: orgID,
			Metadata: map[string]any{"name": organizationName, "plan": "free", "founderRole": "admin", "ownerUserId": identity.UserID},
		})
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "organization_create_failed", "Organization could not be created", nil)
	}
	return selectedIdentityContext(s, r, rc, orgID, http.StatusCreated)
}

// organizationsCore lists the caller's REAL memberships (org name + plan
// + role). Works for identities with zero memberships — the multi-org
// switcher needs the empty list, not a 403.
func (s *V1Server) organizationsCore(r *http.Request, rc identityRequest) opResult {
	rows, err := store.New(s.pool).ListUserMemberships(r.Context(), rc.userID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	organizations := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		organizations = append(organizations, map[string]any{
			"id": row.OrgID, "name": row.OrganizationName, "plan": textOrNullString(row.Plan),
			"role": row.Role, "isOwner": row.IsOwner,
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

var errInvitationUnavailable = errors.New("invitation unavailable")

// invitationAcceptCore locks a still-pending invitation and commits its state,
// verified profile, membership grant, and audit row together. Every unavailable
// state uses the same 404 so invitation ids cannot disclose their target email.
func (s *V1Server) invitationAcceptCore(r *http.Request, rc identityRequest) opResult {
	identity := rc.identity
	if identity.Email == "" ||
		(identity.Mode != auth.ModeSupabase && identity.Mode != auth.ModeJanuslySession) {
		return opError(http.StatusForbidden, "identity_email_required", "A verified account email is required", nil)
	}
	body, rejection := decodeIdentityRecord(r)
	if rejection != nil {
		return *rejection
	}
	invitationID, _ := body["invitationId"].(string)
	if strings.TrimSpace(invitationID) == "" {
		return opError(http.StatusBadRequest, "invitation_id_required", "Invitation id is required", nil)
	}
	invitationID = strings.TrimSpace(invitationID)
	ctx := r.Context()
	normalizedEmail := strings.ToLower(strings.TrimSpace(identity.Email))
	acceptedOrgID := ""
	err := audit.WithIdentityAuditTx(ctx, s.pool, identity, func(tx pgx.Tx, txAudit audit.IdentityTxAudit) error {
		q := store.New(tx)
		target, err := q.GetIdentityInvitationLockTarget(ctx, store.GetIdentityInvitationLockTargetParams{
			ID: invitationID, Email: normalizedEmail,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return errInvitationUnavailable
		}
		if err != nil {
			return err
		}
		if err := q.LockInvitationLifecycle(ctx, invitationLifecycleLockKey(target.OrgID, target.Email)); err != nil {
			return err
		}
		invitation, err := q.LockPendingIdentityInvitation(ctx, store.LockPendingIdentityInvitationParams{
			ID: invitationID, Email: normalizedEmail,
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return errInvitationUnavailable
		}
		if err != nil {
			return err
		}
		updated, err := q.MarkIdentityInvitationAccepted(ctx, invitation.ID)
		if err != nil {
			return err
		}
		if updated != 1 {
			return errInvitationUnavailable
		}
		if _, err := q.UpsertIdentityProfile(ctx, store.UpsertIdentityProfileParams{
			ID: identity.UserID, Name: pgtype.Text{}, Email: identityText(normalizedEmail),
		}); err != nil {
			return err
		}
		if err := q.UpsertInvitedIdentityMembership(ctx, store.UpsertInvitedIdentityMembershipParams{
			ID: s.newID(), OrgID: invitation.OrgID, UserID: identity.UserID,
			Email: identityText(normalizedEmail), Role: invitation.Role,
			InvitedBy: invitation.InvitedBy,
		}); err != nil {
			return err
		}
		if err := txAudit(invitation.OrgID, "member.joined", audit.Options{
			TargetType: "member", TargetID: identity.UserID,
			Metadata: map[string]any{"via": "invitation", "invitationId": invitation.ID, "role": invitation.Role},
		}); err != nil {
			return err
		}
		acceptedOrgID = invitation.OrgID
		return nil
	})
	if errors.Is(err, errInvitationUnavailable) {
		return opError(http.StatusNotFound, "identity_invitation_not_found", "Invitation is no longer available", nil)
	}
	if err != nil {
		return opError(http.StatusInternalServerError, "identity_invitation_accept_failed", "Invitation could not be accepted", nil)
	}
	return selectedIdentityContext(s, r, rc, acceptedOrgID, http.StatusOK)
}

// pluginInstallCore is the contract's honest stub: persist the install
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
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
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
	// profile updates remain tenant-authenticated like the contract.
	mux.HandleFunc("GET /organizations", s.identity(func(w http.ResponseWriter, r *http.Request, rc identityRequest) {
		writeUnversioned(w, s.organizationsCore(r, rc))
	}))
	mux.HandleFunc("POST /organizations", s.identity(func(w http.ResponseWriter, r *http.Request, rc identityRequest) {
		writeUnversioned(w, s.organizationCreateCore(r, rc))
	}))
	mux.HandleFunc("POST /users/me", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.usersMeCore(r, rc))
	}))
	mux.HandleFunc("POST /auth/invitations/accept", s.identity(func(w http.ResponseWriter, r *http.Request, rc identityRequest) {
		writeUnversioned(w, s.invitationAcceptCore(r, rc))
	}))
	s.route(mux, "POST /plugins/install", routeGate{auth.RoleAdmin, "workflows.write"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeUnversioned(w, s.pluginInstallCore(r, rc))
	})
}
