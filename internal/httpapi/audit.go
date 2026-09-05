// Audit-trail read surface, implements the contract's audit routes: one
// keyset page of the org's audit rows, newest-first, with an optional
// `action` PREFIX filter (so `org.scim` surfaces every SCIM action) and
// `(createdAt, id)` DESC cursor pagination so an operator can page back
// through history, not just the latest window. Admin-gated in the route
// registry — the org-wide trail is a compliance surface. The wire is the
// contract's raw page: {rows, nextCursor, hasMore}.
package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	auditPageDefault = 100
	auditPageMax     = 200
)

func (s *V1Server) auditTrail(w http.ResponseWriter, r *http.Request, rc v1Request) {
	query := r.URL.Query()
	limit := auditPageDefault
	if raw := query.Get("limit"); raw != "" {
		if n, err := parsePositiveInt(raw, auditPageMax); err == nil {
			limit = n
		}
	}
	action := query.Get("action")
	// An absent or malformed cursor reads from the top of the trail, like
	// the contract's null-on-invalid cursor parser.
	beforeCreatedAt := timeFarFuture()
	beforeID := "￿"
	if cursor := query.Get("cursor"); cursor != "" {
		if at, id, ok := parseEventsCursor(cursor); ok {
			beforeCreatedAt, beforeID = at, id
		}
	}

	// Over-fetch limit+1 to derive hasMore + the next (older) cursor.
	rows, err := store.New(s.pool).QueryAuditLogs(r.Context(), store.QueryAuditLogsParams{
		OrgID:           rc.orgID,
		ActionPrefix:    pgtype.Text{String: action, Valid: action != ""},
		BeforeCreatedAt: &beforeCreatedAt,
		BeforeID:        beforeID,
		PageLimit:       int32(limit + 1),
	})
	if err != nil {
		writeUnversioned(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	views := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		views = append(views, map[string]any{
			"id": row.ID, "orgId": row.OrgID, "userId": textOrNull(row.UserID),
			"action": row.Action, "targetType": textOrNull(row.TargetType),
			"targetId": textOrNull(row.TargetID), "metadata": rawOrNull(row.Metadata),
			"createdAt": timeOrNull(row.CreatedAt),
		})
	}
	var nextCursor any
	if hasMore && len(rows) > 0 {
		last := rows[len(rows)-1]
		if last.CreatedAt != nil {
			nextCursor = isoMillis(*last.CreatedAt) + "|" + last.ID
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"rows": views, "nextCursor": nextCursor, "hasMore": hasMore,
	})
}

func (s *V1Server) mountAuditRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /audit", routeGate{auth.RoleAdmin, "org.config.write"}, s.auditTrail)
}
