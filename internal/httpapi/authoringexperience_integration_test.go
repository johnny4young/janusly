//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/authoring"
	"github.com/johnny4young/janusly/internal/engine"
)

func authoringExperienceHarness(t *testing.T) *apiHarness {
	t.Helper()
	options := defaultV1ServerOptionsForTest()
	options.AuthoringExperienceEnabled = true
	options.Logger = quietTestLogger()
	return newAPIHarnessWithOptions(t, false, options)
}

func authoringExperienceSource(t *testing.T, h *apiHarness) map[string]any {
	t.Helper()
	workflowID := "experience-" + h.org
	source := map[string]any{"dslVersion": "1.0", "id": workflowID, "name": "Local report", "nodes": []any{map[string]any{"id": "done", "type": "noop", "config": map[string]any{}}}, "edges": []any{}}
	saved := h.call("POST", "/v1/workflows/save", source, "")
	if saved.status != http.StatusOK {
		t.Fatalf("save: %d %+v", saved.status, saved.body)
	}
	data := saved.body["data"].(map[string]any)
	brief := authoring.IntentBrief{Version: "1", Objective: "PRIVATE_BRIEF_LOCAL_REPORT", Trigger: "manual", Inputs: []string{}, ExpectedOutcome: "PRIVATE_EXPECTED_REPORT", ExternalEffects: []string{}, Approvals: []string{}, FailurePolicy: "stop_and_open_recovery_case", Examples: []string{}, Language: "en"}
	return map[string]any{"workflowId": workflowID, "versionId": data["versionId"], "brief": brief}
}

