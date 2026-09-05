//go:build integration

package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/httpapi/scim"
)

// The full WorkOS Directory Sync lifecycle against fixtures — never a real
// WorkOS: signature ladder (fail-closed), directory attach/409/revoke,
// group sync + group→role mapping CRUD, group-before-create provisioning,
// replay/out-of-order/resurrection guards, the two collision guards with
// their deliberate asymmetry, the domain policy gate, deprovision cleanup,
// membership-driven role recompute, and the bulk re-sync.
func TestScimDirectorySyncLifecycle(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())
	secret := "whsec-" + suffix
	t.Setenv("WORKOS_WEBHOOK_SECRET", secret)

	directoryProviderID := "directory_" + suffix
	base := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	at := func(minutes int) string { return base.Add(time.Duration(minutes) * time.Minute).Format(time.RFC3339) }

	// --- Attach the directory (admin CRUD) -------------------------------
	res := h.call("POST", "/org/scim/directories", map[string]any{
		"providerDirectoryId": directoryProviderID, "defaultRole": "viewer", "directoryType": "okta scim v2.0",
	}, "")
	if res.status != 200 {
		t.Fatalf("attach directory: %d %+v", res.status, res.body)
	}
	directoryID := res.body["directory"].(map[string]any)["id"].(string)
	if res = h.call("POST", "/org/scim/directories", map[string]any{
		"providerDirectoryId": "directory_other_" + suffix,
	}, ""); res.status != 409 {
		t.Fatalf("second directory must 409: %d", res.status)
	}

	// --- Webhook helpers -------------------------------------------------
	post := func(body, header string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", h.server.URL+"/webhooks/workos/directory", bytes.NewReader([]byte(body)))
		req.Header.Set("content-type", "application/json")
		if header != "" {
			req.Header.Set("WorkOS-Signature", header)
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("webhook: %v", err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		var parsed map[string]any
		_ = json.Unmarshal(raw, &parsed)
		return response.StatusCode, parsed
	}
	event := func(eventID, eventType, createdAt string, data map[string]any) string {
		data["directory_id"] = directoryProviderID
		payload, _ := json.Marshal(map[string]any{
			"id": eventID, "event": eventType, "created_at": createdAt, "data": data,
		})
		return string(payload)
	}
	deliver := func(body string) map[string]any {
		status, parsed := post(body, scim.SignWebhookHeader(secret, body, time.Now().UnixMilli()))
		if status != 200 {
			t.Fatalf("delivery must 200: %d %+v (body %s)", status, parsed, body)
		}
		return parsed
	}
	expectReason := func(parsed map[string]any, reason string) {
		t.Helper()
		if parsed["processed"] != false || parsed["reason"] != reason {
			t.Fatalf("expected reason %q: %+v", reason, parsed)
		}
	}
	memberRow := func(email string) (role, invitedBy string, found bool) {
		t.Helper()
		err := pool.QueryRow(ctx,
			`SELECT role, coalesce(invited_by, '') FROM org_members WHERE org_id = $1 AND email = $2`,
			h.org, email).Scan(&role, &invitedBy)
		return role, invitedBy, err == nil
	}

	// --- Signature ladder (fail-closed) ----------------------------------
	probe := event("evt-probe-"+suffix, "dsync.user.created", at(1), map[string]any{"id": "u-x"})
	if status, _ := post(probe, ""); status != 401 {
		t.Fatalf("missing signature must 401: %d", status)
	}
	if status, _ := post(probe, scim.SignWebhookHeader("wrong-secret", probe, time.Now().UnixMilli())); status != 401 {
		t.Fatalf("wrong secret must 401: %d", status)
	}
	stale := time.Now().Add(-10 * time.Minute).UnixMilli()
	if status, _ := post(probe, scim.SignWebhookHeader(secret, probe, stale)); status != 401 {
		t.Fatalf("stale timestamp must 401: %d", status)
	}
	var signatureAudits int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_logs WHERE org_id = 'default' AND action = 'scim.webhook.signature_invalid'`,
	).Scan(&signatureAudits)
	if signatureAudits < 3 {
		t.Fatalf("signature failures must audit against the default tenant: %d", signatureAudits)
	}

	// Valid signature, unknown directory → 200 so WorkOS stops retrying.
	ghost, _ := json.Marshal(map[string]any{
		"id": "evt-ghost-" + suffix, "event": "dsync.user.created", "created_at": at(1),
		"data": map[string]any{"id": "u-ghost", "email": "g@x.com", "directory_id": "directory_ghost"},
	})
	expectReason(deliver(string(ghost)), "unknown_directory")

	// Malformed payload + unknown event type are audited skips, not errors.
	expectReason(deliver(event("evt-noemail-"+suffix, "dsync.user.created", at(1),
		map[string]any{"id": "u-noemail"})), "malformed_payload")
	expectReason(deliver(event("evt-weird-"+suffix, "dsync.something", at(1),
		map[string]any{"id": "u-1"})), "unknown_event")

	// --- Group sync + mapping CRUD --------------------------------------
	groupID := "directory_group_admins_" + suffix
	if parsed := deliver(event("evt-g1-"+suffix, "dsync.group.created", at(2),
		map[string]any{"id": groupID, "name": "Platform Admins"})); parsed["action"] != "group_synced" {
		t.Fatalf("group sync: %+v", parsed)
	}
	res = h.call("GET", "/org/scim/groups", nil, "")
	if res.status != 200 || !strings.Contains(fmt.Sprint(res.body["groups"]), "Platform Admins") {
		t.Fatalf("groups picker: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/org/scim/group-role-mappings", map[string]any{
		"providerGroupId": "directory_group_typo", "role": "admin",
	}, ""); res.status != 404 {
		t.Fatalf("unknown group must 404: %d", res.status)
	}
	res = h.call("POST", "/org/scim/group-role-mappings", map[string]any{
		"providerGroupId": groupID, "role": "admin",
	}, "")
	if res.status != 200 {
		t.Fatalf("create mapping: %d %+v", res.status, res.body)
	}
	mappingID := res.body["mapping"].(map[string]any)["id"].(string)
	if res = h.call("POST", "/org/scim/group-role-mappings", map[string]any{
		"providerGroupId": groupID, "role": "editor",
	}, ""); res.status != 409 {
		t.Fatalf("duplicate mapping must 409: %d", res.status)
	}

	// --- Group event BEFORE the user exists ------------------------------
	userAna := "workos-user-ana-" + suffix
	anaEmail := "ana-" + suffix + "@acme.com"
	if parsed := deliver(event("evt-add1-"+suffix, "dsync.group.user_added", at(3), map[string]any{
		"user_id": userAna, "directory_group_id": groupID,
	})); parsed["action"] != "group_membership_added" {
		t.Fatalf("group-before-create: %+v", parsed)
	}

	// user.created picks the join row up: derived role = admin (mapping),
	// membership owned by the webhook actor.
	if parsed := deliver(event("evt-ana1-"+suffix, "dsync.user.created", at(4), map[string]any{
		"id": userAna, "email": anaEmail, "first_name": "Ana",
	})); parsed["action"] != "provisioned" {
		t.Fatalf("provision: %+v", parsed)
	}
	if role, invitedBy, ok := memberRow(anaEmail); !ok || role != "admin" || invitedBy != "scim:webhook" {
		t.Fatalf("derived membership: ok=%v role=%q invitedBy=%q", ok, role, invitedBy)
	}

	// --- Replay + out-of-order guards ------------------------------------
	expectReason(deliver(event("evt-ana1-"+suffix, "dsync.user.created", at(4), map[string]any{
		"id": userAna, "email": anaEmail,
	})), "event_replayed")
	expectReason(deliver(event("evt-ana-old-"+suffix, "dsync.user.updated", at(3), map[string]any{
		"id": userAna, "email": anaEmail,
	})), "out_of_order")

	// --- Provision collision (human-invited row blocks; stays intact) ----
	bobEmail := "bob-" + suffix + "@acme.com"
	if _, err := pool.Exec(ctx,
		`INSERT INTO org_members (id, org_id, user_id, email, role, invited_by)
		 VALUES ($1, $2, $3, $4, 'admin', 'user:founder')`,
		"member-bob-"+suffix, h.org, "founder-bob-"+suffix, bobEmail); err != nil {
		t.Fatalf("seed human member: %v", err)
	}
	expectReason(deliver(event("evt-bob-"+suffix, "dsync.user.created", at(5), map[string]any{
		"id": "workos-user-bob-" + suffix, "email": bobEmail,
	})), "provision_collision")
	if role, invitedBy, ok := memberRow(bobEmail); !ok || role != "admin" || invitedBy != "user:founder" {
		t.Fatalf("human principal must stay intact: ok=%v role=%q invitedBy=%q", ok, role, invitedBy)
	}

	// --- Domain policy gate ----------------------------------------------
	if res = h.call("POST", "/org/config", map[string]any{
		"key": "auth.allowedEmailDomains", "value": "acme.com",
	}, ""); res.status != 200 {
		t.Fatalf("set domain policy: %d %+v", res.status, res.body)
	}
	expectReason(deliver(event("evt-eve-"+suffix, "dsync.user.created", at(6), map[string]any{
		"id": "workos-user-eve-" + suffix, "email": "eve-" + suffix + "@evil.com",
	})), "domain_not_allowed")

	userCarlos := "workos-user-carlos-" + suffix
	carlosEmail := "carlos-" + suffix + "@acme.com"
	if parsed := deliver(event("evt-carlos1-"+suffix, "dsync.user.created", at(7), map[string]any{
		"id": userCarlos, "email": carlosEmail,
	})); parsed["action"] != "provisioned" {
		t.Fatalf("carlos provision: %+v", parsed)
	}
	if role, _, ok := memberRow(carlosEmail); !ok || role != "viewer" {
		t.Fatalf("no mapped group must fall back to defaultRole: ok=%v role=%q", ok, role)
	}

	// --- Re-key collision asymmetry: ANY row at the new email blocks -----
	expectReason(deliver(event("evt-carlos-rekey1-"+suffix, "dsync.user.updated", at(8), map[string]any{
		"id": userCarlos, "email": anaEmail,
	})), "rekey_collision")
	if _, _, ok := memberRow(carlosEmail); !ok {
		t.Fatalf("blocked re-key must leave the user on their current email")
	}
	carlos2Email := "carlos2-" + suffix + "@acme.com"
	if parsed := deliver(event("evt-carlos-rekey2-"+suffix, "dsync.user.updated", at(9), map[string]any{
		"id": userCarlos, "email": carlos2Email,
	})); parsed["action"] != "updated" {
		t.Fatalf("re-key to a free email: %+v", parsed)
	}
	if _, _, ok := memberRow(carlosEmail); ok {
		t.Fatalf("old email row must be deleted after re-key")
	}
	if _, _, ok := memberRow(carlos2Email); !ok {
		t.Fatalf("new email row must exist after re-key")
	}

	// --- Membership removal lowers the role back to defaultRole ----------
	if parsed := deliver(event("evt-rem1-"+suffix, "dsync.group.user_removed", at(10), map[string]any{
		"user_id": userAna, "directory_group_id": groupID,
	})); parsed["action"] != "group_membership_removed" {
		t.Fatalf("membership removal: %+v", parsed)
	}
	if role, _, _ := memberRow(anaEmail); role != "viewer" {
		t.Fatalf("removal must drop the derived role: %q", role)
	}
	deliver(event("evt-add2-"+suffix, "dsync.group.user_added", at(11), map[string]any{
		"user_id": userAna, "directory_group_id": groupID,
	}))
	if role, _, _ := memberRow(anaEmail); role != "admin" {
		t.Fatalf("re-add must restore the mapped role: %q", role)
	}

	// --- Bulk re-sync applies the CURRENT mappings on demand -------------
	if res = h.call("POST", "/org/scim/group-role-mappings/"+mappingID, map[string]any{"role": "editor"}, ""); res.status != 200 {
		t.Fatalf("update mapping: %d %+v", res.status, res.body)
	}
	if role, _, _ := memberRow(anaEmail); role != "admin" {
		t.Fatalf("mapping change alone must not rewrite roles: %q", role)
	}
	res = h.call("POST", "/org/scim/resync", nil, "")
	if res.status != 200 || res.body["membersChanged"] != float64(1) || res.body["capped"] != false {
		t.Fatalf("resync: %d %+v", res.status, res.body)
	}
	if role, invitedBy, _ := memberRow(anaEmail); role != "editor" || invitedBy != "scim:webhook" {
		t.Fatalf("resync must write the derived role and preserve the inviter: %q %q", role, invitedBy)
	}

	// --- Deprovision + resurrection guard --------------------------------
	expectReason(deliver(event("evt-del-ghost-"+suffix, "dsync.user.deleted", at(12), map[string]any{
		"id": "workos-user-never-" + suffix,
	})), "unknown_user")
	if parsed := deliver(event("evt-del-ana-"+suffix, "dsync.user.deleted", at(13), map[string]any{
		"id": userAna,
	})); parsed["action"] != "deprovisioned" {
		t.Fatalf("deprovision: %+v", parsed)
	}
	if _, _, ok := memberRow(anaEmail); ok {
		t.Fatalf("deprovision must remove the membership")
	}
	var joins int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM scim_user_groups WHERE org_id = $1 AND provider_user_id = $2`,
		h.org, userAna).Scan(&joins)
	if joins != 0 {
		t.Fatalf("deprovision must clear join rows: %d", joins)
	}
	expectReason(deliver(event("evt-ana-res1-"+suffix, "dsync.user.created", at(12), map[string]any{
		"id": userAna, "email": anaEmail,
	})), "resurrection_blocked")
	expectReason(deliver(event("evt-ana-upd-dead-"+suffix, "dsync.user.updated", at(14), map[string]any{
		"id": userAna, "email": anaEmail,
	})), "resurrection_blocked")
	if parsed := deliver(event("evt-ana-res2-"+suffix, "dsync.user.created", at(15), map[string]any{
		"id": userAna, "email": anaEmail,
	})); parsed["action"] != "provisioned" {
		t.Fatalf("genuine re-provision with a newer timestamp: %+v", parsed)
	}
	if role, _, ok := memberRow(anaEmail); !ok || role != "viewer" {
		t.Fatalf("re-provision derives from CURRENT (empty) groups: ok=%v role=%q", ok, role)
	}

	// --- Group delete recomputes members + clears synced state -----------
	deliver(event("evt-add3-"+suffix, "dsync.group.user_added", at(16), map[string]any{
		"user_id": userAna, "directory_group_id": groupID,
	}))
	if role, _, _ := memberRow(anaEmail); role != "editor" {
		t.Fatalf("mapped role before group delete: %q", role)
	}
	if parsed := deliver(event("evt-gdel-"+suffix, "dsync.group.deleted", at(17), map[string]any{
		"id": groupID,
	})); parsed["action"] != "group_deleted" {
		t.Fatalf("group delete: %+v", parsed)
	}
	if role, _, _ := memberRow(anaEmail); role != "viewer" {
		t.Fatalf("group delete must drop roles derived from it: %q", role)
	}

	// --- Revoke is a HARD delete: the webhook door closes and the unique
	// indexes free up so a re-attach can succeed --------------------------
	if res = h.call("DELETE", "/org/scim/directories/"+directoryID, nil, ""); res.status != 200 {
		t.Fatalf("revoke directory: %d %+v", res.status, res.body)
	}
	expectReason(deliver(event("evt-after-revoke-"+suffix, "dsync.user.created", at(18), map[string]any{
		"id": "u-late", "email": "late-" + suffix + "@acme.com",
	})), "unknown_directory")
	res = h.call("POST", "/org/scim/directories", map[string]any{
		"providerDirectoryId": directoryProviderID, "defaultRole": "viewer",
	}, "")
	if res.status != 200 {
		t.Fatalf("re-attach after revoke must succeed: %d %+v", res.status, res.body)
	}
	// The re-attached directory absorbs the SCIM-owned membership left by
	// the old lifecycle (the create-path collision guard's whole point).
	if parsed := deliver(event("evt-ana-reattach-"+suffix, "dsync.user.created", at(19), map[string]any{
		"id": userAna, "email": anaEmail,
	})); parsed["action"] != "provisioned" {
		t.Fatalf("re-attach must absorb the scim-owned row: %+v", parsed)
	}
}
