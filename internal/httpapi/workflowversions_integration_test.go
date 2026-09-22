//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"testing"
)

func versionNumbers(t *testing.T, res apiResponse) []float64 {
	t.Helper()
	if res.status != http.StatusOK {
		t.Fatalf("want 200, got %d: %v", res.status, res.body)
	}
	requireManifestData(t, "/v1/workflows/versions", res.body["data"])
	rows, _ := res.body["data"].([]any)
	numbers := make([]float64, 0, len(rows))
	for _, row := range rows {
		item, _ := row.(map[string]any)
		number, _ := item["version"].(float64)
		numbers = append(numbers, number)
	}
	return numbers
}

// The history used to come back whole, every dag_json included. It is now
// a keyset page, newest first, with a cursor below the oldest shown row,
// and `version` pins one exact row for callers that know which they need.
func TestWorkflowVersionsPaginateNewestFirst(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	workflowID := "wf-versions-" + h.org
	for i := 1; i <= 3; i++ {
		doc := webhookWorkflow(workflowID, fmt.Sprintf("hook-%d", i))
		doc["name"] = fmt.Sprintf("versioned %d", i)
		if res := h.call("POST", "/v1/workflows/save", doc, ""); res.status != http.StatusOK {
			t.Fatalf("save %d: %d %v", i, res.status, res.body)
		}
	}
	base := "/v1/workflows/versions?workflowId=" + workflowID
	if got := versionNumbers(t, h.call("GET", base+"&limit=2", nil, "")); len(got) != 2 || got[0] != 3 || got[1] != 2 {
		t.Fatalf("first page must be the two newest versions, got %v", got)
	}
	if got := versionNumbers(t, h.call("GET", base+"&limit=2&beforeVersion=2", nil, "")); len(got) != 1 || got[0] != 1 {
		t.Fatalf("the page below version 2 must be version 1 alone, got %v", got)
	}
	if got := versionNumbers(t, h.call("GET", base+"&version=2", nil, "")); len(got) != 1 || got[0] != 2 {
		t.Fatalf("an exact version must return that row alone, got %v", got)
	}
	if got := versionNumbers(t, h.call("GET", base, nil, "")); len(got) != 3 {
		t.Fatalf("the default page holds a short history whole, got %v", got)
	}
	rows, _ := h.call("GET", base+"&limit=1", nil, "").body["data"].([]any)
	if item, _ := rows[0].(map[string]any); item["dagJson"] == nil {
		t.Fatal("rows keep dag_json: the panel restores and diffs from the list")
	}
}

func TestWorkflowListContractsPreserveEmptyHistoryAndTenantBoundary(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	workflowID := "wf-empty-" + h.org
	if _, err := pool.Exec(t.Context(), `INSERT INTO workflows (id, org_id, name) VALUES ($1, $2, 'Empty history')`, workflowID, h.org); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/workflows/latest", "/v1/workflows/versions"} {
		own := h.call("GET", path+"?workflowId="+workflowID, nil, "")
		if own.status != http.StatusOK {
			t.Fatalf("%s: %d %v", path, own.status, own.body)
		}
		requireManifestData(t, path, own.body["data"])
		if path == "/v1/workflows/latest" && own.body["data"] != nil {
			t.Fatal("empty history must have null latest")
		}
		if path == "/v1/workflows/versions" && len(own.body["data"].([]any)) != 0 {
			t.Fatal("empty history must be an empty page")
		}
		requireError(t, h.call("GET", path+"?workflowId="+workflowID, nil, h.org+"-foreign"), http.StatusNotFound, "workflow_not_found", "Workflow not found")
	}
	for _, org := range []string{h.org, h.org + "-foreign"} {
		res := h.call("GET", "/v1/workflows?q="+workflowID, nil, org)
		if res.status != http.StatusOK {
			t.Fatalf("list: %d %v", res.status, res.body)
		}
		requireManifestData(t, "/v1/workflows", res.body["data"])
		rows := res.body["data"].([]any)
		if (org == h.org && len(rows) != 1) || (org != h.org && len(rows) != 0) {
			t.Fatalf("wrong tenant list: %s %v", org, rows)
		}
	}
}
