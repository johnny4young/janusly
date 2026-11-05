//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type rerunTarget struct {
	*httptest.Server
	writes, reads atomic.Int32
}

// A GET to /broken fails; every POST and any other GET succeeds and is counted.
func newRerunTarget(t *testing.T) *rerunTarget {
	t.Helper()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	target := &rerunTarget{}
	target.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/broken" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Method == http.MethodPost {
			target.writes.Add(1)
		} else {
			target.reads.Add(1)
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(target.Close)
	return target
}

func rerunWorkflow(id, url string) map[string]any {
	retry := map[string]any{"maxAttempts": 1}
	return map[string]any{
		"id": id, "name": "Rerun", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "shape", "type": "transform", "config": map[string]any{"mapping": map[string]any{"v": "{{context.input.tag}}"}}},
			map[string]any{"id": "charge", "type": "http", "config": map[string]any{"url": url + "/charge", "method": "POST", "retry": retry}},
			map[string]any{"id": "fetch", "type": "http", "config": map[string]any{"url": url + "/broken", "method": "GET", "retry": retry}},
			map[string]any{"id": "notify", "type": "http", "config": map[string]any{"url": url + "/notify", "method": "POST", "retry": retry}},
		},
		"edges": []any{
			map[string]any{"from": "shape", "to": "charge"},
			map[string]any{"from": "charge", "to": "fetch"},
			map[string]any{"from": "fetch", "to": "notify"},
		},
	}
}

func (h *apiHarness) failedRerunSource(url, id string) string {
	h.t.Helper()
	started := h.call("POST", "/v1/start", map[string]any{"workflow": rerunWorkflow(id, url), "input": map[string]any{"tag": "orig"}}, "")
	runID := extractRunID(h.t, started)
	h.waitRun(runID, "failed")
	return runID
}

func TestRerunReusesEarlierWritesAndLinksTheSource(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	target := newRerunTarget(t)
	sourceRunID := h.failedRerunSource(target.URL, fmt.Sprintf("wf-rerun-%d", time.Now().UnixNano()))
	if target.writes.Load() != 1 {
		t.Fatalf("source run must charge once, got %d", target.writes.Load())
	}

	preview := h.call("POST", "/runs/rerun/preview", map[string]any{"sourceRunId": sourceRunID, "nodeId": "fetch"}, "")
	if preview.status != 200 {
		t.Fatalf("preview: %d %+v", preview.status, preview.body)
	}
	if fmt.Sprint(preview.body["reused"]) != "[shape charge]" || fmt.Sprint(preview.body["rerun"]) != "[fetch notify]" {
		t.Fatalf("preview plan: %+v", preview.body)
	}
	if effects := preview.body["sideEffects"].([]any); len(effects) != 1 || effects[0].(map[string]any)["nodeId"] != "notify" {
		t.Fatalf("side effects must list later writes only: %+v", preview.body)
	}
	if input := preview.body["input"].(map[string]any); input["method"] != "GET" {
		t.Fatalf("preview input: %+v", input)
	}

	override := map[string]any{"url": target.URL + "/fixed", "method": "GET", "retry": map[string]any{"maxAttempts": 1}}
	request := map[string]any{"sourceRunId": sourceRunID, "nodeId": "fetch", "inputOverride": override}
	unconfirmed := h.call("POST", "/runs/rerun", request, "")
	if unconfirmed.status != 409 || unconfirmed.body["code"] != "rerun_side_effects_unconfirmed" {
		t.Fatalf("listed side effects must be confirmed: %d %+v", unconfirmed.status, unconfirmed.body)
	}
	if target.writes.Load() != 1 {
		t.Fatal("an unconfirmed rerun must not start")
	}

	request["acknowledgedSideEffects"] = []string{"notify"}
	started := h.call("POST", "/runs/rerun", request, "")
	if started.status != 200 {
		t.Fatalf("rerun: %d %+v", started.status, started.body)
	}
	rerunID := started.body["runId"].(string)
	h.waitRun(rerunID, "succeeded")

	if target.writes.Load() != 2 || target.reads.Load() != 1 {
		t.Fatalf("charge must not repeat and notify runs once: writes=%d reads=%d", target.writes.Load(), target.reads.Load())
	}
	for _, nodeID := range []string{"shape", "charge"} {
		var attempts int
		var status, state string
		if err := pool.QueryRow(ctx, `SELECT status, attempts, state_json::text FROM run_nodes WHERE run_id=$1 AND node_id=$2`, rerunID, nodeID).Scan(&status, &attempts, &state); err != nil {
			t.Fatalf("%s row: %v", nodeID, err)
		}
		if status != "succeeded" || attempts != 0 || !strings.Contains(state, "output") {
			t.Fatalf("%s must be cloned, never attempted: %s attempts=%d %s", nodeID, status, attempts, state)
		}
	}

	detail := h.call("GET", "/v1/run?runId="+rerunID, nil, "")
	run := detail.body["data"].(map[string]any)["run"].(map[string]any)
	if run["parentRunId"] != sourceRunID || run["parentNodeId"] != "fetch" || run["replayMode"] != nil {
		t.Fatalf("lineage: %+v", run)
	}
	// A null kind beside a parent node would read as an executable subworkflow edge.
	var linkKind string
	if err := pool.QueryRow(ctx, `SELECT parent_link_kind FROM runs WHERE id=$1`, rerunID).Scan(&linkKind); err != nil || linkKind != "rerun" {
		t.Fatalf("link kind: %q %v", linkKind, err)
	}
	source := h.call("GET", "/v1/status?runId="+sourceRunID, nil, "")
	if source.body["data"].(map[string]any)["run"].(map[string]any)["status"] != "failed" {
		t.Fatal("the source run must stay as it was")
	}

	var metadata string
	if err := pool.QueryRow(ctx, `SELECT metadata::text FROM audit_logs WHERE org_id=$1 AND action='run.rerun_started' AND target_id=$2`, h.org, rerunID).Scan(&metadata); err != nil {
		t.Fatalf("audit: %v", err)
	}
	if !strings.Contains(metadata, `"inputEdited": true`) || strings.Contains(metadata, "/fixed") {
		t.Fatalf("audit records the edit, never its values: %s", metadata)
	}
}

