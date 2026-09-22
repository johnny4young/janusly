//go:build integration

package httpapi

import (
	"net/http"
	"net/url"
	"testing"
)

// The manifest is what the TypeScript client is generated from. These two
// endpoints were described as shapes the handlers never emitted; the served
// body must now satisfy the description key for key.
func TestDlqClustersAndRecoveryMetricsMatchManifest(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	for _, path := range []string{"/v1/dlq/clusters", "/v1/recovery/metrics"} {
		res := h.call("GET", path, nil, "")
		if res.status != http.StatusOK {
			t.Fatalf("%s: want 200, got %d: %v", path, res.status, res.body)
		}
		schema := manifestResponse(t, "GET", path)
		properties, _ := schema["properties"].(map[string]any)
		if properties == nil {
			t.Fatalf("%s: manifest response has no properties", path)
		}
		body := res.body
		if data, ok := body["data"].(map[string]any); ok {
			body = data
		}
		required, _ := schema["required"].([]string)
		for _, key := range required {
			if _, present := body[key]; !present {
				t.Fatalf("%s: response lacks required %q: %v", path, key, body)
			}
		}
		for key := range body {
			if _, described := properties[key]; !described {
				t.Fatalf("%s: response emits %q which the manifest does not describe", path, key)
			}
		}
	}
}

func TestRunStatusPaginationMatchesManifestAndLegacyWire(t *testing.T) {
	h := newAPIHarness(t)
	started := h.call("POST", "/v1/start", map[string]any{"workflow": makeLinearWorkflow("wf-" + h.org)}, "")
	if started.status != http.StatusOK {
		t.Fatalf("start: %v", started.body)
	}
	runID := started.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "succeeded")
	for _, path := range []string{"/v1/run", "/v1/status", "/run", "/status"} {
		res := h.call("GET", path+"?runId="+runID+"&eventsLimit=1", nil, "")
		if res.status != http.StatusOK {
			t.Fatalf("%s: %v", path, res.body)
		}
		data := res.body
		if wrapped, ok := data["data"].(map[string]any); ok {
			data = wrapped
		}
		requireManifestData(t, "/v1/status", data)
		if data["eventsHasMore"] != true || len(data["events"].([]any)) != 1 {
			t.Fatalf("expected bounded page with more history: %v", data)
		}
		cursor, ok := data["eventsCursor"].(string)
		if !ok || cursor == "" {
			t.Fatal("missing continuation cursor")
		}
		older := h.call("GET", path+"?runId="+runID+"&eventsLimit=1&eventsCursor="+url.QueryEscape(cursor), nil, "")
		if older.status != http.StatusOK {
			t.Fatalf("older: %v", older.body)
		}
		olderData := older.body
		if wrapped, ok := olderData["data"].(map[string]any); ok {
			olderData = wrapped
		}
		requireManifestData(t, "/v1/status", olderData)
		if olderData["events"].([]any)[0].(map[string]any)["id"] == data["events"].([]any)[0].(map[string]any)["id"] {
			t.Fatal("cursor returned the same event")
		}
	}
}
