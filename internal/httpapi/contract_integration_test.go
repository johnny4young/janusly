//go:build integration

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/grammar"
)

// Contract tests shaped against the captured reference goldens
// (conformance/goldens/node): envelope, key sets, error codes and the
// tenancy invisibility rule. Values differ run to run — shapes must not.

type apiHarness struct {
	t      *testing.T
	server *httptest.Server
	org    string
}

func newAPIHarness(t *testing.T) *apiHarness {
	return newAPIHarnessWithWorkers(t, true)
}

func newAPIHarnessWithoutWorkers(t *testing.T) *apiHarness {
	return newAPIHarnessWithWorkers(t, false)
}

func newAPIHarnessWithWorkers(t *testing.T, startWorkers bool) *apiHarness {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set; run through `make test`")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	eng := engine.New(pool)
	if startWorkers {
		dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
		workerCtx, stopWorkers := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			_ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, dispatcher.Execute, quietTestLogger())
		}()
		go eng.RunReplayCampaignPump(workerCtx, 30*time.Millisecond, quietTestLogger())
		t.Cleanup(func() { stopWorkers(); <-done })
	}

	handler, shutdownHub := NewV1HandlerWithShutdown(eng, pool)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	t.Cleanup(shutdownHub)
	raw := make([]byte, 6)
	for i := range raw {
		raw[i] = byte('a' + time.Now().UnixNano()>>uint(i*3)%26)
	}
	return &apiHarness{t: t, server: server, org: "api-org-" + string(raw) + fmt.Sprint(time.Now().UnixNano()%100000)}
}

type apiResponse struct {
	status  int
	headers http.Header
	body    map[string]any
}

func (h *apiHarness) call(method, path string, body any, org string) apiResponse {
	h.t.Helper()
	if org == "" {
		org = h.org
	}
	var reader *bytes.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, h.server.URL+path, reader)
	if err != nil {
		h.t.Fatalf("request: %v", err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-org-id", org)
	req.Header.Set("x-user-id", "api-tester")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatalf("call %s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	var parsed map[string]any
	_ = json.NewDecoder(res.Body).Decode(&parsed)
	return apiResponse{status: res.StatusCode, headers: res.Header, body: parsed}
}

func (h *apiHarness) waitRun(runID, want string) {
	h.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		res := h.call("GET", "/v1/status?runId="+runID, nil, "")
		if data, ok := res.body["data"].(map[string]any); ok {
			if run, ok := data["run"].(map[string]any); ok && run["status"] == want {
				return
			}
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("run %s never reached %s", runID, want)
		}
		time.Sleep(30 * time.Millisecond)
	}
}

func requireEnvelope(t *testing.T, res apiResponse) {
	t.Helper()
	if res.body["apiVersion"] != "v1" {
		t.Fatalf("envelope apiVersion missing: %v", res.body)
	}
	if _, ok := res.body["requestId"].(string); !ok {
		t.Fatalf("envelope requestId missing: %v", res.body)
	}
	if res.headers.Get("X-Request-Id") == "" {
		t.Fatal("X-Request-Id header missing")
	}
}

func requireError(t *testing.T, res apiResponse, status int, code, message string) {
	t.Helper()
	requireEnvelope(t, res)
	if res.status != status {
		t.Fatalf("status %d, want %d: %v", res.status, status, res.body)
	}
	errBody, _ := res.body["error"].(map[string]any)
	if errBody["code"] != code || (message != "" && errBody["message"] != message) {
		t.Fatalf("error body parity broken: %v", errBody)
	}
}

func keysOf(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func requireKeys(t *testing.T, m map[string]any, want ...string) {
	t.Helper()
	sort.Strings(want)
	got := keysOf(m)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("key set parity broken:\n got: %v\nwant: %v", got, want)
	}
}

func makeLinearWorkflow(id string) map[string]any {
	return map[string]any{
		"id":   id,
		"name": "API linear",
		"nodes": []any{
			map[string]any{"id": "shape", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"verdict": "ok"},
			}},
			map[string]any{"id": "done", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "shape", "to": "done"}},
	}
}