func TestRerunSideEffectsAreRecomputedAfterTheOverride(t *testing.T) {
	h := newAPIHarness(t)
	target := newRerunTarget(t)
	sourceRunID := h.failedRerunSource(target.URL, fmt.Sprintf("wf-rerun-%d", time.Now().UnixNano()))
	writes := target.writes.Load()

	flipped := h.call("POST", "/runs/rerun", map[string]any{
		"sourceRunId": sourceRunID, "nodeId": "fetch",
		"inputOverride":           map[string]any{"url": target.URL + "/fixed", "method": "DELETE", "retry": map[string]any{"maxAttempts": 1}},
		"acknowledgedSideEffects": []string{"notify"},
	}, "")
	if flipped.status != 409 || !strings.Contains(fmt.Sprint(flipped.body["params"]), "fetch") {
		t.Fatalf("an edit that adds a write must be confirmed: %d %+v", flipped.status, flipped.body)
	}
	if target.writes.Load() != writes {
		t.Fatal("nothing may run before confirmation")
	}
}

func TestRerunIsScopedToTheOrganizationAndItsGates(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	target := newRerunTarget(t)
	workflowID := fmt.Sprintf("wf-rerun-%d", time.Now().UnixNano())
	doc := rerunWorkflow(workflowID, target.URL)
	if saved := h.call("POST", "/v1/workflows/save", doc, ""); saved.status != 200 {
		t.Fatalf("save: %d %+v", saved.status, saved.body)
	}
	sourceRunID := h.failedRerunSource(target.URL, workflowID)
	request := func() map[string]any {
		return map[string]any{"sourceRunId": sourceRunID, "nodeId": "fetch", "acknowledgedSideEffects": []string{"notify"}}
	}

	for _, path := range []string{"/runs/rerun/preview", "/runs/rerun"} {
		if res := h.call("POST", path, request(), "other-org-"+workflowID); res.status != 404 {
			t.Fatalf("%s across organizations must 404: %d %+v", path, res.status, res.body)
		}
		if res := h.call("POST", path, map[string]any{"sourceRunId": "nope", "nodeId": "fetch"}, ""); res.status != 404 {
			t.Fatalf("%s with an unknown run must 404: %d", path, res.status)
		}
	}

	// An unsafe override fails before any row exists and never echoes its value.
	secret := request()
	secret["inputOverride"] = map[string]any{"url": target.URL, "method": "GET", "headers": map[string]any{"Authorization": "Bearer pasted-value"}}
	if res := h.call("POST", "/runs/rerun", secret, ""); res.status != 422 || res.body["code"] != "rerun_raw_secret" || strings.Contains(fmt.Sprint(res.body), "pasted-value") {
		t.Fatalf("literal credential: %d %+v", res.status, res.body)
	}
	invalid := request()
	invalid["inputOverride"] = map[string]any{"url": target.URL, "retry": map[string]any{"maxAttempts": 99}}
	if res := h.call("POST", "/runs/rerun", invalid, ""); res.status != 400 || res.body["code"] != "workflows_validation_failed" {
		t.Fatalf("an override must pass the normal validation: %d %+v", res.status, res.body)
	}
	notObject := request()
	notObject["inputOverride"] = []any{1}
	if res := h.call("POST", "/runs/rerun", notObject, ""); res.status != 400 {
		t.Fatalf("a non-object override must 400: %d", res.status)
	}

	// A paused workflow refuses reruns like every other run entry point.
	if _, err := pool.Exec(ctx, `UPDATE workflows SET status='paused_circuit_breaker' WHERE id=$1 AND org_id=$2`, workflowID, h.org); err != nil {
		t.Fatalf("pause: %v", err)
	}
	if res := h.call("POST", "/runs/rerun", request(), ""); res.status != 409 || res.body["code"] != "workflow_circuit_breaker_paused" {
		t.Fatalf("paused: %d %+v", res.status, res.body)
	}
	if _, err := pool.Exec(ctx, `UPDATE workflows SET status='active' WHERE id=$1 AND org_id=$2`, workflowID, h.org); err != nil {
		t.Fatalf("resume: %v", err)
	}

	// Saved-only tenants: an override is unsaved, the source's own document is not.
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id,org_id,key,value_json,category,description,value_type)
		VALUES ($1,$2,'runs.requireSavedWorkflow','true','runs','test','boolean')`, h.org+"-saved-only", h.org); err != nil {
		t.Fatalf("config: %v", err)
	}
	unsaved := request()
	unsaved["inputOverride"] = map[string]any{"url": target.URL + "/fixed", "method": "GET", "retry": map[string]any{"maxAttempts": 1}}
	if res := h.call("POST", "/runs/rerun", unsaved, ""); res.status != 403 || res.body["code"] != "runs_adhoc_disabled" {
		t.Fatalf("saved-only override: %d %+v", res.status, res.body)
	}
	// The dialog always submits the input; unedited, it must stay on the version.
	preview := h.call("POST", "/runs/rerun/preview", request(), "")
	unedited := request()
	unedited["inputOverride"] = preview.body["input"]
	same := h.call("POST", "/runs/rerun", unedited, "")
	if same.status != 200 {
		t.Fatalf("saved-only rerun of the saved document: %d %+v", same.status, same.body)
	}
	rerunID := same.body["runId"].(string)
	h.waitRun(rerunID, "failed")
	var version, sourceVersion string
	_ = pool.QueryRow(ctx, `SELECT workflow_version_id FROM runs WHERE id=$1`, rerunID).Scan(&version)
	_ = pool.QueryRow(ctx, `SELECT workflow_version_id FROM runs WHERE id=$1`, sourceRunID).Scan(&sourceVersion)
	if version != sourceVersion || version == rerunID {
		t.Fatalf("an unedited rerun stays on the source version: %s vs %s", version, sourceVersion)
	}
}

func TestRerunSourceMustBeFinishedAndProduction(t *testing.T) {
	h := newAPIHarness(t)
	target := newRerunTarget(t)
	suffix := time.Now().UnixNano()

	waiting := map[string]any{
		"id": fmt.Sprintf("wf-rerun-wait-%d", suffix), "name": "Wait", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{}},
			map[string]any{"id": "after", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "gate", "to": "after"}},
	}
	openRunID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": waiting}, ""))
	if res := h.call("POST", "/runs/rerun/preview", map[string]any{"sourceRunId": openRunID, "nodeId": "gate"}, ""); res.status != 409 || res.body["code"] != "rerun_source_open" {
		t.Fatalf("an open source must be refused: %d %+v", res.status, res.body)
	}

	sourceRunID := h.failedRerunSource(target.URL, fmt.Sprintf("wf-rerun-%d", suffix))
	lab := h.call("POST", "/runs/replay-lab", map[string]any{"sourceRunId": sourceRunID}, "")
	if lab.status != 200 {
		t.Fatalf("lab: %d %+v", lab.status, lab.body)
	}
	labRunID := lab.body["runId"].(string)
	h.waitRun(labRunID, "failed")
	if res := h.call("POST", "/runs/rerun", map[string]any{"sourceRunId": labRunID, "nodeId": "fetch", "acknowledgedSideEffects": []string{"notify"}}, ""); res.status != 400 || res.body["code"] != "nested_replay_lab" {
		t.Fatalf("a validation run must not become production: %d %+v", res.status, res.body)
	}
}

func TestRerunIdempotencyKeyStartsOneRun(t *testing.T) {
	h := newAPIHarness(t)
	target := newRerunTarget(t)
	sourceRunID := h.failedRerunSource(target.URL, fmt.Sprintf("wf-rerun-%d", time.Now().UnixNano()))
	send := func() apiResponse {
		req, _ := http.NewRequest("POST", h.server.URL+"/runs/rerun", strings.NewReader(fmt.Sprintf(
			`{"sourceRunId":%q,"nodeId":"fetch","acknowledgedSideEffects":["notify"]}`, sourceRunID)))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-org-id", h.org)
		req.Header.Set("x-user-id", "api-tester")
		req.Header.Set("Idempotency-Key", "rerun-"+sourceRunID)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("send: %v", err)
		}
		defer res.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(res.Body).Decode(&body)
		return apiResponse{status: res.StatusCode, body: body}
	}
	first, second := send(), send()
	if first.status != 200 || second.status != 200 || first.body["runId"] != second.body["runId"] {
		t.Fatalf("idempotent rerun: %+v %+v", first, second)
	}
}

// A credential the author hardcoded stays masked on every read and still reaches
// the executor when the operator submits the masked form back.
func TestRerunMasksAuthoredCredentials(t *testing.T) {
	h := newAPIHarness(t)
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	var seen atomic.Value
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Store(r.Header.Get("X-Api-Key"))
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer target.Close()
	workflow := map[string]any{
		"id": fmt.Sprintf("wf-rerun-mask-%d", time.Now().UnixNano()), "name": "Mask", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": target.URL, "method": "GET", "headers": map[string]any{"X-Api-Key": "authored-literal"},
			"retry": map[string]any{"maxAttempts": 1},
		}}},
		"edges": []any{},
	}
	sourceRunID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, ""))
	h.waitRun(sourceRunID, "succeeded")
	seen.Store("")

	preview := h.call("POST", "/runs/rerun/preview", map[string]any{"sourceRunId": sourceRunID, "nodeId": "call"}, "")
	if preview.status != 200 || strings.Contains(fmt.Sprint(preview.body), "authored-literal") {
		t.Fatalf("preview must mask: %d %+v", preview.status, preview.body)
	}
	input := preview.body["input"].(map[string]any)
	input["timeoutMs"] = float64(5000)
	started := h.call("POST", "/runs/rerun", map[string]any{"sourceRunId": sourceRunID, "nodeId": "call", "inputOverride": input}, "")
	if started.status != 200 {
		t.Fatalf("rerun: %d %+v", started.status, started.body)
	}
	h.waitRun(started.body["runId"].(string), "succeeded")
	if seen.Load() != "authored-literal" {
		t.Fatalf("the masked value must be restored: %v", seen.Load())
	}
}

// A join reads the saved output of a branch that is not rerun, an approval's
// saved output can be reused for reads, and neither branch runs again.
func TestRerunJoinAndApprovalReuse(t *testing.T) {
	h := newAPIHarness(t)
	target := newRerunTarget(t)
	retry := map[string]any{"maxAttempts": 1}
	workflow := map[string]any{
		"id": fmt.Sprintf("wf-rerun-join-%d", time.Now().UnixNano()), "name": "Join", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{"message": "Go"}},
			map[string]any{"id": "sibling", "type": "transform", "config": map[string]any{"mapping": map[string]any{"v": "from-sibling"}}},
			map[string]any{"id": "fetch", "type": "http", "config": map[string]any{"url": target.URL + "/broken", "method": "GET", "retry": retry}},
			map[string]any{"id": "merge", "type": "transform", "config": map[string]any{"mapping": map[string]any{"got": "{{context.sibling.output.v}}"}}},
		},
		"edges": []any{
			map[string]any{"from": "gate", "to": "sibling"}, map[string]any{"from": "gate", "to": "fetch"},
			map[string]any{"from": "sibling", "to": "merge"}, map[string]any{"from": "fetch", "to": "merge"},
		},
	}
	sourceRunID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, ""))
	pool := testPool(t)
	ctx := context.Background()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE run_id=$1 AND node_id='gate'`, sourceRunID).Scan(&status)
		if status == "waiting" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("gate never waited: %s", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if res := h.call("POST", "/v1/resume", map[string]any{"runId": sourceRunID, "nodeId": "gate"}, ""); res.status != 200 {
		t.Fatalf("resume: %d %+v", res.status, res.body)
	}
	h.waitRun(sourceRunID, "failed")

	started := h.call("POST", "/runs/rerun", map[string]any{
		"sourceRunId": sourceRunID, "nodeId": "fetch",
		"inputOverride": map[string]any{"url": target.URL + "/fixed", "method": "GET", "retry": retry},
	}, "")
	if started.status != 200 {
		t.Fatalf("rerun behind an approval with no writes: %d %+v", started.status, started.body)
	}
	rerunID := started.body["runId"].(string)
	h.waitRun(rerunID, "succeeded")
	var merged string
	if err := pool.QueryRow(ctx, `SELECT state_json::text FROM run_nodes WHERE run_id=$1 AND node_id='merge'`, rerunID).Scan(&merged); err != nil || !strings.Contains(merged, "from-sibling") {
		t.Fatalf("join must read the reused output: %s %v", merged, err)
	}
	var attempts int
	_ = pool.QueryRow(ctx, `SELECT sum(attempts) FROM run_nodes WHERE run_id=$1 AND node_id IN ('gate','sibling')`, rerunID).Scan(&attempts)
	if attempts != 0 {
		t.Fatalf("reused steps must not be attempted: %d", attempts)
	}
}

