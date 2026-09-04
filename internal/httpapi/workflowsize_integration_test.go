//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/workflowvalidation"
)

// A 2 MiB save body fits tens of thousands of nodes, each of which becomes a
// run_nodes row on every start. Snippets were already capped; whole
// workflows now are too, with a validation issue rather than a generic 400.
func TestWorkflowSaveRejectsOversizedGraphs(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	nodes := make([]any, 0, workflowvalidation.MaxWorkflowNodes+1)
	for i := 0; i <= workflowvalidation.MaxWorkflowNodes; i++ {
		nodes = append(nodes, map[string]any{
			"id":     fmt.Sprintf("n%d", i),
			"type":   "transform",
			"config": map[string]any{"mapping": map[string]any{"i": fmt.Sprint(i)}},
		})
	}
	doc := map[string]any{"id": "wf-too-large", "name": "too large", "nodes": nodes, "edges": []any{}}
	res := h.call("POST", "/v1/workflows/save", doc, "")
	if res.status != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %v", res.status, res.body)
	}
	raw, _ := json.Marshal(res.body)
	if !strings.Contains(string(raw), `"workflow_too_large"`) {
		t.Fatalf("rejection must name the size issue: %s", raw)
	}
	envelope, _ := res.body["error"].(map[string]any)
	params, _ := envelope["params"].(map[string]any)
	issues, _ := params["issues"].([]any)
	if len(issues) != 1 {
		t.Fatalf("size check must short-circuit the per-node validation, got %d issues: %s", len(issues), raw)
	}
}
