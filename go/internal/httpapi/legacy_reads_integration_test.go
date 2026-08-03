//go:build integration

package httpapi

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
)

func callJSON(t *testing.T, h *apiHarness, path string, authenticated bool) (int, http.Header, any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, h.server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if authenticated {
		req.Header.Set("x-org-id", h.org)
		req.Header.Set("x-user-id", "api-tester")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer res.Body.Close()
	var body any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return res.StatusCode, res.Header, body
}

func TestLegacyReadAliasesMatchVersionedData(t *testing.T) {
	h := newAPIHarness(t)
	workflowID := "legacy-read-" + h.org
	workflow := map[string]any{
		"id": workflowID, "name": "Legacy read parity",
		"nodes": []any{map[string]any{"id": "finish", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	saved := h.call(http.MethodPost, "/workflows/save", workflow, "")
	if saved.status != http.StatusOK {
		t.Fatalf("save: %d %v", saved.status, saved.body)
	}
	started := h.call(http.MethodPost, "/start", workflow, "")
	if started.status != http.StatusOK {
		t.Fatalf("start: %d %v", started.status, started.body)
	}
	runID := started.body["runId"].(string)
	h.waitRun(runID, "succeeded")

	pairs := [][2]string{
		{"/memory/consent-status", "/v1/memory/consent-status"},
		{"/recovery/metrics?windowDays=30", "/v1/recovery/metrics?windowDays=30"},
		{"/recovery/ledger", "/v1/recovery/ledger"},
		{"/recovery/my-wins?days=30", "/v1/recovery/my-wins?days=30"},
		{"/workflows?q=" + workflowID + "&limit=20", "/v1/workflows?q=" + workflowID + "&limit=20"},
		{"/workflows/versions?workflowId=" + workflowID, "/v1/workflows/versions?workflowId=" + workflowID},
		{"/workflows/latest?workflowId=" + workflowID, "/v1/workflows/latest?workflowId=" + workflowID},
		{"/runs?workflowId=" + workflowID + "&limit=20", "/v1/runs?workflowId=" + workflowID + "&limit=20"},
		{"/run?runId=" + runID, "/v1/run?runId=" + runID},
		{"/run/usage?runId=" + runID, "/v1/run/usage?runId=" + runID},
		{"/status?runId=" + runID, "/v1/status?runId=" + runID},
	}
	for _, pair := range pairs {
		legacyStatus, _, legacy := callJSON(t, h, pair[0], true)
		versionedStatus, headers, versioned := callJSON(t, h, pair[1], true)
		if legacyStatus != http.StatusOK || versionedStatus != http.StatusOK {
			t.Fatalf("%s/%s statuses %d/%d", pair[0], pair[1], legacyStatus, versionedStatus)
		}
		if headers.Get("X-Request-Id") == "" {
			t.Fatalf("%s omitted X-Request-Id", pair[1])
		}
		envelope := versioned.(map[string]any)
		if envelope["apiVersion"] != "v1" || !reflect.DeepEqual(envelope["data"], legacy) {
			t.Fatalf("wire drift for %s: legacy=%v versioned=%v", pair[0], legacy, versioned)
		}
	}
}

func TestOpenAPIDocumentIsPublicAndNamesServerRelativePaths(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	status, _, raw := callJSON(t, h, "/v1/openapi.json", false)
	if status != http.StatusOK {
		t.Fatalf("openapi status %d", status)
	}
	document := raw.(map[string]any)
	if document["openapi"] != "3.1.0" {
		t.Fatalf("openapi version: %v", document["openapi"])
	}
	paths := document["paths"].(map[string]any)
	for _, path := range []string{
		"/memory/consent-status", "/recovery/metrics", "/recovery/ledger", "/recovery/my-wins",
		"/workflows", "/workflows/versions", "/workflows/latest", "/workflows/schedule-preview",
		"/runs", "/run", "/run/usage", "/status",
	} {
		if _, present := paths[path]; !present {
			t.Fatalf("OpenAPI path missing: %s", path)
		}
	}
}