// The dispatcher's write grant is untouched: tenant consent still decides, and an
// approved agent cannot rerun on its old approval.
func TestRerunAgentWritesKeepTheirGates(t *testing.T) {
	h := newAPIHarness(t)
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	t.Setenv("JANUSLY_AGENT_WRITES_ENABLED", "true")
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer target.Close()
	agentConfig := map[string]any{
		"goal": "Send it", "planner": "rules", "tool": "http.request", "maxSteps": float64(5), "allowWriteTools": true,
		"input": map[string]any{"url": target.URL, "method": "POST", "body": map[string]any{"ok": true}},
	}
	workflow := map[string]any{
		"id": fmt.Sprintf("wf-rerun-agent-%d", time.Now().UnixNano()), "name": "Agent", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "shape", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "agent", "type": "agent", "config": agentConfig},
		},
		"edges": []any{map[string]any{"from": "shape", "to": "agent"}},
	}
	sourceRunID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, ""))
	h.waitRun(sourceRunID, "succeeded")
	if hits.Load() != 0 {
		t.Fatal("no consent, no write")
	}
	request := map[string]any{"sourceRunId": sourceRunID, "nodeId": "agent"}
	preview := h.call("POST", "/runs/rerun/preview", request, "")
	if !strings.Contains(fmt.Sprint(preview.body["sideEffects"]), "agent") {
		t.Fatalf("a write-enabled agent is a side effect: %+v", preview.body)
	}
	request["acknowledgedSideEffects"] = []string{"agent"}
	started := h.call("POST", "/runs/rerun", request, "")
	if started.status != 200 {
		t.Fatalf("rerun: %d %+v", started.status, started.body)
	}
	h.waitRun(started.body["runId"].(string), "succeeded")
	if hits.Load() != 0 {
		t.Fatalf("a rerun must not bypass tenant consent: %d", hits.Load())
	}
}

