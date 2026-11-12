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

	"github.com/johnny4young/janusly/internal/store"
)

func workflowStatus(t *testing.T, org, workflowID string) (string, bool) {
	t.Helper()
	var status string
	var deleted bool
	if err := testPool(t).QueryRow(context.Background(),
		`SELECT status, deleted_at IS NOT NULL FROM workflows WHERE org_id = $1 AND id = $2`, org, workflowID,
	).Scan(&status, &deleted); err != nil {
		t.Fatalf("read workflow %s: %v", workflowID, err)
	}
	return status, deleted
}

func auditActions(t *testing.T, org, workflowID string) []string {
	t.Helper()
	rows, err := testPool(t).Query(context.Background(),
		`SELECT action FROM audit_logs WHERE org_id = $1 AND target_id = $2 ORDER BY created_at, id`, org, workflowID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var actions []string
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			t.Fatal(err)
		}
		actions = append(actions, action)
	}
	return actions
}

// A pause stops new runs and holds trigger events; resume starts the held
// events. Neither moves the workflow to the trash.
func TestWorkflowPauseHoldsEventsAndResumeStartsThem(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	workflowID := fmt.Sprintf("pause-hook-%d", time.Now().UnixNano())
	if res := h.call("POST", "/v1/workflows/save", webhookWorkflow(workflowID, "pause-hook"), ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}

	paused := h.call("POST", "/v1/workflows/"+workflowID+"/pause", map[string]any{"reason": "vendor maintenance"}, "")
	data, _ := paused.body["data"].(map[string]any)
	if paused.status != 200 || data["status"] != "paused_manual" || data["changed"] != true {
		t.Fatalf("pause: %d %+v", paused.status, paused.body)
	}
	if status, deleted := workflowStatus(t, h.org, workflowID); status != "paused_manual" || deleted {
		t.Fatalf("after pause: status=%s deleted=%v", status, deleted)
	}
	again := h.call("POST", "/workflows/"+workflowID+"/pause", nil, "")
	if again.status != 200 || again.body["changed"] != false {
		t.Fatalf("second pause must change nothing: %d %+v", again.status, again.body)
	}

	start := h.call("POST", "/v1/start", map[string]any{"workflow": webhookWorkflow(workflowID, "pause-hook")}, "")
	if start.status != http.StatusConflict || start.body["error"] == nil {
		t.Fatalf("start while paused: %d %+v", start.status, start.body)
	}
	if code := start.body["error"].(map[string]any)["code"]; code != "workflow_paused" {
		t.Fatalf("start while paused: code %v", code)
	}
	event := map[string]any{"endpointKey": "pause-hook", "eventId": "evt-paused", "payload": map[string]any{"total": 7}}
	if res := h.call("POST", "/v1/webhooks/"+workflowID, event, ""); res.status != http.StatusAccepted {
		t.Fatalf("event while paused: %d %+v", res.status, res.body)
	}

	resumed := h.call("POST", "/v1/workflows/"+workflowID+"/resume", nil, "")
	data, _ = resumed.body["data"].(map[string]any)
	if resumed.status != 200 || data["status"] != "active" || data["backfilled"] != float64(1) {
		t.Fatalf("resume: %d %+v", resumed.status, resumed.body)
	}
	if status, deleted := workflowStatus(t, h.org, workflowID); status != "active" || deleted {
		t.Fatalf("after resume: status=%s deleted=%v", status, deleted)
	}
	actions := auditActions(t, h.org, workflowID)
	want := map[string]int{"workflow.paused": 1, "workflow.resumed": 1, "workflow.deleted": 0, "workflow.restored": 0}
	got := map[string]int{}
	for _, action := range actions {
		got[action]++
	}
	for action, count := range want {
		if got[action] != count {
			t.Fatalf("audit %s = %d, want %d (all: %v)", action, got[action], count, actions)
		}
	}
}

