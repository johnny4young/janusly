// Member management, ported from the reference's members routes with
// their wire shapes verbatim: invite validation ladder (role defined for
// the org — built-in OR custom —, email format, pending-invite 409,
// existing-member 409), the self-modification guard on role changes and
// removal (an admin cannot demote or remove THEMSELVES — the lock-out
// rationale — with the blocked attempt audited carrying the operator's
// raw intent), and the no-cascade member delete. Mutations pair their
// audit rows transactionally through WithAuditTx — a strictly stronger
// posture than the reference's post-hoc best-effort on these routes,
// recorded in the plan registry.
package httpapi

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/store"
)

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// roleDefinedForOrg accepts built-ins or org-defined custom roles.
func (s *V1Server) roleDefinedForOrg(r *http.Request, orgID, roleName string) (bool, error) {
	if auth.IsBuiltinRole(roleName) {
		return true, nil
	}
	_, err := store.New(s.pool).GetOrgRole(r.Context(), store.GetOrgRoleParams{OrgID: orgID, Name: roleName})
	if err == nil {
		return true, nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return false, err
}

func (s *V1Server) listMembersCore(r *http.Request, rc v1Request) opResult {
	rows, err := store.New(s.pool).ListOrgMembers(r.Context(), rc.orgID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{
			"id": row.ID, "orgId": row.OrgID, "userId": row.UserID,
			"email": textOrNull(row.Email), "role": row.Role,
			"invitedBy": textOrNull(row.InvitedBy), "createdAt": timeOrNull(row.CreatedAt),
		})
	}
	return opOK(map[string]any{"members": items})
}

func (s *V1Server) listInvitationsCore(r *http.Request, rc v1Request) opResult {
	rows, err := store.New(s.pool).ListOrgInvitations(r.Context(), rc.orgID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{
			"id": row.ID, "orgId": row.OrgID, "email": row.Email, "role": row.Role,
			"invitedBy": textOrNull(row.InvitedBy), "status": row.Status,
			"acceptedAt": timeOrNull(row.AcceptedAt), "createdAt": timeOrNull(row.CreatedAt),
		})
	}
	return opOK(map[string]any{"invitations": items})
}

