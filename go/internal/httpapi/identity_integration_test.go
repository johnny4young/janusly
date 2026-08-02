//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/browsersession"
	"github.com/johnny4young/janusly/go/internal/store"
)

// T-519: the remaining identity surfaces — membership projection,
// profile upsert, invitation acceptance (verified email + CAS), and the
// honest plugin-install stub.

func TestIdentitySurfaces(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())

	// Memberships: seed one named org membership + assert the projection.
	orgB := "org-b-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, name, plan) VALUES ($1, 'Beta Corp', 'pro')`, orgB); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	member := "member-" + suffix
	if _, err := pool.Exec(ctx,
		`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'editor')`,
		"m-"+suffix, orgB, member); err != nil {
		t.Fatalf("seed membership: %v", err)
	}
	memberships := h.callWithHeaders("GET", "/organizations", nil, h.org,
		map[string]string{"x-user-id": member})
	if memberships.status != 200 {
		t.Fatalf("organizations: %d %+v", memberships.status, memberships.body)
	}
	rows := memberships.body["organizations"].([]any)
	found := false
	for _, raw := range rows {
		row := raw.(map[string]any)
		if row["id"] == orgB && row["name"] == "Beta Corp" && row["plan"] == "pro" && row["role"] == "editor" {
			found = true
		}
	}
	if !found {
		t.Fatalf("membership projection must carry name/plan/role: %+v", rows)
	}

	// Profile: normalization + validation ladder.
	if res := h.call("POST", "/users/me", map[string]any{"name": "x"}, ""); res.status != 400 {
		t.Fatalf("short name must 400: %d", res.status)
	}
	profile := h.call("POST", "/users/me", map[string]any{"name": "  Johnny   IV  "}, "")
	if profile.status != 200 || profile.body["name"] != "Johnny IV" {
		t.Fatalf("profile upsert: %d %+v", profile.status, profile.body)
	}

	// Plugin stub: row + audit.
	installed := h.call("POST", "/plugins/install", map[string]any{
		"pluginId": "slack-notify", "config": map[string]any{"channel": "#ops"},
	}, "")
	if installed.status != 200 || installed.body["id"] == "" {
		t.Fatalf("plugin install: %d %+v", installed.status, installed.body)
	}
	var pluginRows, pluginAudits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM installed_plugins WHERE org_id = $1 AND plugin_id = 'slack-notify'`, h.org).Scan(&pluginRows)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'plugin.installed'`, h.org).Scan(&pluginAudits)
	if pluginRows != 1 || pluginAudits != 1 {
		t.Fatalf("plugin persistence: rows=%d audits=%d", pluginRows, pluginAudits)
	}
	if res := h.call("POST", "/plugins/install", map[string]any{}, ""); res.status != 400 {
		t.Fatalf("missing pluginId must 400: %d", res.status)
	}
}

func TestInvitationAcceptFlow(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "invitation-session-secret")
	t.Setenv("API_ALLOWED_ORIGINS", "http://localhost:5173")
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	invitationID := "inv-" + suffix
	targetOrg := "org-invite-" + suffix

	if _, err := pool.Exec(ctx,
		`INSERT INTO invitations (id, org_id, email, role, status) VALUES ($1, $2, $3, 'editor', 'pending')`,
		invitationID, targetOrg, "alice@example.com"); err != nil {
		t.Fatalf("seed invitation: %v", err)
	}

	// The default harness identity (api-tester) has no email shape → 403.
	if res := h.call("POST", "/auth/invitations/accept", map[string]any{"invitationId": invitationID}, ""); res.status != 403 {
		t.Fatalf("email-less identity must 403: %d %+v", res.status, res.body)
	}
	sessionFor := func(userID, email string) string {
		sessionID := "session-" + userID + "-" + suffix
		if _, err := store.New(pool).CreateAuthSession(ctx, store.CreateAuthSessionParams{
			ID: sessionID, UserID: userID, Email: email, OrgID: h.org,
			ExpiresAt: time.Now().Add(10 * time.Minute),
		}); err != nil {
			t.Fatalf("seed browser session: %v", err)
		}
		token, err := browsersession.CreateToken(sessionID, 600)
		if err != nil {
			t.Fatalf("create browser token: %v", err)
		}
		return browsersession.CookieName + "=" + token.Value
	}
	csrfHeaders := map[string]string{"Origin": "http://localhost:5173", browsersession.CSRFHeader: "1"}
	// A mismatched verified email gets the IDENTICAL not-found envelope.
	if res := callBrowserSession(t, h, "POST", "/auth/invitations/accept",
		sessionFor("mallory-user", "mallory@example.com"),
		map[string]any{"invitationId": invitationID}, csrfHeaders); res.status != 404 {
		t.Fatalf("wrong email must read as not found: %d %+v", res.status, res.body)
	}
	// The invited email accepts: CAS + membership row + audit.
	aliceCookie := sessionFor("Alice@Example.com", "Alice@Example.com")
	accepted := callBrowserSession(t, h, "POST", "/auth/invitations/accept", aliceCookie,
		map[string]any{"invitationId": invitationID}, csrfHeaders)
	if accepted.status != 200 || accepted.body["organizationId"] != targetOrg || accepted.body["role"] != "editor" {
		t.Fatalf("accept: %d %+v", accepted.status, accepted.body)
	}
	var memberRole, invitationStatus string
	_ = pool.QueryRow(ctx, `SELECT role FROM org_members WHERE org_id = $1 AND user_id = 'Alice@Example.com'`, targetOrg).Scan(&memberRole)
	_ = pool.QueryRow(ctx, `SELECT status FROM invitations WHERE id = $1`, invitationID).Scan(&invitationStatus)
	if memberRole != "editor" || invitationStatus != "accepted" {
		t.Fatalf("membership must land with the CAS: role=%q status=%q", memberRole, invitationStatus)
	}
	// A second accept loses the CAS.
	if res := callBrowserSession(t, h, "POST", "/auth/invitations/accept", aliceCookie,
		map[string]any{"invitationId": invitationID}, csrfHeaders); res.status != 409 {
		t.Fatalf("second accept must 409: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/auth/invitations/accept", map[string]any{"invitationId": "ghost"}, ""); res.status != 403 && res.status != 404 {
		t.Fatalf("unknown invitation: %d", res.status)
	}
}