func TestStartStatusRunAndListShapes(t *testing.T) {
	h := newAPIHarness(t)

	started := h.call("POST", "/v1/start", map[string]any{"workflow": makeLinearWorkflow("wf-" + h.org)}, "")
	requireEnvelope(t, started)
	if started.status != 200 {
		t.Fatalf("start status: %d %v", started.status, started.body)
	}
	data := started.body["data"].(map[string]any)
	requireKeys(t, data, "runId")
	runID := data["runId"].(string)
	h.waitRun(runID, "succeeded")

	// The golden's data keys for /run and /status.
	for _, path := range []string{"/v1/run?runId=" + runID, "/v1/status?runId=" + runID} {
		res := h.call("GET", path, nil, "")
		requireEnvelope(t, res)
		payload := res.body["data"].(map[string]any)
		requireKeys(t, payload, "run", "nodes", "events", "eventsCursor", "eventsHasMore")
		run := payload["run"].(map[string]any)
		requireKeys(t, run,
			"createdAt", "createdBy", "id", "inputJson", "orgId", "outcomeStatus",
			"outputJson", "parentLinkKind", "parentNodeId", "parentNotificationAfter",
			"parentRunId", "recoveryPlaybookAppliedRecordedAt",
			"recoveryPlaybookValidationRecordedAt", "replayMode",
			"semanticViolationCount", "status", "traceId", "validationEvidenceLevel",
			"workflowRolloutId", "workflowRolloutVariant", "workflowVersionId")
		nodes := payload["nodes"].([]any)
		requireKeys(t, nodes[0].(map[string]any),
			"attempts", "errorJson", "finishedAt", "id", "nodeId", "runId",
			"startedAt", "stateJson", "status")
		events := payload["events"].([]any)
		requireKeys(t, events[0].(map[string]any),
			"createdAt", "holdUntil", "id", "nodeId", "payload", "runId", "type")
	}

	list := h.call("GET", "/v1/runs?limit=5", nil, "")
	requireEnvelope(t, list)
	items := list.body["data"].([]any)
	requireKeys(t, items[0].(map[string]any),
		"createdAt", "createdBy", "hasWaitingNodes", "id", "orgId", "outcomeStatus",
		"outputJson", "parentNodeId", "parentRunId", "replayMode",
		"semanticViolationCount", "status", "traceId", "validationEvidenceLevel",
		"workflowId", "workflowName", "workflowVersionId")
}

func TestRunTenancyIsAnIndistinguishableForbidden(t *testing.T) {
	h := newAPIHarness(t)
	started := h.call("POST", "/v1/start", map[string]any{"workflow": makeLinearWorkflow("wf-" + h.org)}, "")
	runID := started.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "succeeded")

	// Golden: unknown run and cross-org run both read 403 runs_forbidden.
	requireError(t, h.call("GET", "/v1/run?runId=ghost-run-id", nil, ""),
		403, "runs_forbidden", "Forbidden")
	requireError(t, h.call("GET", "/v1/run?runId="+runID, nil, h.org+"-other"),
		403, "runs_forbidden", "Forbidden")
}

func TestStartInvalidWorkflowMatchesGoldenError(t *testing.T) {
	h := newAPIHarness(t)
	res := h.call("POST", "/v1/start", map[string]any{
		"workflow": map[string]any{"nodes": "nope"},
	}, "")
	requireError(t, res, 400, "invalid_input", "Invalid request body")
	params := res.body["error"].(map[string]any)["params"].(map[string]any)
	if params["field"] != "workflow.nodes" {
		t.Fatalf("params.field parity broken: %v", params)
	}
}

