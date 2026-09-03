//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/browsersession"
	"github.com/johnny4young/janusly/internal/store"
)

func TestIdentitySurfaces(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())

	// Memberships: seed one named org membership + assert the projection.
	orgB := "org-b-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, owner_user_id, name, plan) VALUES ($1, $2, 'Beta Corp', 'pro')`, orgB, "seed-owner-"+suffix); err != nil {
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
		if row["id"] == orgB && row["name"] == "Beta Corp" && row["plan"] == "pro" && row["role"] == "editor" && row["isOwner"] == false {
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

func TestOrganizationBootstrapCommitsFounderProfileAndAudit(t *testing.T) {
	founderID := fmt.Sprintf("founder-%d", time.Now().UnixNano())
	founderEmail := founderID + "@example.com"
	fakeSupabase := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/auth/v1/user" || r.Header.Get("Authorization") != "Bearer founder-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"id":%q,"email":%q}`, founderID, founderEmail)
	}))
	defer fakeSupabase.Close()
	t.Setenv("SUPABASE_URL", fakeSupabase.URL)
	t.Setenv("SUPABASE_SERVICE_ROLE_KEY", "supabase-test-key")
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	headers := map[string]string{"Authorization": "Bearer founder-token"}

	if res := h.callWithHeaders("POST", "/organizations", map[string]any{"name": "x"}, h.org, headers); res.status != 400 || res.body["code"] != "organization_name_invalid" {
		t.Fatalf("short organization name: %d %+v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/organizations", map[string]any{
		"name": "Bootstrap Org", "profileName": 42,
	}, h.org, headers); res.status != 400 || res.body["code"] != "profile_name_invalid" {
		t.Fatalf("invalid profile name: %d %+v", res.status, res.body)
	}

	created := h.callWithHeaders("POST", "/organizations", map[string]any{
		"name": "  Bootstrap   Org  ", "profileName": "  Ada   Founder  ",
	}, h.org, headers)
	if created.status != 201 {
		t.Fatalf("create organization: %d %+v", created.status, created.body)
	}
	orgID, _ := created.body["currentOrganizationId"].(string)
	if !strings.HasPrefix(orgID, "org_") || created.body["needsOrganization"] != false {
		t.Fatalf("created session context: %+v", created.body)
	}
	organizations, _ := created.body["organizations"].([]any)
	if len(organizations) != 1 {
		t.Fatalf("founder should receive one real organization: %+v", organizations)
	}
	organization := organizations[0].(map[string]any)
	if organization["id"] != orgID || organization["name"] != "Bootstrap Org" ||
		organization["plan"] != "free" || organization["role"] != "admin" ||
		organization["developmentFallback"] != false || organization["isOwner"] != true {
		t.Fatalf("organization projection: %+v", organization)
	}

	var orgName, plan, ownerUserID, role, memberEmail, profileName, profileEmail string
	if err := pool.QueryRow(ctx, `SELECT name, plan, owner_user_id FROM organizations WHERE id = $1`, orgID).Scan(&orgName, &plan, &ownerUserID); err != nil {
		t.Fatalf("organization row: %v", err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT role, email FROM org_members WHERE org_id = $1 AND user_id = $2`, orgID, founderID,
	).Scan(&role, &memberEmail); err != nil {
		t.Fatalf("founder grant: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT name, email FROM users WHERE id = $1`, founderID).Scan(&profileName, &profileEmail); err != nil {
		t.Fatalf("founder profile: %v", err)
	}
	if orgName != "Bootstrap Org" || plan != "free" || ownerUserID != founderID || role != "admin" || memberEmail != founderEmail ||
		profileName != "Ada Founder" || profileEmail != founderEmail {
		t.Fatalf("bootstrap rows: org=%q plan=%q owner=%q role=%q memberEmail=%q profile=%q/%q",
			orgName, plan, ownerUserID, role, memberEmail, profileName, profileEmail)
	}
	var auditCount int
	var targetType, targetID string
	if err := pool.QueryRow(ctx, `SELECT count(*), min(target_type), min(target_id)
		FROM audit_logs WHERE org_id = $1 AND user_id = $2 AND action = 'org.created'`, orgID, founderID,
	).Scan(&auditCount, &targetType, &targetID); err != nil {
		t.Fatalf("org audit: %v", err)
	}
	if auditCount != 1 || targetType != "organization" || targetID != orgID {
		t.Fatalf("org audit mismatch: count=%d target=%s/%s", auditCount, targetType, targetID)
	}

	// Omitting the optional profile name on another bootstrap must not erase
	// the global name already stored by the first organization.
	second := h.callWithHeaders("POST", "/organizations", map[string]any{"name": "Second Org"}, h.org, headers)
	if second.status != 201 {
		t.Fatalf("second organization: %d %+v", second.status, second.body)
	}
	if err := pool.QueryRow(ctx, `SELECT name FROM users WHERE id = $1`, founderID).Scan(&profileName); err != nil || profileName != "Ada Founder" {
		t.Fatalf("omitted profile must preserve name: name=%q err=%v", profileName, err)
	}
}

