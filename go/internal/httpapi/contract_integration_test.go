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

	"github.com/johnny4young/janusly/go/internal/engine"
	"github.com/johnny4young/janusly/go/internal/grammar"
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
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 2, 30*time.Millisecond, dispatcher.Execute, quietTestLogger())
	}()
	t.Cleanup(func() { stopWorkers(); <-done })

	server := httptest.NewServer(NewV1Handler(eng, pool))
	t.Cleanup(server.Close)
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
