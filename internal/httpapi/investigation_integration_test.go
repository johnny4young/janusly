//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// failSavedRun starts the saved version of a workflow whose only step cannot connect.
func failSavedRun(t *testing.T, h *apiHarness, doc map[string]any, versionID string) string {
	t.Helper()
	runID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": doc, "workflowVersionId": versionID}, ""))
	h.waitRun(runID, "failed")
	return runID
}

func investigation(t *testing.T, h *apiHarness, runID, org string) (map[string]any, map[string]map[string]any) {
	t.Helper()
	res := h.call("GET", "/v1/runs/"+runID+"/investigation", nil, org)
	if res.status != http.StatusOK {
		t.Fatalf("investigation: %d %+v", res.status, res.body)
	}
	data := res.body["data"].(map[string]any)
	byID := map[string]map[string]any{}
	for _, raw := range data["hypotheses"].([]any) {
		item := raw.(map[string]any)
		byID[item["id"].(string)] = item
	}
	return data, byID
}

func TestRunInvestigationIsRuleBasedAndTenantScoped(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	h := newAPIHarness(t)
	doc := map[string]any{
		"id": "investigate-" + h.org, "name": "Investigate", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http",
			"config": map[string]any{"url": "http://127.0.0.1:1", "timeoutMs": float64(200)}}},
		"edges": []any{},
	}
	saved := h.call("POST", "/v1/workflows/save", doc, "")
	versionID, _ := saved.body["data"].(map[string]any)["versionId"].(string)
	if versionID == "" {
		t.Fatalf("save: %+v", saved.body)
	}
	failSavedRun(t, h, doc, versionID)
	// Another workflow failing the same way, before this failure, must not count toward this step.
	failRun(t, h, "investigate-other-"+h.org)
	runID := failSavedRun(t, h, doc, versionID)
	deadLetterID := conformanceDeadLetter(t, h, runID)

	data, byID := investigation(t, h, runID, "")
	if data["category"] != "network_timeout" || data["nodeId"] != "call" || data["conclusion"] != "network" {
		t.Fatalf("unexpected investigation: %+v", data)
	}
	want := map[string][2]string{
		"network":    {"validated", "network_failed"},
		"credential": {"ruled_out", "credential_unused"},
		"upstream":   {"inconclusive", "upstream_unwatched"},
		"change":     {"inconclusive", "change_no_baseline"},
	}
	for id, expected := range want {
		if byID[id]["verdict"] != expected[0] || byID[id]["reason"] != expected[1] {
			t.Fatalf("%s = %v/%v, want %v", id, byID[id]["verdict"], byID[id]["reason"], expected)
		}
	}
	network := byID["network"]
	params := network["params"].(map[string]any)
	evidence := network["evidence"].([]any)
	if params["count"] != float64(2) || params["runs"] != float64(2) || len(evidence) != 1 ||
		evidence[0].(map[string]any)["runId"] != runID {
		t.Fatalf("network must count this workflow's step and cite only the failed step: %+v", network)
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
	if viewer, _ := investigation(t, h, runID, ""); viewer["action"] != nil {
		t.Fatalf("a viewer reads the tree without the recovery action: %+v", viewer)
	}
}

func TestRunInvestigationComparesTheSameVersionAndRecentUpstreamReadings(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	h := newAPIHarness(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)
	source := "ingest-" + h.org
	doc := func(name string) map[string]any {
		return map[string]any{
			"id": "investigate-version-" + h.org, "name": name, "dslVersion": "1.0",
			"upstreamHealthSources": []any{source},
			"nodes": []any{map[string]any{"id": "call", "type": "http",
				"config": map[string]any{"url": "{{context.input.url}}", "timeoutMs": float64(500)}}},
			"edges": []any{},
		}
	}
	save := func(name string) string {
		res := h.call("POST", "/v1/workflows/save", doc(name), "")
		id, _ := res.body["data"].(map[string]any)["versionId"].(string)
		if id == "" {
			t.Fatalf("save: %+v", res.body)
		}
		return id
	}
	start := func(name, versionID, url, want string) string {
		runID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{
			"workflow": doc(name), "workflowVersionId": versionID, "input": map[string]any{"url": url},
		}, ""))
		h.waitRun(runID, want)
		return runID
	}
	first := save("First")
	firstSuccess := start("First", first, server.URL, "succeeded")
	second := save("Second")
	start("Second", second, server.URL, "succeeded")
	// The newest success ran version 2; version 1 still worked before, so the change is ruled out.
	failed := start("First", first, "http://127.0.0.1:1", "failed")

	if _, err := testPool(t).Exec(t.Context(), `INSERT INTO upstream_health_sources
		(id, org_id, name, kind, url, check_interval_seconds, enabled, last_status, last_degraded, last_checked_at, last_error_reason)
		VALUES ($1, $2, $3, 'statuspage', 'https://status.example.com', 3600, true, 'major_outage', true, now(), 'poll failed')`,
		"source-"+h.org, h.org, source); err != nil {
		t.Fatalf("seed source: %v", err)
	}
	_, byID := investigation(t, h, failed, "")
	change, upstream := byID["change"], byID["upstream"]
	if change["verdict"] != "ruled_out" || change["reason"] != "change_same_version" ||
		change["evidence"].([]any)[0].(map[string]any)["runId"] != firstSuccess {
		t.Fatalf("change must compare against the same version's success: %+v", change)
	}
	if upstream["verdict"] != "inconclusive" || upstream["reason"] != "upstream_unchecked" {
		t.Fatalf("a failed poll's degraded flag describes nothing: %+v", upstream)
	}

	if _, err := testPool(t).Exec(t.Context(), `UPDATE upstream_health_sources SET last_error_reason = NULL
		WHERE org_id = $1 AND name = $2`, h.org, source); err != nil {
		t.Fatalf("clear poll error: %v", err)
	}
	if _, byID := investigation(t, h, failed, ""); byID["upstream"]["verdict"] != "validated" ||
		byID["upstream"]["reason"] != "upstream_degraded" {
		t.Fatalf("a successful degraded reading at the failure time validates: %+v", byID["upstream"])
	}
	if _, err := testPool(t).Exec(t.Context(), `UPDATE upstream_health_sources SET last_degraded = false
		WHERE org_id = $1 AND name = $2`, h.org, source); err != nil {
		t.Fatalf("heal source: %v", err)
	}
	if _, byID := investigation(t, h, failed, ""); byID["upstream"]["reason"] != "upstream_current_only" {
		t.Fatalf("a healthy latest reading never rules upstream out: %+v", byID["upstream"])
	}
}
