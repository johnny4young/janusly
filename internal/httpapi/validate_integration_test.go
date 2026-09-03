//go:build integration

package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/tools"
)

// POST /validate consistency: the contract's {valid, issues} shape with the
// shared issue codes, accepting flat or {workflow}-enveloped bodies —
// and GET /tools never leaks the planner-only jsonSchema projection.
func TestValidateRouteAndPlannerProjection(t *testing.T) {
	h := newAPIHarness(t)

	issueCodes := func(res apiResponse) []string {
		var codes []string
		issues, _ := res.body["issues"].([]any)
		for _, entry := range issues {
			if issue, ok := entry.(map[string]any); ok {
				codes = append(codes, issue["code"].(string))
			}
		}
		return codes
	}

	// 1. Valid workflow (flat body) → {valid:true, issues:[]}.
	res := h.call("POST", "/validate", map[string]any{
		"id": "wf-val", "name": "Valida", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}, "")
	if res.status != 200 || res.body["valid"] != true {
		t.Fatalf("valid workflow: %d %+v", res.status, res.body)
	}

	// 2. Empty workflow ({workflow} envelope) → empty_workflow.
	res = h.call("POST", "/validate", map[string]any{"workflow": map[string]any{
		"id": "wf-vacio", "name": "Vacio", "dslVersion": "1.0",
		"nodes": []any{}, "edges": []any{},
	}}, "")
	if res.body["valid"] != false {
		t.Fatalf("empty must be invalid: %+v", res.body)
	}
	if codes := issueCodes(res); len(codes) == 0 || codes[0] != "empty_workflow" {
		t.Fatalf("empty_workflow code: %v", codes)
	}

	// 3. Broken edge target → edge_invalid_to; declared-input default type
	// mismatch → input_default_type_mismatch. Code-level consistency with Node.
	res = h.call("POST", "/validate", map[string]any{
		"id": "wf-roto", "name": "Roto", "dslVersion": "1.0",
		"inputs": map[string]any{"type": "object", "properties": map[string]any{
			"umbral": map[string]any{"type": "number", "default": "alto"},
		}},
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{map[string]any{"from": "n", "to": "fantasma"}},
	}, "")
	codes := strings.Join(issueCodes(res), ",")
	if !strings.Contains(codes, "edge_invalid_to") || !strings.Contains(codes, "input_default_type_mismatch") {
		t.Fatalf("code consistency: %s", codes)
	}

	// 4. /validate reports the FULL issue list — no runtime carve-out here
	// (an unsupported-for-runtime node type still surfaces; subworkflow and
	// schedule are executable, so `agent_reflection`
	// carries the carve-out now).
	res = h.call("POST", "/validate", map[string]any{
		"id": "wf-full", "name": "Full", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "c", "type": "agent_reflection", "config": map[string]any{}}},
		"edges": []any{},
	}, "")
	if !strings.Contains(strings.Join(issueCodes(res), ","), "node_type_not_executable") {
		t.Fatalf("runtime carve-out must NOT hide issues on /validate: %+v", res.body)
	}

	// 5. Invalid subworkflow authoring stays in the draft so this shared gate
	// blocks both the keyboard save path and a direct save request.
	invalidSubworkflow := map[string]any{
		"id": "wf-parent", "name": "Parent", "dslVersion": "1.0",
		"nodes": []any{map[string]any{
			"id": "child", "type": "subworkflow",
			"config": map[string]any{"workflowId": "wf-child", "version": "0"},
		}},
		"edges": []any{},
	}
	res = h.call("POST", "/validate", invalidSubworkflow, "")
	if res.status != 200 || res.body["valid"] != false ||
		!strings.Contains(strings.Join(issueCodes(res), ","), "subworkflow_invalid_version") {
		t.Fatalf("subworkflow validation consistency: %d %+v", res.status, res.body)
	}
	res = h.call("POST", "/workflows/save", invalidSubworkflow, "")
	if res.status != 400 || res.body["code"] != "workflows_validation_failed" {
		t.Fatalf("invalid subworkflow save must fail closed: %d %+v", res.status, res.body)
	}

	// 6. GET /tools (public catalog) never carries the planner-only
	// jsonSchema; PlannerTools does.
	res = h.call("GET", "/tools", nil, "")
	if res.status != 200 {
		t.Fatalf("/tools: %d", res.status)
	}
	rawCatalog, _ := json.Marshal(res.body)
	catalogText := string(rawCatalog)
	if catalogText == "" || strings.Contains(catalogText, "jsonSchema") {
		t.Fatalf("/tools must not leak the planner schema")
	}
	planner := tools.NewRegistry().PlannerTools(false)
	if len(planner) == 0 || planner[0]["jsonSchema"] == nil {
		t.Fatalf("planner projection must carry jsonSchema: %+v", planner[0])
	}
}
