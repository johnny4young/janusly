//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestRunInvestigationIsRuleBasedAndTenantScoped(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	h := newAPIHarness(t)
	workflowID := "investigate-" + h.org
	earlier := failRun(t, h, workflowID)
	runID := failRun(t, h, workflowID)
	deadLetterID := conformanceDeadLetter(t, h, runID)

	res := h.call("GET", "/v1/runs/"+runID+"/investigation", nil, "")
	if res.status != http.StatusOK {
		t.Fatalf("investigation: %d %+v", res.status, res.body)
	}
	data := res.body["data"].(map[string]any)
	if data["category"] != "network_timeout" || data["nodeId"] != "call" || data["conclusion"] != "network" {
		t.Fatalf("unexpected investigation: %+v", data)
	}
	byID := map[string]map[string]any{}
	for _, raw := range data["hypotheses"].([]any) {
		item := raw.(map[string]any)
		byID[item["id"].(string)] = item
	}
	want := map[string][2]string{
		"network":    {"validated", "network_unreachable"},
		"credential": {"ruled_out", "credential_unused"},
		"upstream":   {"inconclusive", "upstream_unwatched"},
		"change":     {"inconclusive", "change_no_baseline"},
	}
	for id, expected := range want {
		if byID[id]["verdict"] != expected[0] || byID[id]["reason"] != expected[1] {
			t.Fatalf("%s = %v/%v, want %v", id, byID[id]["verdict"], byID[id]["reason"], expected)
		}
	}
	citesEarlier := false
	for _, raw := range byID["network"]["evidence"].([]any) {
		evidence := raw.(map[string]any)
		citesEarlier = citesEarlier || (evidence["kind"] == "similar_failure" && evidence["runId"] == earlier)
	}
	if !citesEarlier {
		t.Fatalf("network evidence must cite the earlier failure %s: %+v", earlier, byID["network"]["evidence"])
	}
	action, _ := data["action"].(map[string]any)
	if action["kind"] != "open_recovery" || action["deadLetterId"] != deadLetterID {
		t.Fatalf("owner must get the gated recovery action: %+v", data["action"])
	}

	if res := h.call("GET", "/v1/runs/"+runID+"/investigation", nil, "other-org-"+h.org); res.status != http.StatusNotFound {
		t.Fatalf("another organization must not see the run: %d %+v", res.status, res.body)
	}

	succeeded := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": makeLinearWorkflow("investigate-ok-" + h.org)}, ""))
	h.waitRun(succeeded, "succeeded")
	if res := h.call("GET", "/v1/runs/"+succeeded+"/investigation", nil, ""); res.status != http.StatusConflict {
		t.Fatalf("a run without a failed step has nothing to investigate: %d %+v", res.status, res.body)
	}

	if _, err := testPool(t).Exec(t.Context(), `INSERT INTO org_members(id, org_id, user_id, role)
		VALUES ($1, $2, 'api-tester', 'viewer') ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'viewer'`,
		fmt.Sprintf("viewer-%d", time.Now().UnixNano()), h.org); err != nil {
		t.Fatalf("viewer: %v", err)
	}
	viewer := h.call("GET", "/v1/runs/"+runID+"/investigation", nil, "")
	if viewer.status != http.StatusOK || viewer.body["data"].(map[string]any)["action"] != nil {
		t.Fatalf("a viewer reads the tree without the recovery action: %d %+v", viewer.status, viewer.body)
	}
}