func authoringExperienceGrant(t *testing.T, h *apiHarness) {
	t.Helper()
	pool := testPool(t)
	for key, value := range map[string]string{"memory.enabled": "true", "ai.authoringExperienceEnabled": "true", "memory.allowedKinds": `"workflow_vector"`} {
		if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs(id,org_id,key,value_json,updated_by,category,description,value_type) VALUES ($1,$2,$3,$4::jsonb,'api-tester',split_part($3,'.',1),'Experience consent fixture',CASE WHEN $3='memory.allowedKinds' THEN 'string' ELSE 'boolean' END) ON CONFLICT(org_id,key) DO UPDATE SET value_json=excluded.value_json`, h.org+":"+key, h.org, key, value); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAuthoringExperienceStrictAPIPrivacyAndConsent(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := authoringExperienceHarness(t)
	request := authoringExperienceSource(t, h)
	pool := testPool(t)
	if res := h.call("POST", "/v1/authoring/experiences/register", request, ""); res.status != http.StatusForbidden {
		t.Fatalf("missing consent: %d %+v", res.status, res.body)
	}
	authoringExperienceGrant(t, h)
	registered := h.call("POST", "/v1/authoring/experiences/register", request, "")
	if registered.status != http.StatusOK {
		t.Fatalf("register: %d %+v", registered.status, registered.body)
	}
	requireEnvelope(t, registered)
	entry := registered.body["data"].(map[string]any)
	id := entry["id"].(string)
	requireManifestDataFor(t, "POST", "/v1/authoring/experiences/register", entry)
	requireUnknownWireKeyRejected(t, "POST", "/v1/authoring/experiences/register", entry)
	if entry["versionId"] != request["versionId"] || entry["outcomeEvidence"] != "unknown" {
		t.Fatalf("false source/outcome: %+v", entry)
	}
	listed := h.call("GET", "/v1/authoring/experiences?workflowId="+request["workflowId"].(string), nil, "")
	if listed.status != http.StatusOK {
		t.Fatalf("list: %d %+v", listed.status, listed.body)
	}
	requireManifestDataFor(t, "GET", "/v1/authoring/experiences", listed.body["data"])
	raw, _ := json.Marshal(listed.body)
	for _, forbidden := range []string{"PRIVATE_BRIEF", "PRIVATE_EXPECTED", "briefKey", "briefJson", "nodes", "edges", "createdBy"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("list leaked %s: %s", forbidden, raw)
		}
	}
	for _, path := range []string{"/v1/authoring/experiences", "/v1/authoring/experiences?workflowId=x&orgId=" + h.org, "/v1/authoring/experiences?workflowId=x&workflowId=y", "/v1/authoring/experiences?workflowId=%zz"} {
		if res := h.call("GET", path, nil, ""); res.status != http.StatusBadRequest {
			t.Fatalf("strict query %s: %d %+v", path, res.status, res.body)
		}
	}
	for _, body := range []any{map[string]any{"workflowId": request["workflowId"], "versionId": request["versionId"], "brief": request["brief"], "orgId": h.org}, map[string]any{"workflowId": request["workflowId"], "versionId": nil, "brief": request["brief"]}, map[string]any{"workflowId": request["workflowId"], "versionId": request["versionId"], "brief": nil}, []any{}, map[string]any{"workflowId": request["workflowId"], "versionId": request["versionId"], "brief": map[string]any{"version": "1", "unexpected": "secret"}}} {
		if res := h.call("POST", "/v1/authoring/experiences/register", body, ""); res.status != http.StatusBadRequest {
			t.Fatalf("strict body accepted: %d %+v", res.status, res.body)
		}
	}
	var metadata string
	if err := pool.QueryRow(t.Context(), `SELECT metadata::text FROM audit_logs WHERE org_id=$1 AND action='authoring.experience.registered' ORDER BY created_at DESC LIMIT 1`, h.org).Scan(&metadata); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"PRIVATE_", "brief", "hash", "workflowId", "versionId", "nodes"} {
		if strings.Contains(metadata, forbidden) {
			t.Fatalf("audit leaked %s: %s", forbidden, metadata)
		}
	}
	if _, err := pool.Exec(t.Context(), `UPDATE org_configs SET value_json='false' WHERE org_id=$1 AND key='ai.authoringExperienceEnabled'`, h.org); err != nil {
		t.Fatal(err)
	}
	if res := h.call("GET", "/v1/authoring/experiences?workflowId="+request["workflowId"].(string), nil, ""); res.status != http.StatusForbidden {
		t.Fatalf("revocation fence: %d %+v", res.status, res.body)
	}
	revoked := h.call("POST", "/v1/authoring/experiences/revoke", map[string]any{"id": id}, "")
	if revoked.status != http.StatusOK {
		t.Fatalf("withdrawal after disable: %d %+v", revoked.status, revoked.body)
	}
	requireManifestDataFor(t, "POST", "/v1/authoring/experiences/revoke", revoked.body["data"])
	authoringExperienceGrant(t, h)
	listed = h.call("GET", "/v1/authoring/experiences?workflowId="+request["workflowId"].(string), nil, "")
	if entries := listed.body["data"].(map[string]any)["entries"].([]any); len(entries) != 0 {
		t.Fatalf("regrant resurrected: %+v", entries)
	}
}

func TestAuthoringExperienceProcessGateAndTenantPermissionFences(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	t.Setenv("ANTHROPIC_API_KEY", "")
	disabled := newAPIHarnessWithoutWorkers(t)
	request := authoringExperienceSource(t, disabled)
	authoringExperienceGrant(t, disabled)
	if res := disabled.call("POST", "/v1/authoring/experiences/register", request, ""); res.status != http.StatusForbidden {
		t.Fatalf("default-off: %d %+v", res.status, res.body)
	}
	h := authoringExperienceHarness(t)
	request = authoringExperienceSource(t, h)
	authoringExperienceGrant(t, h)
	registered := h.call("POST", "/v1/authoring/experiences/register", request, "")
	if registered.status != http.StatusOK {
		t.Fatalf("register: %d %+v", registered.status, registered.body)
	}
	id := registered.body["data"].(map[string]any)["id"].(string)
	other := authoringExperienceHarness(t)
	otherRequest := authoringExperienceSource(t, other)
	authoringExperienceGrant(t, other)
	foreign := map[string]any{"workflowId": request["workflowId"], "versionId": request["versionId"], "brief": otherRequest["brief"]}
	if res := other.call("POST", "/v1/authoring/experiences/register", foreign, ""); res.status != http.StatusNotFound {
		t.Fatalf("tenant source bypass: %d %+v", res.status, res.body)
	}
	if res := other.call("POST", "/v1/authoring/experiences/revoke", map[string]any{"id": id}, ""); res.status != http.StatusOK || res.body["data"].(map[string]any)["revoked"] != false {
		t.Fatalf("tenant revoke bypass: %d %+v", res.status, res.body)
	}
	pool := testPool(t)
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,'api-tester','viewer') ON CONFLICT(org_id,user_id) DO UPDATE SET role='viewer'`, fmt.Sprintf("viewer-%d", time.Now().UnixNano()), h.org); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/authoring/experiences/register", "/v1/authoring/experiences/revoke"} {
		if res := h.call("POST", path, map[string]any{"id": id}, ""); res.status != http.StatusForbidden {
			t.Fatalf("viewer write: %d %+v", res.status, res.body)
		}
	}
	t.Setenv("JANUSLY_MEMORY_ENABLED", "false")
	if res := other.call("POST", "/v1/authoring/experiences/register", otherRequest, ""); res.status != http.StatusForbidden {
		t.Fatalf("process memory off: %d %+v", res.status, res.body)
	}
}