func TestOrganizationBootstrapRollsBackProfileOnOrganizationFailure(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	collision := "collision-" + suffix
	orgID := "org_" + collision
	userID := "rollback-" + suffix + "@example.com"
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, owner_user_id, name) VALUES ($1, 'existing-owner', 'Existing')`, orgID); err != nil {
		t.Fatalf("seed collision: %v", err)
	}
	server := &V1Server{pool: pool, newID: func() string { return collision }}
	identity := &auth.Identity{
		UserID: userID, Email: userID, Mode: auth.ModeSupabase, Source: auth.SourceWeb,
	}
	req := httptest.NewRequest("POST", "/organizations", strings.NewReader(`{"name":"Should Roll Back","profileName":"Transient Name"}`))
	result := server.organizationCreateCore(req, identityRequest{userID: userID, identity: identity})
	if result.status != 500 || result.code != "organization_create_failed" {
		t.Fatalf("collision failure: status=%d code=%q", result.status, result.code)
	}
	var profiles, members, audits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id = $1`, userID).Scan(&profiles)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM org_members WHERE org_id = $1 AND user_id = $2`, orgID, userID).Scan(&members)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND user_id = $2 AND action = 'org.created'`, orgID, userID).Scan(&audits)
	if profiles != 0 || members != 0 || audits != 0 {
		t.Fatalf("failed bootstrap must roll back every new row: profile=%d member=%d audit=%d", profiles, members, audits)
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
	// The invited email accepts: one atomic state transition and the full
	// bootstrap context, not the runtime's old accepted/organizationId summary.
	aliceCookie := sessionFor("Alice@Example.com", "Alice@Example.com")
	accepted := callBrowserSession(t, h, "POST", "/auth/invitations/accept", aliceCookie,
		map[string]any{"invitationId": invitationID}, csrfHeaders)
	if accepted.status != 200 || accepted.body["currentOrganizationId"] != targetOrg || accepted.body["needsOrganization"] != false {
		t.Fatalf("accept: %d %+v", accepted.status, accepted.body)
	}
	var memberRole, memberEmail, invitationStatus, profileEmail string
	_ = pool.QueryRow(ctx, `SELECT role, email FROM org_members WHERE org_id = $1 AND user_id = 'Alice@Example.com'`, targetOrg).Scan(&memberRole, &memberEmail)
	_ = pool.QueryRow(ctx, `SELECT status FROM invitations WHERE id = $1`, invitationID).Scan(&invitationStatus)
	_ = pool.QueryRow(ctx, `SELECT email FROM users WHERE id = 'Alice@Example.com'`).Scan(&profileEmail)
	if memberRole != "editor" || memberEmail != "alice@example.com" || invitationStatus != "accepted" || profileEmail != "alice@example.com" {
		t.Fatalf("accept rows: role=%q memberEmail=%q status=%q profileEmail=%q", memberRole, memberEmail, invitationStatus, profileEmail)
	}
	var joinedAudits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND user_id = 'Alice@Example.com' AND action = 'member.joined'`, targetOrg).Scan(&joinedAudits)
	if joinedAudits != 1 {
		t.Fatalf("accept must audit exactly once: %d", joinedAudits)
	}
	// Every unavailable state uses the exact Node bootstrap envelope.
	if res := callBrowserSession(t, h, "POST", "/auth/invitations/accept", aliceCookie,
		map[string]any{"invitationId": invitationID}, csrfHeaders); res.status != 404 ||
		res.body["code"] != "identity_invitation_not_found" {
		t.Fatalf("second accept must be unavailable: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/auth/invitations/accept", map[string]any{"invitationId": "ghost"}, ""); res.status != 403 && res.status != 404 {
		t.Fatalf("unknown invitation: %d", res.status)
	}
}

func TestInvitationAcceptanceIsSingleWinnerUnderConcurrency(t *testing.T) {
	t.Setenv("JANUSLY_RESUME_TOKEN_SECRET", "invitation-race-secret")
	t.Setenv("API_ALLOWED_ORIGINS", "http://localhost:5173")
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	invitationID := "inv-race-" + suffix
	targetOrg := "org-invite-race-" + suffix
	userID := "race-user-" + suffix
	email := "race-" + suffix + "@example.com"
	if _, err := pool.Exec(ctx,
		`INSERT INTO invitations (id, org_id, email, role, status, invited_by)
		 VALUES ($1, $2, $3, 'viewer', 'pending', 'admin-user')`, invitationID, targetOrg, email); err != nil {
		t.Fatalf("seed invitation: %v", err)
	}
	sessionID := "session-race-" + suffix
	if _, err := store.New(pool).CreateAuthSession(ctx, store.CreateAuthSessionParams{
		ID: sessionID, UserID: userID, Email: email, OrgID: h.org,
		ExpiresAt: time.Now().Add(10 * time.Minute),
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	token, err := browsersession.CreateToken(sessionID, 600)
	if err != nil {
		t.Fatalf("browser token: %v", err)
	}
	cookie := browsersession.CookieName + "=" + token.Value
	headers := map[string]string{"Origin": "http://localhost:5173", browsersession.CSRFHeader: "1"}

	const contenders = 8
	statuses := make(chan int, contenders)
	codes := make(chan any, contenders)
	var wg sync.WaitGroup
	for range contenders {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := callBrowserSession(t, h, "POST", "/auth/invitations/accept", cookie,
				map[string]any{"invitationId": invitationID}, headers)
			statuses <- res.status
			codes <- res.body["code"]
		}()
	}
	wg.Wait()
	close(statuses)
	close(codes)
	successes, unavailable := 0, 0
	for status := range statuses {
		switch status {
		case 200:
			successes++
		case 404:
			unavailable++
		default:
			t.Fatalf("unexpected concurrent status: %d", status)
		}
	}
	for code := range codes {
		if code != nil && code != "identity_invitation_not_found" {
			t.Fatalf("unexpected concurrent error code: %v", code)
		}
	}
	if successes != 1 || unavailable != contenders-1 {
		t.Fatalf("single-winner CAS: success=%d unavailable=%d", successes, unavailable)
	}
	var accepted, members, audits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM invitations WHERE id = $1 AND status = 'accepted'`, invitationID).Scan(&accepted)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM org_members WHERE org_id = $1 AND user_id = $2`, targetOrg, userID).Scan(&members)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND user_id = $2 AND action = 'member.joined'`, targetOrg, userID).Scan(&audits)
	if accepted != 1 || members != 1 || audits != 1 {
		t.Fatalf("atomic winner rows: invitation=%d member=%d audit=%d", accepted, members, audits)
	}
}
