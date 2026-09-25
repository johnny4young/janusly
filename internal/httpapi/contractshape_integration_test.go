//go:build integration

package httpapi

import (
	"net/http"
	"net/url"
	"testing"
)

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