func TestResumeFlowAndConflictShapes(t *testing.T) {
	h := newAPIHarness(t)
	approval := map[string]any{
		"nodes": []any{
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{"message": "API gate"}},
		},
		"edges": []any{},
	}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": approval}, "")
	runID := started.body["data"].(map[string]any)["runId"].(string)

	deadline := time.Now().Add(15 * time.Second)
	for {
		res := h.call("GET", "/v1/run?runId="+runID, nil, "")
		nodes, _ := res.body["data"].(map[string]any)["nodes"].([]any)
		waiting := false
		for _, n := range nodes {
			if n.(map[string]any)["status"] == "waiting" {
				waiting = true
			}
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("approval never waited")
		}
		time.Sleep(30 * time.Millisecond)
	}

	resumed := h.call("POST", "/v1/resume", map[string]any{"runId": runID, "nodeId": "gate"}, "")
	requireEnvelope(t, resumed)
	requireKeys(t, resumed.body["data"].(map[string]any), "resumed")

	// Golden: 409 runs_resume_conflict "Node is not waiting".
	requireError(t, h.call("POST", "/v1/resume", map[string]any{"runId": runID, "nodeId": "gate"}, ""),
		409, "runs_resume_conflict", "Node is not waiting")
	// Cross-org resume: same invisibility as reads.
	requireError(t, h.call("POST", "/v1/resume", map[string]any{"runId": runID, "nodeId": "gate"}, h.org+"-x"),
		403, "runs_forbidden", "Forbidden")
}

func TestSaveWorkflowContract(t *testing.T) {
	h := newAPIHarness(t)
	workflowID := "wf-save-" + h.org
	doc := makeLinearWorkflow(workflowID)
	save := h.call("POST", "/v1/workflows/save", doc, "")
	requireEnvelope(t, save)
	if save.status != 200 {
		t.Fatalf("save: %d %v", save.status, save.body)
	}
	data := save.body["data"].(map[string]any)
	requireKeys(t, data, "version", "versionId", "workflowId")
	if data["version"] != float64(1) || data["workflowId"] != workflowID {
		t.Fatalf("first save must be version 1: %v", data)
	}
	again := h.call("POST", "/v1/workflows/save", doc, "")
	if again.body["data"].(map[string]any)["version"] != float64(2) {
		t.Fatalf("second save must append version 2: %v", again.body)
	}

	invalid := h.call("POST", "/v1/workflows/save", map[string]any{"name": "x"}, "")
	requireError(t, invalid, 400, "invalid_input", "Invalid request body")
	if invalid.body["error"].(map[string]any)["params"].(map[string]any)["field"] != "nodes" {
		t.Fatalf("save invalid field parity: %v", invalid.body)
	}
}

func TestDlqListAndRedriveShapes(t *testing.T) {
	h := newAPIHarness(t)
	doomed := map[string]any{
		"id":   "wf-doomed-" + h.org,
		"name": "API doomed",
		"nodes": []any{
			map[string]any{"id": "blocked", "type": "http", "config": map[string]any{
				"url": "http://169.254.169.254/latest/meta-data/",
			}},
		},
		"edges": []any{},
	}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": doomed}, "")
	runID := started.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "failed")

	list := h.call("GET", "/v1/dlq?limit=5", nil, "")
	requireEnvelope(t, list)
	items := list.body["data"].([]any)
	if len(items) == 0 {
		t.Fatal("dead letter expected")
	}
	item := items[0].(map[string]any)
	requireKeys(t, item,
		"attempt", "createdAt", "errorJson", "id", "nodeId", "nodeType", "orgId",
		"recovery", "replayedAt", "runId", "status", "workflowName")
	if item["nodeType"] != "http" || item["status"] != "open" {
		t.Fatalf("dlq projection broken: %v", item)
	}
	deadLetterID := item["id"].(string)

	// Cross-org: invisible. Then redrive claims once; the second conflicts.
	requireError(t, h.call("POST", "/v1/dlq/redrive", map[string]any{"deadLetterId": deadLetterID}, h.org+"-x"),
		404, "dlq_not_found", "Dead letter not found")
	redriven := h.call("POST", "/v1/dlq/redrive", map[string]any{"deadLetterId": deadLetterID}, "")
	requireEnvelope(t, redriven)
	requireKeys(t, redriven.body["data"].(map[string]any), "redriven")
	requireError(t, h.call("POST", "/v1/dlq/redrive", map[string]any{"deadLetterId": deadLetterID}, ""),
		409, "dlq_replay_conflict", "Dead letter replay already claimed")
}

func TestMissingOrgHeaderIsUnauthorized(t *testing.T) {
	h := newAPIHarness(t)
	req, _ := http.NewRequest("GET", h.server.URL+"/v1/runs", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatalf("missing org must be 401, got %d", res.StatusCode)
	}
}

