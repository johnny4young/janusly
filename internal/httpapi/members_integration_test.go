//go:build integration

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
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
	reactivated := h.call("POST", "/members/invite", map[string]any{
		"email": "ada@x.com", "role": "viewer",
	}, "")
	if reactivated.status != 200 || reactivated.body["status"] != "pending" || reactivated.body["id"] == inviteID {
		t.Fatalf("revoked invitation must reactivate with a new id: %d %+v", reactivated.status, reactivated.body)
	}
	var currentInvitationID, currentInvitationRole, currentInvitationStatus string
	if err := pool.QueryRow(ctx, `SELECT id, role, status FROM invitations
		WHERE org_id = $1 AND email = 'ada@x.com'`, h.org).Scan(
		&currentInvitationID, &currentInvitationRole, &currentInvitationStatus,
	); err != nil {
		t.Fatalf("read reactivated invitation: %v", err)
	}
	if currentInvitationID != reactivated.body["id"] || currentInvitationRole != "viewer" || currentInvitationStatus != "pending" {
		t.Fatalf("reactivated invitation mismatch: id=%s role=%s status=%s body=%+v",
			currentInvitationID, currentInvitationRole, currentInvitationStatus, reactivated.body)
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
	// The contract wire is a BARE array (no envelope key) — decode raw.
	req, _ := http.NewRequest("GET", h.server.URL+"/members", nil)
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", "api-tester")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("list members: %v", err)
	}
	defer response.Body.Close()
	var members []map[string]any
	if err := json.NewDecoder(response.Body).Decode(&members); err != nil {
		t.Fatalf("members must be a bare array: %v", err)
	}
	for _, row := range members {
		if row["userId"] == "u-existing" {
			t.Fatal("removed member still listed")
		}
	}
}

func TestConcurrentMemberInvitesHaveOneAtomicWinner(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	type inviteResult struct {
		status int
		body   map[string]any
		err    error
	}
	results := make(chan inviteResult, 2)
	start := make(chan struct{})
	var group sync.WaitGroup
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			raw, _ := json.Marshal(map[string]any{"email": "race@example.com", "role": "editor"})
			req, err := http.NewRequest(http.MethodPost, h.server.URL+"/members/invite", bytes.NewReader(raw))
			if err != nil {
				results <- inviteResult{err: err}
				return
			}
			req.Header.Set("content-type", "application/json")
			req.Header.Set("x-org-id", h.org)
			req.Header.Set("x-user-id", "api-tester")
			response, err := h.server.Client().Do(req)
			if err != nil {
				results <- inviteResult{err: err}
				return
			}
			defer response.Body.Close()
			var body map[string]any
			err = json.NewDecoder(response.Body).Decode(&body)
			results <- inviteResult{status: response.StatusCode, body: body, err: err}
		}()
	}
	close(start)
	group.Wait()
	close(results)

	statuses := map[int]int{}
	for result := range results {
		if result.err != nil {
			t.Fatalf("concurrent invite request: %v", result.err)
		}
		statuses[result.status]++
		if result.status == http.StatusConflict && result.body["code"] != "invitation_pending_exists" {
			t.Fatalf("loser must expose the bounded conflict: %+v", result.body)
		}
	}
	if statuses[http.StatusOK] != 1 || statuses[http.StatusConflict] != 1 {
		t.Fatalf("expected one invite winner and one conflict: %+v", statuses)
	}
	var pendingRows, auditRows int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM invitations
		WHERE org_id = $1 AND email = 'race@example.com' AND status = 'pending'`, h.org).Scan(&pendingRows); err != nil {
		t.Fatalf("count pending invitations: %v", err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'invitation.created'`, h.org).Scan(&auditRows); err != nil {
		t.Fatalf("count invitation audits: %v", err)
	}
	if pendingRows != 1 || auditRows != 1 {
		t.Fatalf("atomic invite winner not preserved: pending=%d audits=%d", pendingRows, auditRows)
	}
}