func TestAuthoringExperienceUsesExistingMemoryConsentPurge(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	t.Setenv("JANUSLY_MEMORY_PURGE_DELAY_HOURS", "0")
	h := authoringExperienceHarness(t)
	request := authoringExperienceSource(t, h)
	authoringExperienceGrant(t, h)
	res := h.call("POST", "/v1/authoring/experiences/register", request, "")
	if res.status != http.StatusOK {
		t.Fatalf("register: %d %+v", res.status, res.body)
	}
	pool := testPool(t)
	if _, err := pool.Exec(t.Context(), `UPDATE org_configs SET value_json='false' WHERE org_id=$1 AND key='memory.enabled'`, h.org); err != nil {
		t.Fatal(err)
	}
	if count, err := engine.New(pool).SweepMemoryConsentPurges(t.Context()); err != nil || count < 1 {
		t.Fatalf("existing sweep did not purge registry-only org: %d %v", count, err)
	}
	var remaining int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM authoring_experiences WHERE org_id=$1`, h.org).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("withdrawn registrations not deleted: %d %v", remaining, err)
	}
}

func TestAuthoringExperienceRequiresAllExistingPermissions(t *testing.T) {
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	h := authoringExperienceHarness(t)
	request := authoringExperienceSource(t, h)
	authoringExperienceGrant(t, h)
	pool := testPool(t)
	for i, permissions := range [][]string{{"workflows.read", "workflows.write"}, {"ai.write", "workflows.write"}, {"ai.write", "workflows.read"}} {
		role := fmt.Sprintf("experience-limited-%d", i)
		raw, _ := json.Marshal(permissions)
		if _, err := pool.Exec(t.Context(), `INSERT INTO org_roles(id,org_id,name,inherits_from,granted_permissions) VALUES($1,$2,$3,'editor',$4::jsonb)`, h.org+role, h.org, role, raw); err != nil {
			t.Fatal(err)
		}
		user := fmt.Sprintf("experience-operator-%d", i)
		seedMemberRow(t, pool, h.org, user, user+"@example.test", role)
		res := h.callWithHeaders("POST", "/v1/authoring/experiences/register", request, "", map[string]string{"x-user-id": user})
		if res.status != http.StatusForbidden {
			t.Fatalf("missing permission %v granted registration: %d %+v", permissions, res.status, res.body)
		}
	}
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM authoring_experiences WHERE org_id=$1`, h.org).Scan(&count); err != nil || count != 0 {
		t.Fatalf("denied request changed registry: %d %v", count, err)
	}
}
