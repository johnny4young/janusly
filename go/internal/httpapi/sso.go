// WorkOS SSO administration and authorization start. The public callback is
// implemented in the next authentication band because its membership, audit,
// and browser-session writes form one separate transactional boundary.
package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/ssostate"
	"github.com/johnny4young/janusly/go/internal/store"
)

const ssoMaxJSONBodyBytes int64 = 1_048_576

func ssoConnectionView(row store.SsoConnection) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "provider": row.Provider,
		"providerConnectionId": row.ProviderConnectionID, "status": row.Status,
		"enforcedSso": row.EnforcedSso, "configJson": rawOrNull(row.ConfigJson),
		"createdAt": timeOrNull(row.CreatedAt), "updatedAt": timeOrNull(row.UpdatedAt),
	}
}

func writeLegacyValue(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func decodeSsoRecord(r *http.Request) (map[string]any, *opResult) {
	return decodeJSONRecord(r, ssoMaxJSONBodyBytes)
}

func (s *V1Server) listSsoConnections(w http.ResponseWriter, r *http.Request, rc v1Request) {
	rows, err := store.New(s.pool).ListSsoConnections(r.Context(), rc.orgID)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	views := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		views = append(views, ssoConnectionView(row))
	}
	writeLegacyValue(w, views)
}