// A pause never cancels a rollout or removes schedule entries.
func TestWorkflowPauseKeepsRolloutAndSchedules(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	workflowID := fmt.Sprintf("pause-rollout-%d", time.Now().UnixNano())
	withSchedule := func(verdict string) map[string]any {
		doc := rolloutWorkflowDoc(workflowID, verdict)
		doc["nodes"] = append(doc["nodes"].([]any), map[string]any{
			"id": "tick", "type": "schedule", "config": map[string]any{"cronExpression": "0 9 * * *"},
		})
		doc["edges"] = append(doc["edges"].([]any), map[string]any{"from": "tick", "to": "shape"})
		return doc
	}
	baseline := h.call("POST", "/v1/workflows/save", withSchedule("one"), "")
	canary := h.call("POST", "/v1/workflows/save", withSchedule("two"), "")
	if baseline.status != 200 || canary.status != 200 {
		t.Fatalf("save: %d %d %+v", baseline.status, canary.status, canary.body)
	}
	baselineID := baseline.body["data"].(map[string]any)["versionId"]
	canaryID := canary.body["data"].(map[string]any)["versionId"]
	if res := h.call("POST", "/v1/workflows/"+workflowID+"/rollout/qualification", map[string]any{
		"baselineVersionId": baselineID, "candidateVersionId": canaryID,
	}, ""); res.status != 200 {
		t.Fatalf("qualify: %d %+v", res.status, res.body)
	}
	created := h.call("POST", "/v1/workflows/"+workflowID+"/rollout", map[string]any{
		"baselineVersionId": baselineID, "canaryVersionId": canaryID,
		"trafficPercent": 10, "minimumSampleSize": 5, "minimumSuccessRatePercent": 90,
	}, "")
	if created.status != 200 {
		t.Fatalf("rollout: %d %+v", created.status, created.body)
	}
	rolloutID := created.body["data"].(map[string]any)["rollout"].(map[string]any)["id"].(string)
	pool := testPool(t)
	state := func() (string, int, int) {
		t.Helper()
		var rollout string
		var entries, enabled int
		if err := pool.QueryRow(context.Background(), `SELECT status FROM workflow_rollouts WHERE id = $1`, rolloutID).Scan(&rollout); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(context.Background(),
			`SELECT count(*), count(*) FILTER (WHERE enabled) FROM schedule_entries WHERE org_id = $1 AND workflow_id = $2`,
			h.org, workflowID).Scan(&entries, &enabled); err != nil {
			t.Fatal(err)
		}
		return rollout, entries, enabled
	}
	_, entriesBefore, enabledBefore := state()
	if entriesBefore == 0 {
		t.Fatal("fixture has no schedule entry")
	}
	for _, step := range []string{"pause", "resume"} {
		if res := h.call("POST", "/v1/workflows/"+workflowID+"/"+step, map[string]any{}, ""); res.status != 200 {
			t.Fatalf("%s: %d %+v", step, res.status, res.body)
		}
		rollout, entries, enabled := state()
		if rollout != "active" || entries != entriesBefore || enabled != enabledBefore {
			t.Fatalf("after %s: rollout=%s entries=%d/%d enabled=%d/%d", step, rollout, entries, entriesBefore, enabled, enabledBefore)
		}
	}
}