func TestCancelGuardsDistinguishMissingFromCrossOrg(t *testing.T) {
	h := newAPIHarness(t)
	approval := map[string]any{
		"nodes": []any{
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{"message": "hold"}},
		},
		"edges": []any{},
	}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": approval}, "")
	runID := started.body["data"].(map[string]any)["runId"].(string)

	// Unlike run READS (indistinguishable 403), cancel splits 404 from 403 —
	// ported from the reference route guards.
	requireError(t, h.call("POST", "/v1/run/cancel", map[string]any{"runId": "ghost"}, ""),
		404, "runs_run_not_found", "Run not found")
	requireError(t, h.call("POST", "/v1/run/cancel", map[string]any{"runId": runID}, h.org+"-x"),
		403, "runs_forbidden", "Forbidden")
	// Golden-verified v1 contract: shape errors are invalid_input naming the
	// field — and an OBJECT reason is rejected (reason is an optional string).
	missing := h.call("POST", "/v1/run/cancel", map[string]any{}, "")
	requireError(t, missing, 400, "invalid_input", "Invalid request body")
	if missing.body["error"].(map[string]any)["params"].(map[string]any)["field"] != "runId" {
		t.Fatalf("missing runId field param: %v", missing.body)
	}
	badReason := h.call("POST", "/v1/run/cancel", map[string]any{"runId": runID, "reason": map[string]any{"why": "x"}}, "")
	requireError(t, badReason, 400, "invalid_input", "Invalid request body")
	if badReason.body["error"].(map[string]any)["params"].(map[string]any)["field"] != "reason" {
		t.Fatalf("object reason must name the field: %v", badReason.body)
	}

	cancelled := h.call("POST", "/v1/run/cancel", map[string]any{"runId": runID, "reason": "operator says stop"}, "")
	requireEnvelope(t, cancelled)
	data := cancelled.body["data"].(map[string]any)
	if data["status"] != "cancelled" || data["runId"] != runID {
		t.Fatalf("cancel response shape: %v", data)
	}

	already := h.call("POST", "/v1/run/cancel", map[string]any{"runId": runID}, "")
	requireError(t, already, 409, "runs_already_terminal", "Run is already {{status}}; cannot cancel")
	params := already.body["error"].(map[string]any)["params"].(map[string]any)
	if params["status"] != "cancelled" {
		t.Fatalf("terminal params must carry the status: %v", params)
	}
}

func TestReplayAliasMatchesReferenceShape(t *testing.T) {
	h := newAPIHarness(t)
	doomed := map[string]any{
		"id": "wf-replay-" + h.org,
		"nodes": []any{map[string]any{"id": "blocked", "type": "http", "config": map[string]any{
			"url": "http://169.254.169.254/x",
		}}},
		"edges": []any{},
	}
	started := h.call("POST", "/v1/start", map[string]any{"workflow": doomed}, "")
	runID := started.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "failed")
	list := h.call("GET", "/v1/dlq?limit=20", nil, "")
	var deadLetterID string
	for _, item := range list.body["data"].([]any) {
		if row := item.(map[string]any); row["runId"] == runID {
			deadLetterID = row["id"].(string)
		}
	}
	// Golden: success is {ok:true}; the conflict carries the reference's
	// full message.
	replayed := h.call("POST", "/v1/dlq/replay", map[string]any{"deadLetterId": deadLetterID}, "")
	requireEnvelope(t, replayed)
	if replayed.body["data"].(map[string]any)["ok"] != true {
		t.Fatalf("replay data shape: %v", replayed.body)
	}
	requireError(t, h.call("POST", "/v1/dlq/replay", map[string]any{"deadLetterId": deadLetterID}, ""),
		409, "dlq_replay_conflict", "This run can no longer be replayed — it was cancelled or already recovered")
}

