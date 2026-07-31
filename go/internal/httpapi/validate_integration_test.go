//go:build integration

package httpapi

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/go/internal/tools"
)

// POST /validate parity: the reference's {valid, issues} shape with the
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
	// mismatch → input_default_type_mismatch. Code-level parity with Node.
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
		t.Fatalf("code parity: %s", codes)
	}

	// 4. /validate reports the FULL issue list — no pilot carve-out here
	// (an unsupported-for-pilot node type still surfaces).
	res = h.call("POST", "/validate", map[string]any{
		"id": "wf-full", "name": "Full", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "c", "type": "subworkflow", "config": map[string]any{}}},
		"edges": []any{},
	}, "")
	if !strings.Contains(strings.Join(issueCodes(res), ","), "node_type_unsupported_pilot") {
		t.Fatalf("pilot carve-out must NOT hide issues on /validate: %+v", res.body)
	}

	// 5. GET /tools (public catalog) never carries the planner-only
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
