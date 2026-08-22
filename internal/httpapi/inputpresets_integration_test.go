//go:build integration

package httpapi

import (
	"fmt"
	"testing"
	"time"
)

// Named run-input presets: org-scoped through the workflow owner check,
// bounded, unique by name, and fail-closed against secret-shaped values.
func TestInputPresetLifecycle(t *testing.T) {
	h := newAPIHarness(t)
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-preset-" + suffix
	if res := h.call("POST", "/v1/workflows/save", map[string]any{
		"id": wfID, "name": wfID, "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
		"inputs": map[string]any{"type": "object", "required": []any{"customer"},
			"properties": map[string]any{"customer": map[string]any{"type": "string"}}},
	}, ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}

	base := "/workflows/" + wfID + "/input-presets"
	if res := h.call("PUT", base, map[string]any{
		"name": "  VIP refund  ", "input": map[string]any{"customer": "acme", "amountUsd": 42},
	}, ""); res.status != 200 {
		t.Fatalf("save preset: %d %+v", res.status, res.body)
	}
	// Same name upserts — no duplicate row, fresh input.
	if res := h.call("PUT", base, map[string]any{
		"name": "VIP refund", "input": map[string]any{"customer": "acme", "amountUsd": 99},
	}, ""); res.status != 200 {
		t.Fatalf("upsert preset: %d %+v", res.status, res.body)
	}
	list := h.call("GET", base, nil, "")
	presets, _ := list.body["presets"].([]any)
	if list.status != 200 || len(presets) != 1 {
		t.Fatalf("one upserted preset expected: %d %+v", list.status, list.body)
	}
	first := presets[0].(map[string]any)
	if first["name"] != "VIP refund" || first["input"].(map[string]any)["amountUsd"] != float64(99) {
		t.Fatalf("preset content: %+v", first)
	}

	// Secret-shaped values are refused: a preset is not a secret store.
	if res := h.call("PUT", base, map[string]any{
		"name": "leaky", "input": map[string]any{"token": "sk-ant-" + suffix},
	}, ""); res.status != 422 || res.body["code"] != "input_preset_secret_shaped" {
		t.Fatalf("secret-shaped preset must be refused: %d %+v", res.status, res.body)
	}

	// The bound is real, but replacing an existing name still works at it.
	for i := range 19 {
		if res := h.call("PUT", base, map[string]any{
			"name": fmt.Sprintf("bulk-%02d", i), "input": map[string]any{"customer": "x"},
		}, ""); res.status != 200 {
			t.Fatalf("fill preset %d: %d %+v", i, res.status, res.body)
		}
	}
	if res := h.call("PUT", base, map[string]any{
		"name": "one-too-many", "input": map[string]any{"customer": "x"},
	}, ""); res.status != 422 || res.body["code"] != "input_preset_limit" {
		t.Fatalf("cap must hold: %d %+v", res.status, res.body)
	}
	if res := h.call("PUT", base, map[string]any{
		"name": "VIP refund", "input": map[string]any{"customer": "still-works"},
	}, ""); res.status != 200 {
		t.Fatalf("replacing at the cap must work: %d %+v", res.status, res.body)
	}

	// Cross-org: the workflow owner check answers an opaque 404.
	if res := h.call("GET", base, nil, "other-org-"+suffix); res.status != 404 {
		t.Fatalf("cross-org must 404: %d", res.status)
	}

	if res := h.call("DELETE", base+"/VIP refund", nil, ""); res.status != 200 {
		t.Fatalf("delete: %d %+v", res.status, res.body)
	}
	if res := h.call("DELETE", base+"/VIP refund", nil, ""); res.status != 404 {
		t.Fatalf("double delete must 404: %d", res.status)
	}
}
