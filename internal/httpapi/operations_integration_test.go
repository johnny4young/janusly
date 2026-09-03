//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestOperatorBriefIsBoundedPermissionAwareAndTenantScoped(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	adminID := "brief-admin-" + suffix
	viewerID := "brief-viewer-" + suffix
	customID := "brief-custom-" + suffix
	otherOrg := h.org + "-other"

	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id, owner_user_id, name)
		VALUES ($1,$2,'Operator Brief'),($3,$2,'Other Brief')`, h.org, adminID, otherOrg); err != nil {
		t.Fatalf("seed organizations: %v", err)
	}
	readOnly, _ := json.Marshal([]string{"recovery.read"})
	if _, err := pool.Exec(ctx, `INSERT INTO org_roles
		(id,org_id,name,inherits_from,description,is_builtin,granted_permissions)
		VALUES ($1,$2,'brief-observer','viewer','Brief without mutation',false,$3)`,
		h.org+"-brief-observer", h.org, readOnly); err != nil {
		t.Fatalf("seed custom role: %v", err)
	}
	for _, member := range []struct{ id, role string }{
		{adminID, "admin"}, {viewerID, "viewer"}, {customID, "brief-observer"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO org_members (id,org_id,user_id,email,role)
			VALUES ($1,$2,$3,$4,$5)`, h.org+"-"+member.id, h.org, member.id,
			member.id+"@brief.local", member.role); err != nil {
			t.Fatalf("seed member %s: %v", member.id, err)
		}
	}

	now := time.Now().UTC()
	seedCase := func(orgID, id, state, action string, at time.Time) {
		t.Helper()
		if _, err := pool.Exec(ctx, `INSERT INTO recovery_cases
			(id,org_id,run_id,workflow_id,workflow_version_id,source,detector_id,
			 source_node_id,detector_kind,action,message,details_json,state,created_by,created_at,updated_at)
			VALUES ($1,$2,$3,$4,$5,'semantic_violation','detector-'||$1,'node','jsonpath',$6,
			 'bounded incident','{}',$7,$8,$9,$9)`,
			id, orgID, "run-"+id, "workflow-"+id, "version-"+id,
			action, state, adminID, at); err != nil {
			t.Fatalf("seed case %s: %v", id, err)
		}
	}
	seedCase(h.org, "approval-old-"+suffix, "awaiting_approval", "quarantine", now.Add(-3*time.Hour))
	seedCase(h.org, "approval-new-"+suffix, "awaiting_approval", "continue", now.Add(-2*time.Hour))
	seedCase(h.org, "semantic-critical-"+suffix, "contained", "quarantine", now.Add(-time.Hour))
	seedCase(h.org, "semantic-fourth-"+suffix, "diagnosed", "continue", now)
	seedCase(otherOrg, "tenant-secret-"+suffix, "awaiting_approval", "quarantine", now.Add(-24*time.Hour))
	if _, err := pool.Exec(ctx, `INSERT INTO recovery_cases
		(id,org_id,run_id,workflow_version_id,source,detector_id,source_node_id,
		 detector_kind,action,message,state,revision,created_at,updated_at)
		VALUES ($1,$2,$3,'generic-version','contract','generic-detector','node','expression',
		 'quarantine','generic recovery must not become a semantic recommendation',
		 'awaiting_approval',3,$4,$4)`, "generic-oldest-"+suffix, h.org,
		"generic-run-"+suffix, now.Add(-12*time.Hour)); err != nil {
		t.Fatalf("seed generic recovery case: %v", err)
	}

	callAs := func(userID string) apiResponse {
		t.Helper()
		return h.callWithHeaders("GET", "/v1/operations/brief", nil, h.org,
			map[string]string{"x-user-id": userID})
	}
	admin := callAs(adminID)
	if admin.status != http.StatusOK {
		t.Fatalf("admin brief: %d %+v", admin.status, admin.body)
	}
	data := admin.body["data"].(map[string]any)
	actions := data["actions"].([]any)
	if len(actions) != 3 {
		t.Fatalf("brief must be bounded to three actions: %+v", data)
	}
	serialized := fmt.Sprint(actions)
	if strings.Contains(serialized, "tenant-secret") || strings.Contains(serialized, "semantic-fourth") {
		t.Fatalf("brief leaked another tenant or exceeded top three: %s", serialized)
	}
	wantIDs := []string{"recovery-case:approval-old-" + suffix, "recovery-case:approval-new-" + suffix, "recovery-case:semantic-critical-" + suffix}
	for index, want := range wantIDs {
		action := actions[index].(map[string]any)
		if action["id"] != want || action["priority"] != float64(index+1) {
			t.Fatalf("rank %d = %+v, want %s", index, action, want)
		}
	}
	if !strings.Contains(fmt.Sprint(actions[0].(map[string]any)["allowedActions"]), "recovery.cases.apply") {
		t.Fatalf("admin write authority missing: %+v", actions[0])
	}

	for _, userID := range []string{viewerID, customID} {
		res := callAs(userID)
		if res.status != http.StatusOK {
			t.Fatalf("read-only brief %s: %d %+v", userID, res.status, res.body)
		}
		readActions := res.body["data"].(map[string]any)["actions"].([]any)
		for _, raw := range readActions {
			allowed := raw.(map[string]any)["allowedActions"].([]any)
			if len(allowed) != 1 || allowed[0] != "recovery.cases.inspect" {
				t.Fatalf("read-only role received mutation hint: %+v", raw)
			}
		}
	}
}