// A rerun repeats what the source executed: a rollout started since then must
// not swap the document under its seeded nodes or consume canary traffic.
func TestRerunIgnoresActiveRollouts(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	target := newRerunTarget(t)
	wfID := fmt.Sprintf("wf-rerun-rollout-%d", time.Now().UnixNano())
	doc := func(path string) map[string]any {
		return map[string]any{
			"id": wfID, "name": "Rollout", "dslVersion": "1.0",
			"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{"url": target.URL + path, "method": "GET"}}},
			"edges": []any{},
		}
	}
	v1 := h.call("POST", "/workflows/save", doc("/one"), "").body["versionId"]
	sourceRunID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": doc("/one"), "workflowVersionId": v1}, ""))
	h.waitRun(sourceRunID, "succeeded")
	v2 := h.call("POST", "/workflows/save", doc("/two"), "").body["versionId"]
	if res := h.call("POST", "/workflows/"+wfID+"/rollout", map[string]any{
		"baselineVersionId": v1, "canaryVersionId": v2,
		"trafficPercent": 50, "minimumSampleSize": 100, "minimumSuccessRatePercent": 1,
	}, ""); res.status != 200 {
		t.Fatalf("rollout: %d %+v", res.status, res.body)
	}
	for range 10 {
		started := h.call("POST", "/runs/rerun", map[string]any{"sourceRunId": sourceRunID, "nodeId": "call"}, "")
		if started.status != 200 {
			t.Fatalf("rerun: %d %+v", started.status, started.body)
		}
		var variant, version string
		if err := pool.QueryRow(t.Context(), `SELECT COALESCE(workflow_rollout_variant,''), workflow_version_id FROM runs WHERE id=$1`,
			started.body["runId"]).Scan(&variant, &version); err != nil {
			t.Fatalf("run: %v", err)
		}
		if variant != "" || version != v1 {
			t.Fatalf("rerun must stay on the source version: variant=%q version=%s want %v", variant, version, v1)
		}
	}
}
