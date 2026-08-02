package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/browsersession"
	"github.com/johnny4young/janusly/go/internal/store"
)

func (s *V1Server) browserSessionDiscovery(w http.ResponseWriter, _ *http.Request, rc identityRequest) {
	if rc.identity == nil || rc.identity.Mode != auth.ModeJanuslySession {
		writeLegacy(w, opOK(map[string]any{"authenticated": false}))
		return
	}
	writeLegacy(w, opOK(map[string]any{
		"authenticated": true, "userId": rc.identity.UserID,
		"email": identityEmail(rc.identity.Email), "organizationId": rc.identity.OrgHint,
	}))
}

func (s *V1Server) browserSessionLogout(w http.ResponseWriter, r *http.Request) {
	if err := browsersession.RequireCSRF(r, isAllowedRequestOrigin); err != nil {
		writeLegacy(w, opError(http.StatusForbidden, "server_request_failed", err.Error(), nil))
		return
	}
	if sessionID := browsersession.ReadSessionID(r); sessionID != "" {
		if _, err := store.New(s.pool).RevokeAuthSession(r.Context(), sessionID); err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
	}
	w.Header().Set("Set-Cookie", browsersession.ClearCookie())
	writeLegacy(w, opOK(map[string]any{"signedOut": true}))
}

func (s *V1Server) browserSessionOrganization(w http.ResponseWriter, r *http.Request, rc identityRequest) {
	identity := rc.identity
	if identity.Mode != auth.ModeJanuslySession || identity.BrowserSessionID == "" {
		writeLegacy(w, opError(http.StatusUnauthorized, "browser_session_required", "No active browser session", nil))
		return
	}
	var body struct {
		OrganizationID string `json:"organizationId"`
	}
	if err := decodeBody(r, &body); err != nil {
		writeLegacy(w, opError(http.StatusBadRequest, "invalid_input", "Invalid request body", nil))
		return
	}
	organizationID := strings.TrimSpace(body.OrganizationID)
	if organizationID == "" {
		writeLegacy(w, opError(http.StatusBadRequest, "organization_id_required", "Organization id is required", nil))
		return
	}
	q := store.New(s.pool)
	_, err := q.GetOrgMembership(r.Context(), store.GetOrgMembershipParams{
		OrgID: organizationID, UserID: identity.UserID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeLegacy(w, opError(http.StatusForbidden, "organization_access_denied", "You do not belong to this organization", nil))
		return
	}
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	updated, err := q.UpdateAuthSessionOrganization(r.Context(), store.UpdateAuthSessionOrganizationParams{
		ID: identity.BrowserSessionID, UserID: identity.UserID, OrgID: organizationID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeLegacy(w, opError(http.StatusConflict, "browser_session_update_failed", "Browser session could not be updated", nil))
		return
	}
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	ttlSeconds := max(1, int(time.Until(updated.ExpiresAt)/time.Second))
	token, err := browsersession.CreateToken(updated.ID, ttlSeconds)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	w.Header().Set("Set-Cookie", browsersession.SessionCookie(token.Value, ttlSeconds))
	writeLegacy(w, opOK(map[string]any{"organizationId": organizationID}))
}

func (s *V1Server) mountBrowserSessionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /auth/session", s.optionalIdentity(s.browserSessionDiscovery))
	mux.HandleFunc("POST /auth/session/logout", s.browserSessionLogout)
	mux.HandleFunc("POST /auth/session/organization", s.identity(s.browserSessionOrganization))
}