// A manual pause outlasts automatic resumes, and an upstream pause is not
// resumed by hand. Another organization's workflow answers like a missing one.
func TestWorkflowPausePrecedenceAndTenancy(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	workflowID := fmt.Sprintf("pause-precedence-%d", time.Now().UnixNano())
	if res := h.call("POST", "/v1/workflows/save", webhookWorkflow(workflowID, "pause-precedence"), ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}
	setStatus := func(status string) {
		t.Helper()
		if _, err := pool.Exec(context.Background(), `UPDATE workflows SET status = $3 WHERE org_id = $1 AND id = $2`,
			h.org, workflowID, status); err != nil {
			t.Fatal(err)
		}
	}

	setStatus("paused_upstream_degraded")
	if res := h.call("POST", "/v1/workflows/"+workflowID+"/resume", nil, ""); res.status != http.StatusConflict {
		t.Fatalf("hand resume of an upstream pause: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/v1/workflows/"+workflowID+"/pause", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("pause over upstream: %d %+v", res.status, res.body)
	}
	if _, err := store.New(pool).ResumeWorkflowsForUpstream(context.Background(), store.ResumeWorkflowsForUpstreamParams{
		OrgID: h.org, Column2: []string{workflowID},
	}); err != nil {
		t.Fatal(err)
	}
	if status, _ := workflowStatus(t, h.org, workflowID); status != "paused_manual" {
		t.Fatalf("upstream recovery lifted a manual pause: %s", status)
	}

	setStatus("paused_circuit_breaker")
	if res := h.call("POST", "/v1/workflows/"+workflowID+"/resume", nil, ""); res.status != 200 {
		t.Fatalf("breaker resume: %d %+v", res.status, res.body)
	}
	if status, _ := workflowStatus(t, h.org, workflowID); status != "active" {
		t.Fatalf("after breaker resume: %s", status)
	}

	foreignOrg := "pause-foreign-" + workflowID
	foreignID := "foreign-" + workflowID
	if res := h.call("POST", "/v1/workflows/save", webhookWorkflow(foreignID, "pause-foreign"), foreignOrg); res.status != 200 {
		t.Fatalf("foreign save: %d %+v", res.status, res.body)
	}
	for _, step := range []string{"pause", "resume"} {
		foreign := h.call("POST", "/v1/workflows/"+foreignID+"/"+step, map[string]any{}, "")
		missing := h.call("POST", "/v1/workflows/missing-"+workflowID+"/"+step, map[string]any{}, "")
		if foreign.status != http.StatusNotFound || missing.status != http.StatusNotFound {
			t.Fatalf("%s: foreign %d, missing %d", step, foreign.status, missing.status)
		}
	}
	if status, _ := workflowStatus(t, foreignOrg, foreignID); status != "active" {
		t.Fatalf("a foreign pause changed the workflow: %s", status)
	}
}

// Resuming a manual pause while a subscribed upstream is degraded hands the
// workflow to the upstream pause instead of starting it.
func TestWorkflowResumeHandsOverToADegradedUpstream(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := context.Background()
	workflowID := fmt.Sprintf("pause-upstream-%d", time.Now().UnixNano())
	source := "vendor-" + workflowID
	if _, err := pool.Exec(ctx, `INSERT INTO upstream_health_sources (id, org_id, name, kind, url, last_status, last_degraded)
		VALUES ($1, $2, $3, 'statuspage', 'https://status.example.test', 'major_outage', true)`, source, h.org, source); err != nil {
		t.Fatal(err)
	}
	doc := webhookWorkflow(workflowID, "pause-upstream")
	doc["upstreamHealthSources"] = []any{source}
	if res := h.call("POST", "/v1/workflows/save", doc, ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/v1/workflows/"+workflowID+"/pause", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("pause: %d %+v", res.status, res.body)
	}
	resumed := h.call("POST", "/v1/workflows/"+workflowID+"/resume", nil, "")
	if resumed.status != http.StatusConflict || resumed.body["error"].(map[string]any)["code"] != "upstream_degraded" {
		t.Fatalf("resume over a degraded upstream: %d %+v", resumed.status, resumed.body)
	}
	if status, _ := workflowStatus(t, h.org, workflowID); status != "paused_upstream_degraded" {
		t.Fatalf("after hand-over: %s", status)
	}
	if _, err := store.New(pool).ResumeWorkflowsForUpstream(ctx, store.ResumeWorkflowsForUpstreamParams{
		OrgID: h.org, Column2: []string{workflowID},
	}); err != nil {
		t.Fatal(err)
	}
	if status, _ := workflowStatus(t, h.org, workflowID); status != "active" {
		t.Fatalf("upstream recovery must resume it: %s", status)
	}
}

// Draft tests keep the start gates, and an overlong reason is refused rather
// than cut.
func TestPausedWorkflowRefusesDraftTestsAndBoundsTheReason(t *testing.T) {
	h := newAPIHarness(t)
	workflowID := fmt.Sprintf("pause-draft-%d", time.Now().UnixNano())
	doc := map[string]any{"id": workflowID, "name": "Draft while paused", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}}, "edges": []any{}}
	if res := h.call("POST", "/v1/workflows/save", doc, ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}
	long := h.call("POST", "/v1/workflows/"+workflowID+"/pause", map[string]any{"reason": strings.Repeat("x", 501)}, "")
	if long.status != http.StatusBadRequest {
		t.Fatalf("overlong reason: %d %+v", long.status, long.body)
	}
	if res := h.call("POST", "/v1/workflows/"+workflowID+"/pause", map[string]any{"reason": "line one\nline two"}, ""); res.status != 200 {
		t.Fatalf("pause: %d %+v", res.status, res.body)
	}
	var reason string
	if err := testPool(t).QueryRow(context.Background(), `SELECT paused_reason FROM workflows WHERE org_id = $1 AND id = $2`,
		h.org, workflowID).Scan(&reason); err != nil || reason != "line one line two" {
		t.Fatalf("stored reason %q: %v", reason, err)
	}
	if res := h.call("POST", "/runs/draft-test", map[string]any{"workflow": doc}, ""); res.status != http.StatusConflict || res.body["code"] != "workflow_paused" {
		t.Fatalf("draft test while paused: %d %+v", res.status, res.body)
	}
}

