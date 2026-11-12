//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The approve route refuses the person whose agent prepared the fix and
// accepts another member.
func TestRecoveryApproveRouteRefusesTheAgentsCreator(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	recovery := v2ContractDoc("calc")
	contract := recovery["contract"].(map[string]any)
	contract["autonomyLevel"] = 3
	contract["failure"].(map[string]any)["semantic"].(map[string]any)["detectors"].([]any)[0].(map[string]any)["action"] = "quarantine"
	runID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{
		"workflow": qualificationWorkflowDoc("self-approval-"+suffix, recovery), "input": map[string]any{"total": "900"},
	}, ""))
	h.waitRun(runID, "waiting")
	var caseID string
	if err := pool.QueryRow(t.Context(), `SELECT id FROM recovery_cases WHERE org_id = $1 AND run_id = $2`, h.org, runID).Scan(&caseID); err != nil {
		t.Fatal(err)
	}
	path := "/v1/recovery/cases/" + caseID
	revision := func(data map[string]any) any { return data["case"].(map[string]any)["revision"] }
	diagnosed := h.call("POST", path+"/diagnose", map[string]any{"expectedRevision": 1}, "")
	candidates := h.call("POST", path+"/candidates", map[string]any{
		"expectedRevision":  revision(diagnosed.body["data"].(map[string]any)),
		"manualReplacement": map[string]any{"output": map[string]any{"total": "10"}, "reason": "restore the contract total"},
	}, "").body["data"].(map[string]any)
	var candidateID string
	for _, raw := range candidates["candidates"].([]any) {
		if artifact := raw.(map[string]any); artifact["payload"].(map[string]any)["kind"] == "replace_output" {
			candidateID = artifact["id"].(string)
		}
	}
	validated := h.call("POST", path+"/validate", map[string]any{
		"expectedRevision": revision(candidates), "candidateArtifactId": candidateID,
	}, "").body["data"].(map[string]any)
	validationID := validated["validation"].(map[string]any)["id"].(string)

	// The agent client "api-tester" created prepared the candidate and its validation.
	clientID := "agc-" + suffix
	if _, err := pool.Exec(t.Context(), `INSERT INTO agent_clients
		(id, org_id, name, capabilities, scope_workflow_ids, scope_tags, token_digest, token_last4, rate_limit_per_minute, created_by, token_issued_at, expires_at)
		VALUES ($1, $2, 'agent', '{read,operate}', '{}', '{}', sha256(convert_to($1, 'UTF8')), 'abcd', 120, 'api-tester', now(), now() + interval '1 day')`,
		clientID, h.org); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE recovery_case_artifacts SET actor_kind = 'agent', actor_id = $3
		WHERE org_id = $1 AND id = ANY($2::text[])`, h.org, []string{candidateID, validationID}, "agent:"+clientID); err != nil {
		t.Fatal(err)
	}
	binding := map[string]any{"expectedRevision": revision(validated), "candidateArtifactId": candidateID, "validationArtifactId": validationID}
	if res := h.call("POST", path+"/approve", binding, ""); res.status != http.StatusForbidden || !strings.Contains(fmt.Sprint(res.body), "recovery_self_approval") {
		t.Fatalf("the agent's creator approved its fix: %d %+v", res.status, res.body)
	}
	if res := h.callWithHeaders("POST", path+"/approve", binding, "", map[string]string{"x-user-id": "peer-" + suffix}); res.status != http.StatusOK {
		t.Fatalf("another member could not approve: %d %+v", res.status, res.body)
	}
}