func TestRunsKeysetCursorRoundTrip(t *testing.T) {
	h := newAPIHarness(t)
	// Five runs, two per page: the cursor the web derives from the last row
	// must walk pages with no duplicates and no gaps.
	for i := 0; i < 5; i++ {
		h.call("POST", "/v1/start", map[string]any{
			"workflow": makeLinearWorkflow(fmt.Sprintf("wf-cursor-%d-%s", i, h.org)),
		}, "")
	}
	// Every run terminal BEFORE walking — the walk itself must be a pure
	// pagination exercise, not a race against the workers.
	settle := time.Now().Add(20 * time.Second)
	for {
		res := h.call("GET", "/v1/runs?limit=100&status=succeeded", nil, "")
		if items, _ := res.body["data"].([]any); len(items) >= 5 {
			break
		}
		if time.Now().After(settle) {
			t.Fatal("runs never settled")
		}
		time.Sleep(50 * time.Millisecond)
	}

	seen := map[string]bool{}
	cursor := ""
	pages := 0
	for {
		path := "/v1/runs?limit=2&status=succeeded"
		if cursor != "" {
			path += "&before=" + strings.ReplaceAll(cursor, "|", "%7C")
		}
		res := h.call("GET", path, nil, "")
		items, _ := res.body["data"].([]any)
		if len(items) == 0 {
			break
		}
		for _, raw := range items {
			row := raw.(map[string]any)
			id := row["id"].(string)
			if seen[id] {
				t.Fatalf("cursor produced duplicate %s", id)
			}
			seen[id] = true
		}
		last := items[len(items)-1].(map[string]any)
		cursor = last["createdAt"].(string) + "|" + last["id"].(string)
		pages++
		if pages > 10 {
			t.Fatal("cursor never terminated")
		}
	}
	if len(seen) < 5 {
		t.Fatalf("cursor walk lost rows: saw %d of 5+", len(seen))
	}

	// Filters: workflowId narrows to one run; a bad cursor is invalid_input.
	one := h.call("GET", "/v1/runs?workflowId=wf-cursor-0-"+h.org, nil, "")
	if items := one.body["data"].([]any); len(items) != 1 {
		t.Fatalf("workflowId filter must narrow to one run, got %d", len(items))
	}
	requireError(t, h.call("GET", "/v1/runs?before=not-a-cursor", nil, ""),
		400, "invalid_input", "Invalid request body")
}