// A production subworkflow call refuses a paused child, and the parent's step
// fails instead of starting it.
func TestSubworkflowCallRefusesAPausedChild(t *testing.T) {
	h := newAPIHarness(t)
	ctx := context.Background()
	q := store.New(testPool(t))
	childID := fmt.Sprintf("pause-child-%d", time.Now().UnixNano())
	if err := q.InsertWorkflow(ctx, store.InsertWorkflowParams{ID: childID, OrgID: h.org, Name: childID}); err != nil {
		t.Fatal(err)
	}
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: childID + "-v1", OrgID: h.org, WorkflowID: childID, Version: 1,
		DagJson: json.RawMessage(`{"id":"` + childID + `","name":"child","dslVersion":"1.0","nodes":[{"id":"n","type":"noop","config":{}}],"edges":[]}`),
	}); err != nil {
		t.Fatal(err)
	}
	if res := h.call("POST", "/v1/workflows/"+childID+"/pause", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("pause child: %d %+v", res.status, res.body)
	}
	runID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": map[string]any{
		"id": "parent-" + childID, "name": "parent", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "subworkflow", "config": map[string]any{"workflowId": childID}}},
		"edges": []any{},
	}}, ""))
	h.waitRun(runID, "failed")
	var children int
	if err := testPool(t).QueryRow(ctx, `SELECT count(*) FROM runs WHERE parent_run_id = $1`, runID).Scan(&children); err != nil || children != 0 {
		t.Fatalf("a paused child started %d runs: %v", children, err)
	}
}

