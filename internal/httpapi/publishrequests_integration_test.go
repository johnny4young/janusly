//go:build integration

package httpapi

import (
	"fmt"
	"testing"
	"time"
)

// Publish requests are decided only by a person with workflows.write: the
// route gate refuses viewers and the handler refuses service tokens.
func TestPublishRequestRoutesArePeopleOnly(t *testing.T) {
	t.Setenv("JANUSLY_API_SERVICE_TOKEN", "svc-publish-routes-token")
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	viewer, editor := "viewer-"+suffix, "editor-"+suffix
	for user, role := range map[string]string{viewer: "viewer", editor: "editor"} {
		if _, err := pool.Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`,
			"m-"+user, h.org, user, role); err != nil {
			t.Fatal(err)
		}
	}
	requestID := "pub_" + suffix
	if _, err := pool.Exec(t.Context(), `INSERT INTO publish_requests (id, org_id, workflow_id, draft_id, qualification_id, reasons, requested_by, on_behalf_of, expires_at)
		VALUES ($1, $2, 'wf', 'draft', 'qual', '{writes}', 'agent:x', 'someone', now() + interval '1 day')`, requestID, h.org); err != nil {
		t.Fatal(err)
	}
	if res := h.callWithHeaders("GET", "/publish-requests?status=pending", nil, "", map[string]string{"x-user-id": viewer}); res.status != 200 {
		t.Fatalf("viewer list: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/publish-requests/"+requestID+"/reject", nil, "", map[string]string{"x-user-id": viewer}); res.status != 403 {
		t.Fatalf("viewer decided a publish request: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/publish-requests/"+requestID+"/reject", nil, "", map[string]string{
		"x-user-id": editor, "Authorization": "Bearer svc-publish-routes-token",
	}); res.status != 403 || res.body["code"] != "person_required" {
		t.Fatalf("a service token decided a publish request: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/publish-requests/"+requestID+"/reject", nil, "other-org-"+suffix, map[string]string{"x-user-id": editor}); res.status != 404 && res.status != 403 {
		t.Fatalf("another organization reached the request: %d %v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", "/publish-requests/"+requestID+"/reject", nil, "", map[string]string{"x-user-id": editor}); res.status != 200 {
		t.Fatalf("editor rejection: %d %v", res.status, res.body)
	}
}
