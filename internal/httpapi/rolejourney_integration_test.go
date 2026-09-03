//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// The clean organization role journey exercises actual persisted workflows and
// terminal runs—not just button visibility—for owner, delegated admin, editor,
// a custom editor-ranked operator, and viewer. Each denial crosses the real
// centralized rank+permission middleware.
func TestCleanOrganizationRoleJourneys(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	actors := map[string]string{
		"owner":    "journey-owner-" + suffix,
		"admin":    "journey-admin-" + suffix,
		"editor":   "journey-editor-" + suffix,
		"operator": "journey-operator-" + suffix,
		"viewer":   "journey-viewer-" + suffix,
	}
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, owner_user_id, name)
		VALUES ($1, $2, 'Clean Role Journey')`, h.org, actors["owner"]); err != nil {
		t.Fatalf("seed organization: %v", err)
	}
	grants, _ := json.Marshal([]string{"workflows.read", "workflows.write", "runs.read", "runs.start"})
	if _, err := pool.Exec(ctx, `INSERT INTO org_roles
		(id, org_id, name, inherits_from, description, is_builtin, granted_permissions)
		VALUES ($1, $2, 'flow-operator', 'editor', 'Can build and run flows', false, $3)`,
		h.org+"-flow-operator", h.org, grants); err != nil {
		t.Fatalf("seed custom role: %v", err)
	}
	roles := map[string]string{
		"owner": "admin", "admin": "admin", "editor": "editor",
		"operator": "flow-operator", "viewer": "viewer",
	}
	for name, userID := range actors {
		if _, err := pool.Exec(ctx, `INSERT INTO org_members
			(id, org_id, user_id, email, role) VALUES ($1, $2, $3, $4, $5)`,
			h.org+"-"+name, h.org, userID, name+"@journey.local", roles[name]); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
	}

	callAs := func(actor, method, path string, body any) apiResponse {
		t.Helper()
		return h.callWithHeaders(method, path, body, h.org, map[string]string{"x-user-id": actors[actor]})
	}
	saveAndRun := func(actor string) {
		t.Helper()
		workflow := makeLinearWorkflow("wf-" + actor + "-" + suffix)
		if saved := callAs(actor, "POST", "/v1/workflows/save", workflow); saved.status != http.StatusOK {
			t.Fatalf("%s could not persist workflow: %d %+v", actor, saved.status, saved.body)
		}
		started := callAs(actor, "POST", "/v1/start", map[string]any{"workflow": workflow})
		if started.status != http.StatusOK {
			t.Fatalf("%s could not start workflow: %d %+v", actor, started.status, started.body)
		}
		runID := started.body["data"].(map[string]any)["runId"].(string)
		h.waitRun(runID, "succeeded")
	}

	// Delegated admin, ordinary editor, and an explicitly permissioned custom
	// role all perform the product's core save→run journey successfully.
	saveAndRun("admin")
	saveAndRun("editor")
	saveAndRun("operator")

	// Admin can delegate; editor and viewer cannot cross the team boundary.
	if invited := callAs("admin", "POST", "/members/invite", map[string]any{
		"email": "new-editor-" + suffix + "@journey.local", "role": "editor",
	}); invited.status != http.StatusOK {
		t.Fatalf("delegated admin could not invite: %d %+v", invited.status, invited.body)
	}
	for _, actor := range []string{"editor", "operator", "viewer"} {
		if denied := callAs(actor, "POST", "/members/invite", map[string]any{
			"email": actor + "-forbidden-" + suffix + "@journey.local", "role": "viewer",
		}); denied.status != http.StatusForbidden {
			t.Fatalf("%s crossed member boundary: %d %+v", actor, denied.status, denied.body)
		}
	}

	// Viewer reads the shared project but cannot mutate or execute it.
	if read := callAs("viewer", "GET", "/v1/workflows", nil); read.status != http.StatusOK {
		t.Fatalf("viewer could not read workflows: %d %+v", read.status, read.body)
	}
	viewerWorkflow := makeLinearWorkflow("wf-viewer-forbidden-" + suffix)
	for _, attempt := range []struct {
		path string
		body any
	}{
		{"/v1/workflows/save", viewerWorkflow},
		{"/v1/start", map[string]any{"workflow": viewerWorkflow}},
	} {
		if denied := callAs("viewer", "POST", attempt.path, attempt.body); denied.status != http.StatusForbidden {
			t.Fatalf("viewer mutated %s: %d %+v", attempt.path, denied.status, denied.body)
		}
	}
}