func TestWorkflowReadSurfaces(t *testing.T) {
	h := newAPIHarness(t)
	workflowID := "wf-read-" + h.org
	doc := makeLinearWorkflow(workflowID)
	h.call("POST", "/v1/workflows/save", doc, "")
	h.call("POST", "/v1/workflows/save", doc, "")
	started := h.call("POST", "/v1/start", map[string]any{"workflow": doc}, "")
	h.waitRun(started.body["data"].(map[string]any)["runId"].(string), "succeeded")

	// List row: the contract's full key set, aggregates included.
	list := h.call("GET", "/v1/workflows?q="+workflowID, nil, "")
	requireEnvelope(t, list)
	rows := list.body["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("search must narrow to the one workflow, got %d", len(rows))
	}
	row := rows[0].(map[string]any)
	requireKeys(t, row,
		"id", "orgId", "name", "createdBy", "createdAt", "lastRunStatus",
		"runCount", "bufferedTriggerCount", "status", "pausedReason",
		"tags", "folder", "deletedAt")
	// The reference counts ONLY version-linked runs — a doc-posted
	// ad-hoc run (this test's start) never counts, exactly like Node. The
	// counted case lives in TestVersionAttributionSemantics.
	if row["runCount"] != float64(0) || row["lastRunStatus"] != nil {
		t.Fatalf("doc-posted runs must not count (reference semantics): %v", row)
	}

	// Latest: nullable contract — a version row with the full key set here.
	latest := h.call("GET", "/v1/workflows/latest?workflowId="+workflowID, nil, "")
	requireEnvelope(t, latest)
	version := latest.body["data"].(map[string]any)
	requireKeys(t, version,
		"id", "orgId", "workflowId", "version", "dagJson", "sloJson",
		"upstreamHealthSources", "createdBy", "createdAt")
	if version["version"] != float64(2) {
		t.Fatalf("latest must be version 2 after two saves: %v", version["version"])
	}
	dag := version["dagJson"].(map[string]any)
	if dag["id"] != workflowID {
		t.Fatalf("dagJson must round-trip the saved document: %v", dag["id"])
	}

	// Versions: newest first.
	versions := h.call("GET", "/v1/workflows/versions?workflowId="+workflowID, nil, "")
	items := versions.body["data"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["version"] != float64(2) {
		t.Fatalf("versions must list newest first: %v", items)
	}

	// Guards: missing param names the field; unknown id is workflow_not_found.
	requireError(t, h.call("GET", "/v1/workflows/latest", nil, ""),
		400, "invalid_input", "Invalid request body")
	requireError(t, h.call("GET", "/v1/workflows/versions?workflowId=ghost", nil, ""),
		404, "workflow_not_found", "Workflow not found")
	// Cross-org: the workflow simply does not exist for another tenant.
	requireError(t, h.call("GET", "/v1/workflows/latest?workflowId="+workflowID, nil, h.org+"-x"),
		404, "workflow_not_found", "Workflow not found")
}

func TestLegacySupportReads(t *testing.T) {
	h := newAPIHarness(t)
	// /health is OPEN (no auth) with the reference's public-safe shape.
	req, _ := http.NewRequest("GET", h.server.URL+"/health", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	defer res.Body.Close()
	var health map[string]any
	_ = json.NewDecoder(res.Body).Decode(&health)
	if health["ok"] != true {
		t.Fatalf("health shape: %v", health)
	}
	limiter := health["rateLimiter"].(map[string]any)
	queue := health["queue"].(map[string]any)
	if limiter["healthy"] != true || queue["degraded"] != false {
		t.Fatalf("health sub-shapes: %v", health)
	}

	// /org/config: raw legacy body — the FULL closed catalog with layered
	// provenance, exactly what the reference answers a fresh org. The
	// earlier empty-list stub was a divergence and is covered here.
	cfg := h.call("GET", "/org/config", nil, "")
	if list, ok := cfg.body["config"].([]any); !ok || len(list) != 69 {
		t.Fatalf("org config must list the whole catalog: %v", cfg.body)
	}
}

func TestLegacyMutationAliasesSpeakTheRawWire(t *testing.T) {
	h := newAPIHarness(t)
	workflowID := "wf-legacy-" + h.org
	doc := makeLinearWorkflow(workflowID)

	// Legacy save: the RAW body, no envelope.
	saved := h.call("POST", "/workflows/save", doc, "")
	if saved.status != 200 || saved.body["apiVersion"] != nil {
		t.Fatalf("legacy save must be raw: %d %v", saved.status, saved.body)
	}
	if saved.body["workflowId"] != workflowID || saved.body["version"] != float64(1) {
		t.Fatalf("legacy save shape: %v", saved.body)
	}

	// Legacy start + cancel: raw {runId} and raw {runId, status}.
	started := h.call("POST", "/start", map[string]any{"workflow": doc}, "")
	runID, _ := started.body["runId"].(string)
	if runID == "" || started.body["data"] != nil {
		t.Fatalf("legacy start must be raw {runId}: %v", started.body)
	}
	h.waitRun(runID, "succeeded")
	already := h.call("POST", "/run/cancel", map[string]any{"runId": runID}, "")
	if already.status != 409 || already.body["error"] != "Run is already {{status}}; cannot cancel" ||
		already.body["code"] != "runs_already_terminal" {
		t.Fatalf("legacy error wire must be {error, code, params}: %v", already.body)
	}

	// Legacy resume conflict on a terminal run.
	conflict := h.call("POST", "/resume", map[string]any{"runId": runID, "nodeId": "shape"}, "")
	if conflict.status != 409 || conflict.body["error"] != "Node is not waiting" {
		t.Fatalf("legacy resume conflict: %v", conflict.body)
	}
}

func TestLegacyDlqDetailAndCounts(t *testing.T) {
	h := newAPIHarness(t)
	doomed := map[string]any{
		"id": "wf-dlqleg-" + h.org,
		"nodes": []any{map[string]any{"id": "blocked", "type": "http", "config": map[string]any{
			"url": "http://169.254.169.254/x",
		}}},
		"edges": []any{},
	}
	started := h.call("POST", "/start", map[string]any{"workflow": doomed}, "")
	runID := started.body["runId"].(string)
	h.waitRun(runID, "failed")

	counts := h.call("GET", "/dlq/counts", nil, "")
	if counts.body["open"].(float64) < 1 || counts.body["total"].(float64) < 1 {
		t.Fatalf("counts must reflect the open dead letter: %v", counts.body)
	}

	list := h.call("GET", "/v1/dlq?limit=20", nil, "")
	var deadLetterID string
	for _, item := range list.body["data"].([]any) {
		if row := item.(map[string]any); row["runId"] == runID {
			deadLetterID = row["id"].(string)
		}
	}
	detail := h.call("GET", "/dlq?id="+deadLetterID, nil, "")
	requireKeys(t, detail.body,
		"id", "orgId", "runId", "nodeId", "attempt", "workflowJson", "nodeJson",
		"errorJson", "status", "replayedAt", "createdAt", "replayClaimedAt",
		"suspectVersion", "drill", "drillOutcome")
	if detail.body["workflowJson"] == nil {
		t.Fatal("detail must carry the exact replay snapshot")
	}

	// Legacy replay: raw {ok:true} then the raw conflict wire.
	replayed := h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": deadLetterID}, "")
	if replayed.body["ok"] != true {
		t.Fatalf("legacy replay shape: %v", replayed.body)
	}
	again := h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": deadLetterID}, "")
	if again.status != 409 || again.body["code"] != "dlq_replay_conflict" {
		t.Fatalf("legacy replay conflict: %v", again.body)
	}
}

func TestSoftDeleteTrashRestoreLifecycle(t *testing.T) {
	h := newAPIHarness(t)
	workflowID := "wf-trash-" + h.org
	doc := makeLinearWorkflow(workflowID)
	h.call("POST", "/workflows/save", doc, "")

	// Delete: raw {workflowId, ok}; the workflow leaves every active read.
	deleted := h.call("DELETE", "/workflows/"+workflowID, nil, "")
	if deleted.body["ok"] != true {
		t.Fatalf("delete shape: %v", deleted.body)
	}
	if list := h.call("GET", "/v1/workflows?q="+workflowID, nil, ""); len(list.body["data"].([]any)) != 0 {
		t.Fatal("a tombstoned workflow must leave the active list")
	}
	requireError(t, h.call("GET", "/v1/workflows/latest?workflowId="+workflowID, nil, ""),
		404, "workflow_not_found", "Workflow not found")

	// A save NEVER resurrects a tombstone — the reference's house rule.
	requireError(t, h.call("POST", "/v1/workflows/save", doc, ""),
		404, "workflow_not_found", "Workflow not found")

	// Trash lists it with deletedAt populated, keyset on (deletedAt, id).
	// Legacy wire: the body is a BARE array, not an envelope.
	req, _ := http.NewRequest("GET", h.server.URL+"/workflows/trash", nil)
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", "api-tester")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("trash: %v", err)
	}
	defer res.Body.Close()
	var trashRows []any
	_ = json.NewDecoder(res.Body).Decode(&trashRows)
	found := false
	for _, raw := range trashRows {
		row := raw.(map[string]any)
		if row["id"] == workflowID {
			found = true
			if row["deletedAt"] == nil {
				t.Fatalf("trash rows must carry deletedAt: %v", row)
			}
		}
	}
	if !found {
		t.Fatal("tombstoned workflow must appear in the trash")
	}

	// Restore brings it back to every read; double restore is not-found.
	restored := h.call("POST", "/workflows/"+workflowID+"/restore", nil, "")
	if restored.body["ok"] != true {
		t.Fatalf("restore shape: %v", restored.body)
	}
	if list := h.call("GET", "/v1/workflows?q="+workflowID, nil, ""); len(list.body["data"].([]any)) != 1 {
		t.Fatal("a restored workflow must rejoin the active list")
	}
	// Legacy wire errors: {error: message, code} raw, no envelope.
	doubleRestore := h.call("POST", "/workflows/"+workflowID+"/restore", nil, "")
	if doubleRestore.status != 404 || doubleRestore.body["code"] != "workflow_not_found" {
		t.Fatalf("double restore legacy wire: %v", doubleRestore.body)
	}
	// Cross-org delete: invisible.
	crossDelete := h.call("DELETE", "/workflows/"+workflowID, nil, h.org+"-x")
	if crossDelete.status != 404 || crossDelete.body["code"] != "workflow_not_found" {
		t.Fatalf("cross-org delete legacy wire: %v", crossDelete.body)
	}
}

func TestRollbackAppendsPriorSnapshotAsNewLatest(t *testing.T) {
	h := newAPIHarness(t)
	workflowID := "wf-rb-" + h.org
	v1doc := makeLinearWorkflow(workflowID)
	v2doc := map[string]any{
		"id": workflowID, "name": "API linear v2",
		"nodes": []any{map[string]any{"id": "only", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	h.call("POST", "/workflows/save", v1doc, "")
	h.call("POST", "/workflows/save", v2doc, "")

	versions := h.call("GET", "/v1/workflows/versions?workflowId="+workflowID, nil, "")
	items := versions.body["data"].([]any)
	sourceVersionID := items[1].(map[string]any)["id"].(string) // version 1

	rolled := h.call("POST", "/workflows/rollback", map[string]any{
		"workflowId": workflowID, "sourceVersionId": sourceVersionID,
	}, "")
	if rolled.status != 200 || rolled.body["version"] != float64(3) || rolled.body["sourceVersion"] != float64(1) {
		t.Fatalf("rollback shape: %v", rolled.body)
	}

	// The new latest carries version 1's DAG (two nodes), not version 2's.
	latest := h.call("GET", "/v1/workflows/latest?workflowId="+workflowID, nil, "")
	dag := latest.body["data"].(map[string]any)["dagJson"].(map[string]any)
	if len(dag["nodes"].([]any)) != 2 {
		t.Fatalf("latest must be the rolled-back snapshot: %v", dag)
	}

	// Guard ladder, legacy wire.
	missing := h.call("POST", "/workflows/rollback", map[string]any{}, "")
	if missing.status != 400 || missing.body["code"] != "workflows_rollback_ids_required" {
		t.Fatalf("ids-required guard: %v", missing.body)
	}
	ghost := h.call("POST", "/workflows/rollback", map[string]any{
		"workflowId": "ghost", "sourceVersionId": sourceVersionID,
	}, "")
	if ghost.status != 404 || ghost.body["code"] != "workflow_not_found" {
		t.Fatalf("unknown parent guard: %v", ghost.body)
	}
	wrongSource := h.call("POST", "/workflows/rollback", map[string]any{
		"workflowId": workflowID, "sourceVersionId": "ghost-version",
	}, "")
	if wrongSource.status != 404 || wrongSource.body["code"] != "workflows_source_version_not_found" {
		t.Fatalf("source guard: %v", wrongSource.body)
	}

	// A tombstoned parent behaves as not-found for writes too.
	h.call("DELETE", "/workflows/"+workflowID, nil, "")
	tombstoned := h.call("POST", "/workflows/rollback", map[string]any{
		"workflowId": workflowID, "sourceVersionId": sourceVersionID,
	}, "")
	if tombstoned.status != 404 || tombstoned.body["code"] != "workflow_not_found" {
		t.Fatalf("tombstone guard: %v", tombstoned.body)
	}
}

func TestSaveRejectsInvalidEdgeConditions(t *testing.T) {
	h := newAPIHarness(t)
	doc := map[string]any{
		"id": "wf-edgeval-" + h.org,
		"nodes": []any{
			map[string]any{"id": "a", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "b", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "a", "to": "b", "condition": "require('fs')"}},
	}
	res := h.call("POST", "/v1/workflows/save", doc, "")
	requireError(t, res, 400, "workflows_validation_failed", "Validation failed")
	issues := res.body["error"].(map[string]any)["params"].(map[string]any)["issues"].([]any)
	sawEdge := false
	for _, raw := range issues {
		issue := raw.(map[string]any)
		if issue["code"] == "edge_invalid_condition" && issue["edgeId"] == "edge_0" {
			sawEdge = true
		}
	}
	if !sawEdge {
		t.Fatalf("save must surface the edge rejection: %v", issues)
	}
}
