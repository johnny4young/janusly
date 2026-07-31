//go:build integration

package httpapi

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The member lifecycle with its guards: invite ladder, role change with
// the self-modification block, and the no-cascade removal.
func TestMemberLifecycle(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()

	// Invite: bad email, undefined role, then success (audited in-tx).
	bad := h.call("POST", "/members/invite", map[string]any{"email": "nope", "role": "viewer"}, "")
	if bad.status != 400 || bad.body["code"] != "email_invalid" {
		t.Fatalf("email ladder: %d %+v", bad.status, bad.body)
	}
	ghostRole := h.call("POST", "/members/invite", map[string]any{"email": "a@x.com", "role": "phantom"}, "")
	if ghostRole.status != 400 || ghostRole.body["code"] != "members_role_not_defined" {
		t.Fatalf("role ladder: %+v", ghostRole.body)
	}
	ok := h.call("POST", "/members/invite", map[string]any{"email": "ada@x.com", "role": "editor"}, "")
	if ok.status != 200 || ok.body["status"] != "pending" {
		t.Fatalf("invite: %+v", ok.body)
	}
	// Re-invite while pending: 409; existing member by email: 409.
	dup := h.call("POST", "/members/invite", map[string]any{"email": "ada@x.com"}, "")
	if dup.status != 409 || dup.body["code"] != "invitation_pending_exists" {
		t.Fatalf("pending 409: %+v", dup.body)
	}
	seedMemberRow(t, pool, h.org, "u-existing", "grace@x.com", "viewer")
	exists := h.call("POST", "/members/invite", map[string]any{"email": "grace@x.com"}, "")
	if exists.status != 409 || exists.body["code"] != "member_exists" {
		t.Fatalf("member 409: %+v", exists.body)
	}

	// Revoke: unknown 404, pending revokes once.
	inviteID, _ := ok.body["id"].(string)
	if res := h.call("POST", "/members/invitations/nope/revoke", nil, ""); res.status != 404 {
		t.Fatalf("revoke 404: %+v", res.body)
	}
	if res := h.call("POST", "/members/invitations/"+inviteID+"/revoke", nil, ""); res.status != 200 {
		t.Fatalf("revoke: %+v", res.body)
	}
	if res := h.call("POST", "/members/invitations/"+inviteID+"/revoke", nil, ""); res.status != 404 {
		t.Fatalf("double revoke must 404: %+v", res.body)
	}

	// Role change: self-block (audited), phantom member 404, success.
	self := h.call("POST", "/members/role", map[string]any{"userId": "api-tester", "role": "viewer"}, "")
	if self.status != 400 || self.body["code"] != "self_membership_modification" {
		t.Fatalf("self guard: %+v", self.body)
	}
	var blocked int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1
		AND action = 'member.self_modification_blocked'`, h.org).Scan(&blocked)
	if blocked != 1 {
		t.Fatalf("blocked attempt must audit: %d", blocked)
	}
	if res := h.call("POST", "/members/role", map[string]any{"userId": "nobody", "role": "editor"}, ""); res.status != 404 {
		t.Fatalf("phantom member: %+v", res.body)
	}
	if res := h.call("POST", "/members/role", map[string]any{"userId": "u-existing", "role": "editor"}, ""); res.status != 200 {
		t.Fatalf("role set: %+v", res.body)
	}

	// Removal: self-block, then no-cascade delete — the row goes, the
	// audit trail stays.
	if res := h.call("DELETE", "/members?userId=api-tester", nil, ""); res.status != 400 {
		t.Fatalf("self removal: %+v", res.body)
	}
	if res := h.call("DELETE", "/members?userId=u-existing", nil, ""); res.status != 200 {
		t.Fatalf("remove: %+v", res.body)
	}
	var memberRows, auditRows int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM org_members WHERE org_id = $1 AND user_id = 'u-existing'`, h.org).Scan(&memberRows)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1`, h.org).Scan(&auditRows)
	if memberRows != 0 || auditRows < 4 {
		t.Fatalf("no-cascade: members=%d audits=%d", memberRows, auditRows)
	}

	// The removed member's next request dies at the resolver (seed them a
	// viewer row first elsewhere is gone — a supabase-mode caller without
	// a row is 401; dev-mode ghost would auto-admin, so assert via list).
	list := h.call("GET", "/members", nil, "")
	members := list.body["members"].([]any)
	for _, raw := range members {
		if raw.(map[string]any)["userId"] == "u-existing" {
			t.Fatal("removed member still listed")
		}
	}
}

func seedMemberRow(t *testing.T, pool *pgxpool.Pool, org, userID, email, role string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO org_members (id, org_id, user_id, email, role)
		 VALUES ($1, $2, $3, $4, $5)`, org+"-"+userID, org, userID, email, role); err != nil {
		t.Fatalf("seed member: %v", err)
	}
}