func (s *V1Server) inviteMemberCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := decodeBody(r, &body); err != nil {
		return opError(http.StatusBadRequest, "email_required", "email is required", nil)
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	roleName := strings.TrimSpace(body.Role)
	if roleName == "" {
		roleName = "viewer"
	}
	defined, err := s.roleDefinedForOrg(r, rc.orgID, roleName)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if !defined {
		return opError(http.StatusBadRequest, "members_role_not_defined",
			`role "{{role}}" is not defined for this org`, map[string]any{"role": roleName})
	}
	if email == "" {
		return opError(http.StatusBadRequest, "email_required", "email is required", nil)
	}
	if !emailPattern.MatchString(email) || len(email) > 254 {
		return opError(http.StatusBadRequest, "email_invalid", "email format is invalid", nil)
	}
	ctx := r.Context()
	q := store.New(s.pool)
	if _, err := q.FindPendingInvitation(ctx, store.FindPendingInvitationParams{
		OrgID: rc.orgID, Email: email,
	}); err == nil {
		return opError(http.StatusConflict, "invitation_pending_exists",
			"Invitation already pending for this email", map[string]any{"email": email})
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if _, err := q.FindOrgMemberRowByEmail(ctx, store.FindOrgMemberRowByEmailParams{
		OrgID: rc.orgID, Email: pgtype.Text{String: email, Valid: true},
	}); err == nil {
		return opError(http.StatusConflict, "member_exists",
			"Member already exists for this org", map[string]any{"email": email})
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	inviteID := s.newID()
	err = audit.WithAuditTx(ctx, s.pool, rc.authContext, func(tx pgx.Tx, txAudit audit.TxAudit) error {
		if err := store.New(tx).InsertInvitation(ctx, store.InsertInvitationParams{
			ID: inviteID, OrgID: rc.orgID, Email: email, Role: roleName,
			InvitedBy: pgtype.Text{String: rc.userID, Valid: true},
		}); err != nil {
			return err
		}
		return txAudit("invitation.created", audit.Options{
			TargetType: "invitation", TargetID: inviteID,
			Metadata: map[string]any{"email": email, "role": roleName},
		})
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(map[string]any{"id": inviteID, "status": "pending"})
}

func (s *V1Server) revokeInvitationCore(r *http.Request, rc v1Request, id string) opResult {
	if id == "" {
		return opError(http.StatusBadRequest, "members_invitation_id_required", "invitation id is required", nil)
	}
	var revoked int64
	err := audit.WithAuditTx(r.Context(), s.pool, rc.authContext, func(tx pgx.Tx, txAudit audit.TxAudit) error {
		rows, err := store.New(tx).RevokePendingInvitation(r.Context(), store.RevokePendingInvitationParams{
			ID: id, OrgID: rc.orgID,
		})
		if err != nil {
			return err
		}
		revoked = rows
		if rows == 0 {
			return nil // 404 outside the tx; nothing to audit
		}
		return txAudit("invitation.revoked", audit.Options{TargetType: "invitation", TargetID: id})
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if revoked == 0 {
		return opError(http.StatusNotFound, "members_invitation_not_found", "invitation not found or not pending", nil)
	}
	return opOK(map[string]any{"ok": true})
}

func (s *V1Server) setMemberRoleCore(r *http.Request, rc v1Request) opResult {
	var body struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	if err := decodeBody(r, &body); err != nil || body.UserID == "" {
		return opError(http.StatusBadRequest, "members_user_id_required", "userId is required", nil)
	}
	roleName := strings.TrimSpace(body.Role)
	if body.UserID == rc.userID {
		// The lock-out guard: audited with the raw operator intent.
		audit.Write(r.Context(), s.pool, rc.authContext, "member.self_modification_blocked", audit.Options{
			TargetType: "member", TargetID: body.UserID,
			Metadata: map[string]any{"action": "role_set", "attemptedRole": body.Role},
		})
		return opError(http.StatusBadRequest, "self_membership_modification", "Cannot modify your own membership", nil)
	}
	defined, err := s.roleDefinedForOrg(r, rc.orgID, roleName)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if !defined {
		return opError(http.StatusBadRequest, "members_role_not_defined",
			`role "{{role}}" is not defined for this org`, map[string]any{"role": roleName})
	}
	var updated int64
	err = audit.WithAuditTx(r.Context(), s.pool, rc.authContext, func(tx pgx.Tx, txAudit audit.TxAudit) error {
		rows, err := store.New(tx).UpdateOrgMemberRole(r.Context(), store.UpdateOrgMemberRoleParams{
			OrgID: rc.orgID, UserID: body.UserID, Role: roleName,
		})
		if err != nil {
			return err
		}
		updated = rows
		if rows == 0 {
			return nil // 404 outside; a phantom change is never audited
		}
		return txAudit("member.role.updated", audit.Options{
			TargetType: "member", TargetID: body.UserID,
			Metadata: map[string]any{"role": roleName},
		})
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	if updated == 0 {
		return opError(http.StatusNotFound, "member_not_found", "member not found", nil)
	}
	return opOK(map[string]any{"ok": true})
}

func (s *V1Server) removeMemberCore(r *http.Request, rc v1Request) opResult {
	userID := r.URL.Query().Get("userId")
	if userID == "" {
		return opError(http.StatusBadRequest, "members_user_id_required", "userId is required", nil)
	}
	if userID == rc.userID {
		audit.Write(r.Context(), s.pool, rc.authContext, "member.self_modification_blocked", audit.Options{
			TargetType: "member", TargetID: userID,
			Metadata: map[string]any{"action": "remove"},
		})
		return opError(http.StatusBadRequest, "self_membership_modification", "Cannot modify your own membership", nil)
	}
	err := audit.WithAuditTx(r.Context(), s.pool, rc.authContext, func(tx pgx.Tx, txAudit audit.TxAudit) error {
		// No cascade: ONLY the membership row goes; workflows, runs, and
		// audit rows stay (audit is append-only). The session dies on the
		// target's next request via the resolver.
		if _, err := store.New(tx).DeleteOrgMember(r.Context(), store.DeleteOrgMemberParams{
			OrgID: rc.orgID, UserID: userID,
		}); err != nil {
			return err
		}
		return txAudit("member.removed", audit.Options{TargetType: "member", TargetID: userID})
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(map[string]any{"ok": true})
}

func (s *V1Server) mountMemberRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /members", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.listMembersCore(r, rc))
	}))
	mux.HandleFunc("GET /members/invitations", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.listInvitationsCore(r, rc))
	}))
	mux.HandleFunc("POST /members/invite", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.inviteMemberCore(r, rc))
	}))
	mux.HandleFunc("POST /members/invitations/{id}/revoke", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.revokeInvitationCore(r, rc, r.PathValue("id")))
	}))
	mux.HandleFunc("POST /members/role", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.setMemberRoleCore(r, rc))
	}))
	mux.HandleFunc("DELETE /members", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.removeMemberCore(r, rc))
	}))
}