// A replay campaign waits while its dead letters' workflow is paused and
// finishes after the workflow resumes.
func TestReplayCampaignWaitsForAPausedWorkflow(t *testing.T) {
	h := newAPIHarness(t)
	workflowID := "pause-campaign-" + h.org
	doc := map[string]any{"id": workflowID, "name": "Campaign Flow", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http",
			"config": map[string]any{"url": "http://127.0.0.1:1", "timeoutMs": float64(200)}}},
		"edges": []any{}}
	if res := h.call("POST", "/v1/workflows/save", doc, ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}
	for range 2 {
		h.waitRun(extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": doc}, "")), "failed")
	}
	ids := deadLetterIDs(t, h)
	if res := h.call("POST", "/v1/workflows/"+workflowID+"/pause", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("pause: %d %+v", res.status, res.body)
	}
	created := h.call("POST", "/recovery/campaigns", map[string]any{"deadLetterIds": ids, "name": "held", "pacingMs": float64(1000)}, "")
	if created.status != 202 {
		t.Fatalf("create: %d %+v", created.status, created.body)
	}
	campaignID := created.body["campaign"].(map[string]any)["id"].(string)
	counters := func() map[string]any {
		return h.call("GET", "/recovery/campaigns/"+campaignID, nil, "").body["campaign"].(map[string]any)
	}
	time.Sleep(3 * time.Second)
	if held := counters(); held["replayedCount"] != float64(0) || held["failedCount"] != float64(0) || held["status"] != "running" {
		t.Fatalf("a paused workflow's campaign moved: %+v", held)
	}
	if res := h.call("POST", "/v1/workflows/"+workflowID+"/resume", nil, ""); res.status != 200 {
		t.Fatalf("resume: %d %+v", res.status, res.body)
	}
	deadline := time.Now().Add(20 * time.Second)
	for counters()["status"] != "completed" {
		if time.Now().After(deadline) {
			t.Fatalf("campaign never finished after resume: %+v", counters())
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// A circuit-breaker pause waits for someone to look at the failures, so a
// service token cannot lift it; a person can.
func TestCircuitBreakerPauseLiftsOnlyForAPerson(t *testing.T) {
	t.Setenv("JANUSLY_API_SERVICE_TOKEN", "svc-breaker-resume-token")
	h := newAPIHarnessWithoutWorkers(t)
	workflowID := fmt.Sprintf("breaker-hook-%d", time.Now().UnixNano())
	if res := h.call("POST", "/v1/workflows/save", webhookWorkflow(workflowID, "breaker-hook"), ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}
	if _, err := testPool(t).Exec(t.Context(), `UPDATE workflows SET status = 'paused_circuit_breaker' WHERE org_id = $1 AND id = $2`,
		h.org, workflowID); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool(t).Exec(t.Context(), `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, 'automation', 'editor')`,
		"m-automation-"+workflowID, h.org); err != nil {
		t.Fatal(err)
	}
	service := map[string]string{"Authorization": "Bearer svc-breaker-resume-token", "x-user-id": "automation"}
	refused := h.callWithHeaders("POST", "/v1/workflows/"+workflowID+"/resume", nil, "", service)
	if refused.status != http.StatusForbidden || !strings.Contains(fmt.Sprint(refused.body), "workflow_circuit_breaker_resume_requires_person") {
		t.Fatalf("a service token lifted a circuit-breaker pause: %d %+v", refused.status, refused.body)
	}
	if status, _ := workflowStatus(t, h.org, workflowID); status != "paused_circuit_breaker" {
		t.Fatalf("after the refused resume: %s", status)
	}
	// A manual pause keeps the breaker pause, so pausing first does not open a way around it.
	paused := h.callWithHeaders("POST", "/v1/workflows/"+workflowID+"/pause", map[string]any{}, "", service)
	if data, _ := paused.body["data"].(map[string]any); paused.status != http.StatusOK || data["status"] != "paused_circuit_breaker" || data["changed"] != false {
		t.Fatalf("pause over a breaker pause: %d %+v", paused.status, paused.body)
	}
	if res := h.callWithHeaders("POST", "/v1/workflows/"+workflowID+"/resume", nil, "", service); res.status != http.StatusForbidden {
		t.Fatalf("a service token lifted a breaker pause after pausing it: %d %+v", res.status, res.body)
	}
	if res := h.call("POST", "/v1/workflows/"+workflowID+"/resume", nil, ""); res.status != http.StatusOK {
		t.Fatalf("a person's resume: %d %+v", res.status, res.body)
	}
	if status, _ := workflowStatus(t, h.org, workflowID); status != "active" {
		t.Fatalf("after a person's resume: %s", status)
	}
}