func TestOrganizationOwnerDelegationProtectionAndTransfer(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	ownerID := "api-tester"
	adminID := "delegated-admin"
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, owner_user_id, name)
		VALUES ($1, $2, 'Owner Test')`, h.org, ownerID); err != nil {
		t.Fatalf("seed owner organization: %v", err)
	}
	for _, member := range []struct{ id, userID, email string }{
		{h.org + "-owner", ownerID, "owner@example.com"},
		{h.org + "-admin", adminID, "admin@example.com"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO org_members (id, org_id, user_id, email, role)
			VALUES ($1, $2, $3, $4, 'admin')`, member.id, h.org, member.userID, member.email); err != nil {
			t.Fatalf("seed member: %v", err)
		}
	}

	// The wire projection tells the UI which row is structurally protected.
	req, _ := http.NewRequest("GET", h.server.URL+"/members", nil)
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", ownerID)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("list members: %v", err)
	}
	defer res.Body.Close()
	var members []map[string]any
	if err := json.NewDecoder(res.Body).Decode(&members); err != nil {
		t.Fatalf("decode members: %v", err)
	}
	ownerProjected := false
	for _, member := range members {
		if member["userId"] == ownerID && member["isOwner"] == true {
			ownerProjected = true
		}
	}
	if !ownerProjected {
		t.Fatalf("owner flag missing from member projection: %+v", members)
	}

	adminHeaders := map[string]string{"x-user-id": adminID}
	if blocked := h.callWithHeaders("POST", "/members/role", map[string]any{
		"userId": ownerID, "role": "viewer",
	}, h.org, adminHeaders); blocked.status != http.StatusConflict || blocked.body["code"] != "organization_owner_protected" {
		t.Fatalf("delegated admin demoted owner: %d %+v", blocked.status, blocked.body)
	}
	if blocked := h.callWithHeaders("DELETE", "/members?userId="+ownerID, nil, h.org, adminHeaders); blocked.status != http.StatusConflict || blocked.body["code"] != "organization_owner_protected" {
		t.Fatalf("delegated admin removed owner: %d %+v", blocked.status, blocked.body)
	}
	if blocked := h.callWithHeaders("POST", "/organizations/owner", map[string]any{
		"userId": adminID,
	}, h.org, adminHeaders); blocked.status != http.StatusForbidden || blocked.body["code"] != "organization_owner_required" {
		t.Fatalf("non-owner transferred ownership: %d %+v", blocked.status, blocked.body)
	}

	transferred := h.call("POST", "/organizations/owner", map[string]any{"userId": adminID}, h.org)
	if transferred.status != 200 || transferred.body["ownerUserId"] != adminID {
		t.Fatalf("owner transfer: %d %+v", transferred.status, transferred.body)
	}
	var ownerUserID, oldRole, newRole string
	if err := pool.QueryRow(ctx, `SELECT owner_user_id FROM organizations WHERE id = $1`, h.org).Scan(&ownerUserID); err != nil {
		t.Fatalf("read transferred owner: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`, h.org, ownerID).Scan(&oldRole); err != nil {
		t.Fatalf("read previous owner role: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`, h.org, adminID).Scan(&newRole); err != nil {
		t.Fatalf("read new owner role: %v", err)
	}
	if ownerUserID != adminID || oldRole != "admin" || newRole != "admin" {
		t.Fatalf("transfer invariant: owner=%q oldRole=%q newRole=%q", ownerUserID, oldRole, newRole)
	}

	// The former owner remains an admin but cannot demote the new owner.
	if blocked := h.call("POST", "/members/role", map[string]any{
		"userId": adminID, "role": "viewer",
	}, h.org); blocked.status != http.StatusConflict || blocked.body["code"] != "organization_owner_protected" {
		t.Fatalf("former owner demoted new owner: %d %+v", blocked.status, blocked.body)
	}
	if changed := h.callWithHeaders("POST", "/members/role", map[string]any{
		"userId": ownerID, "role": "viewer",
	}, h.org, adminHeaders); changed.status != 200 {
		t.Fatalf("new owner could not manage previous owner: %d %+v", changed.status, changed.body)
	}

	// Defense in depth: bypassing HTTP and writing the membership directly is
	// still refused by the database trigger used by SSO/SCIM paths too.
	if _, err := pool.Exec(ctx, `UPDATE org_members SET role = 'viewer'
		WHERE org_id = $1 AND user_id = $2`, h.org, adminID); err == nil {
		t.Fatal("database allowed direct owner demotion")
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
