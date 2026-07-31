// The identity bootstrap the web performs before anything else: /auth/context
// resolves the session's organizations and their effective permissions —
// without it, the client's permission gate empties every read into its
// fallback. The pilot serves the reference's dev-headers branch: the org
// hint synthesizes an admin workspace (labelled developmentFallback, exactly
// like the reference) carrying the catalog's full admin permission set.
package httpapi

import (
	"encoding/json"
	"net/http"
)

// adminPermissions is the reference catalog's admin grant set (extracted
// from apps/api/src/permission-catalog.ts at the pin) — the keys the web's
// permission gate checks before each read.
var adminPermissions = []string{
	"ai.write", "alerts.read", "alerts.write", "autohealing.decide",
	"autohealing.read", "credentials.read", "credentials.write", "dlq.read",
	"dlq.replay", "evals.read", "evals.write", "external-runtimes.read",
	"external-runtimes.write", "mcp.connections.read", "mcp.connections.write",
	"members.read", "members.role_set", "members.write", "onboarding.read",
	"onboarding.write", "org.config.write", "org.permissions.write",
	"packs.install", "packs.read", "prompts.read", "prompts.write",
	"recovery.read", "recovery.write", "reports.deliver", "reports.read",
	"runs.cancel", "runs.read", "runs.start", "snippets.read",
	"snippets.write", "triggers.ingest", "triggers.read", "upstream.read",
	"upstream.write", "workflows.read", "workflows.write",
}

func (s *V1Server) authContext(w http.ResponseWriter, r *http.Request, rc v1Request) {
	organization := map[string]any{
		"id": rc.orgID, "name": rc.orgID, "plan": nil,
		"role": "admin", "roleBase": "admin",
		"permissions": adminPermissions,
		"usable":      true, "developmentFallback": true,
	}
	payload := map[string]any{
		"identity": map[string]any{
			"userId": rc.userID, "email": nil, "mode": "dev-headers", "source": "header",
		},
		"profile":               map[string]any{"name": nil, "email": nil},
		"organizations":         []any{organization},
		"invitations":           []any{},
		"currentOrganizationId": rc.orgID,
		"selectionRequired":     false,
		"needsOrganization":     false,
		"truncated":             false,
		"invitationsTruncated":  false,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}