func TestOperatorBriefDoesNotCrossReadPermissionBoundaries(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	adminID := "brief-scope-admin-" + suffix
	recoveryOnlyID := "brief-scope-recovery-" + suffix
	runsOnlyID := "brief-scope-runs-" + suffix

	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id,owner_user_id,name) VALUES ($1,$2,'Brief scope')`, h.org, adminID); err != nil {
		t.Fatal(err)
	}
	permissions, _ := json.Marshal([]string{"recovery.read"})
	runsPermissions, _ := json.Marshal([]string{"runs.read"})
	if _, err := pool.Exec(ctx, `INSERT INTO org_roles
		(id,org_id,name,inherits_from,description,is_builtin,granted_permissions)
		VALUES ($1,$2,'recovery-only','viewer','Recovery cases only',false,$3),
		       ($4,$2,'runs-only','viewer','Run approvals only',false,$5)`,
		h.org+"-recovery-only", h.org, permissions,
		h.org+"-runs-only", runsPermissions); err != nil {
		t.Fatal(err)
	}
	for _, member := range []struct{ id, role string }{
		{adminID, "admin"}, {recoveryOnlyID, "recovery-only"}, {runsOnlyID, "runs-only"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO org_members (id,org_id,user_id,email,role)
			VALUES ($1,$2,$3,$4,$5)`, h.org+"-"+member.id, h.org, member.id, member.id+"@brief.local", member.role); err != nil {
			t.Fatal(err)
		}
	}
	caseID := "scope-case-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO recovery_cases
		(id,org_id,run_id,workflow_version_id,source,detector_id,source_node_id,detector_kind,action,message,state,revision)
		VALUES ($1,$2,$3,'scope-version','semantic_violation','detector','source','expression','quarantine','case','contained',1)`,
		caseID, h.org, "scope-case-run-"+suffix); err != nil {
		t.Fatal(err)
	}
	runID := "scope-approval-run-" + suffix
	input := json.RawMessage(`{"workflow":{"id":"scope-workflow","nodes":[{"id":"gate","type":"approval","config":{}}],"edges":[]}}`)
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id,org_id,workflow_version_id,status,input_json,created_at)
		VALUES ($1,$2,'scope-version','waiting',$3,now()-interval '2 hours')`, runID, h.org, input); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO run_nodes (id,run_id,node_id,status,started_at)
		VALUES ($1,$2,'gate','waiting',now()-interval '2 hours')`, runID+":gate", runID); err != nil {
		t.Fatal(err)
	}

	callAs := func(userID string) []any {
		t.Helper()
		response := h.callWithHeaders("GET", "/v1/operations/brief", nil, h.org, map[string]string{"x-user-id": userID})
		if response.status != http.StatusOK {
			t.Fatalf("brief %s: %d %+v", userID, response.status, response.body)
		}
		return response.body["data"].(map[string]any)["actions"].([]any)
	}
	adminActions := callAs(adminID)
	if len(adminActions) < 1 || adminActions[0].(map[string]any)["kind"] != "run_approval" {
		t.Fatalf("admin should see higher-ranked run approval: %+v", adminActions)
	}
	recoveryActions := callAs(recoveryOnlyID)
	if len(recoveryActions) != 1 || recoveryActions[0].(map[string]any)["kind"] != "semantic_case" {
		t.Fatalf("recovery-only role crossed into run evidence: %+v", recoveryActions)
	}
	runsActions := callAs(runsOnlyID)
	if len(runsActions) != 1 || runsActions[0].(map[string]any)["kind"] != "run_approval" {
		t.Fatalf("runs-only role could not reach its bounded brief projection: %+v", runsActions)
	}
}

func TestOperatorBriefRanksActionableRecoveryBeforeBoundingHistory(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	adminID := "brief-history-admin-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO organizations (id,owner_user_id,name)
		VALUES ($1,$2,'Brief history bound')`, h.org, adminID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO org_members (id,org_id,user_id,email,role)
		VALUES ($1,$2,$3,$4,'admin')`, h.org+"-"+adminID, h.org, adminID, adminID+"@brief.local"); err != nil {
		t.Fatal(err)
	}

	approvalID := "old-actionable-approval-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO recovery_cases
		(id,org_id,run_id,workflow_version_id,source,detector_id,source_node_id,
		 detector_kind,action,message,state,revision,created_at,updated_at)
		VALUES ($1,$2,$3,'brief-version','semantic_violation','old-detector','source','expression',
		 'quarantine','approval must remain visible','awaiting_approval',3,
		 now()-interval '7 days',now()-interval '7 days')`,
		approvalID, h.org, "old-approval-run-"+suffix); err != nil {
		t.Fatal(err)
	}
	// These rows are newer but terminal and therefore cannot outrank or hide
	// the pending approval. The former newest-first LIMIT 200 did hide it.
	if _, err := pool.Exec(ctx, `INSERT INTO recovery_cases
		(id,org_id,run_id,workflow_version_id,source,detector_id,source_node_id,
		 detector_kind,action,message,state,revision,created_at,updated_at,resolved_at)
		SELECT 'terminal-'||$2||'-'||n, $1, 'terminal-run-'||$2||'-'||n,
			 'brief-version','semantic_violation','detector-'||n,'source','expression','continue',
		 'closed history','verified_recovered',4,now()-n*interval '1 second',
		 now()-n*interval '1 second',now()-n*interval '1 second'
		FROM generate_series(1,250) AS n`, h.org, suffix); err != nil {
		t.Fatal(err)
	}

	response := h.callWithHeaders("GET", "/v1/operations/brief", nil, h.org,
		map[string]string{"x-user-id": adminID})
	if response.status != http.StatusOK {
		t.Fatalf("operator brief: %d %+v", response.status, response.body)
	}
	actions := response.body["data"].(map[string]any)["actions"].([]any)
	if len(actions) != 1 || actions[0].(map[string]any)["id"] != "recovery-case:"+approvalID {
		t.Fatalf("terminal history hid the actionable approval: %+v", actions)
	}
}