func (s *V1Server) createSsoConnection(r *http.Request, rc v1Request) opResult {
	body, rejection := decodeSsoRecord(r)
	if rejection != nil {
		return *rejection
	}
	provider, _ := body["provider"].(string)
	if provider != "workos" {
		return opError(http.StatusBadRequest, "sso_provider_invalid", "provider must be 'workos'", nil)
	}
	providerConnectionID, _ := body["providerConnectionId"].(string)
	providerConnectionID = strings.TrimSpace(providerConnectionID)
	if providerConnectionID == "" {
		return opError(http.StatusBadRequest, "sso_provider_connection_id_required",
			"providerConnectionId is required (e.g. conn_…)", nil)
	}
	q := store.New(s.pool)
	if _, err := q.FindSsoConnectionForOrg(r.Context(), rc.orgID); err == nil {
		return opError(http.StatusConflict, "sso_connection_exists",
			"SSO connection already exists for this org and provider", nil)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	enforced, _ := body["enforcedSso"].(bool)
	row, err := q.CreateSsoConnection(r.Context(), store.CreateSsoConnectionParams{
		ID: s.newID(), OrgID: rc.orgID, Provider: "workos",
		ProviderConnectionID: providerConnectionID, EnforcedSso: enforced,
	})
	if err != nil {
		if isUniqueViolation(err) {
			return opError(http.StatusConflict, "sso_connection_exists",
				"SSO connection already exists for this org and provider", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "org.sso.connection_added", audit.Options{
		TargetType: "sso_connection", TargetID: row.ID,
		Metadata: map[string]any{
			"provider": row.Provider, "providerConnectionId": row.ProviderConnectionID,
			"enforcedSso": row.EnforcedSso,
		},
	})
	return opOK(ssoConnectionView(row))
}

func (s *V1Server) updateSsoConnection(r *http.Request, rc v1Request) opResult {
	body, rejection := decodeSsoRecord(r)
	if rejection != nil {
		return *rejection
	}
	params := store.UpdateSsoConnectionParams{ID: r.PathValue("id"), OrgID: rc.orgID}
	metadata := map[string]any{}
	if status, ok := body["status"].(string); ok && (status == "active" || status == "revoked") {
		params.Status = pgtype.Text{String: status, Valid: true}
		metadata["status"] = status
	}
	if enforced, ok := body["enforcedSso"].(bool); ok {
		params.EnforcedSso = pgtype.Bool{Bool: enforced, Valid: true}
		metadata["enforcedSso"] = enforced
	}
	if raw, present := body["providerConnectionId"]; present {
		providerConnectionID, _ := raw.(string)
		providerConnectionID = strings.TrimSpace(providerConnectionID)
		if providerConnectionID == "" {
			return opError(http.StatusBadRequest, "sso_provider_connection_id_invalid",
				"providerConnectionId must be a non-empty string", nil)
		}
		params.ProviderConnectionID = pgtype.Text{String: providerConnectionID, Valid: true}
		metadata["providerConnectionId"] = providerConnectionID
	}
	if len(metadata) == 0 {
		return opError(http.StatusBadRequest, "sso_no_updatable_fields", "no updatable fields provided", nil)
	}
	q := store.New(s.pool)
	if _, err := q.GetSsoConnectionByID(r.Context(), store.GetSsoConnectionByIDParams{
		ID: params.ID, OrgID: rc.orgID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusNotFound, "sso_connection_not_found", "SSO connection not found", nil)
	} else if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	updated, err := q.UpdateSsoConnection(r.Context(), params)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "sso_connection_not_found", "SSO connection not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "org.sso.connection_updated", audit.Options{
		TargetType: "sso_connection", TargetID: params.ID, Metadata: metadata,
	})
	return opOK(ssoConnectionView(updated))
}

func (s *V1Server) revokeSsoConnection(r *http.Request, rc v1Request) opResult {
	id := r.PathValue("id")
	q := store.New(s.pool)
	if _, err := q.GetSsoConnectionByID(r.Context(), store.GetSsoConnectionByIDParams{
		ID: id, OrgID: rc.orgID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return opError(http.StatusNotFound, "sso_connection_not_found", "SSO connection not found", nil)
	} else if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	if _, err := q.RevokeSsoConnection(r.Context(), store.RevokeSsoConnectionParams{ID: id, OrgID: rc.orgID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return opError(http.StatusNotFound, "sso_connection_not_found", "SSO connection not found", nil)
		}
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	audit.Write(r.Context(), s.pool, rc.authContext, "org.sso.connection_revoked", audit.Options{
		TargetType: "sso_connection", TargetID: id,
	})
	return opOK(map[string]any{"ok": true})
}

func newSsoNonce() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

func redirectNoStore(w http.ResponseWriter, target string) {
	w.Header().Set("Location", target)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusFound)
	_, _ = fmt.Fprintf(w, `<html><body><a href="%s">Continue</a></body></html>`, strings.ReplaceAll(target, `"`, "&quot;"))
}

func (s *V1Server) startSso(w http.ResponseWriter, r *http.Request) {
	orgID := r.URL.Query().Get("orgId")
	if orgID == "" {
		writeLegacy(w, opError(http.StatusBadRequest, "sso_org_id_required", "orgId is required", nil))
		return
	}
	callbackURL := os.Getenv("JANUSLY_SSO_CALLBACK_URL")
	if callbackURL == "" {
		writeLegacy(w, opError(http.StatusInternalServerError, "sso_callback_not_configured",
			"SSO is not configured (missing JANUSLY_SSO_CALLBACK_URL)", nil))
		return
	}
	connection, err := store.New(s.pool).FindSsoConnectionForOrg(r.Context(), orgID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && connection.Status != "active") {
		writeLegacy(w, opError(http.StatusNotFound, "sso_no_active_connection",
			"no active SSO connection for this org", nil))
		return
	}
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	nonce, err := newSsoNonce()
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	state, err := ssostate.Create(orgID, nonce, callbackURL)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	if err := store.New(s.pool).RecordSsoNonce(r.Context(), store.RecordSsoNonceParams{
		ID: s.newID(), OrgID: orgID, Nonce: nonce, ExpiresAt: state.ExpiresAt,
	}); err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	if s.workos == nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	authorizeURL, err := s.workos.BuildAuthorizeURL(connection.ProviderConnectionID, callbackURL, state.Value)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	audit.WriteAs(r.Context(), s.pool, orgID, "sso", "auth.sso.start", audit.Options{
		TargetType: "sso_connection", TargetID: connection.ID,
		Metadata: map[string]any{
			"provider": connection.Provider, "connectionId": connection.ProviderConnectionID,
		},
	})
	redirectNoStore(w, authorizeURL)
}

func (s *V1Server) mountSsoRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /org/sso/connections", s.auth(s.listSsoConnections))
	mux.HandleFunc("POST /org/sso/connections", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.createSsoConnection(r, rc))
	}))
	mux.HandleFunc("POST /org/sso/connections/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.updateSsoConnection(r, rc))
	}))
	mux.HandleFunc("DELETE /org/sso/connections/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.revokeSsoConnection(r, rc))
	}))
	mux.HandleFunc("GET /auth/sso/start", s.startSso)
}
