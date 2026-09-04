//go:build integration

package httpapi

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// The F1 terminal-sweep closures serve the exact wires the web reads:
// /v1-enveloped GETs for the V1_READ_PATHS members and raw legacy for the
// rest. Shapes are pinned against the contract handlers.
func TestF1SweepReadClosures(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	suffix := fmt.Sprint(time.Now().UnixNano())

	// Templates: the embedded contract catalog, decorated + enveloped.
	res := h.call("GET", "/v1/templates", nil, "")
	if res.status != 200 {
		t.Fatalf("v1 templates: %d", res.status)
	}
	templates, ok := res.body["data"].([]any)
	if !ok || len(templates) != 17 {
		t.Fatalf("catalog must carry the 17 reference templates: %d", len(templates))
	}
	first := templates[0].(map[string]any)
	if first["nameCode"] == nil || first["workflow"] == nil || first["categoryCode"] == nil {
		t.Fatalf("templates must keep the public decoration: %+v", first)
	}

	// Schedule preview: valid cron → 3 fires; garbage → {valid:false}.
	res = h.call("GET", "/v1/workflows/schedule-preview?cron=0%209%20*%20*%20*", nil, "")
	preview := res.body["data"].(map[string]any)
	if preview["valid"] != true || len(preview["nextFires"].([]any)) != 3 {
		t.Fatalf("schedule preview: %+v", preview)
	}
	res = h.call("GET", "/v1/workflows/schedule-preview?cron=nope", nil, "")
	if preview = res.body["data"].(map[string]any); preview["valid"] != false {
		t.Fatalf("invalid cron must answer valid:false: %+v", preview)
	}

	// v1 workflows/health alias shares the legacy core.
	wf := "wf-f1-" + suffix
	if res = h.call("POST", "/v1/workflows/save", map[string]any{
		"id": wf, "name": wf, "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "n", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}, ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}
	res = h.call("GET", "/v1/workflows/health?workflowId="+wf, nil, "")
	if res.status != 200 {
		t.Fatalf("v1 health: %d %+v", res.status, res.body)
	}
	healthData := res.body["data"].(map[string]any)
	if healthData["score"] == nil {
		t.Fatalf("health score missing: %+v", healthData)
	}
	if _, wrapped := healthData["health"]; wrapped {
		t.Fatalf("v1 health data must be the score itself: %+v", healthData)
	}

	// v1 run/usage alias keeps the tenancy-first contract (unknown run 403).
	if res = h.call("GET", "/v1/run/usage?runId=ghost-"+suffix, nil, ""); res.status != 403 {
		t.Fatalf("v1 run usage unknown run must 403: %d", res.status)
	}

	// Memory consent status: default posture is disabled everywhere.
	res = h.call("GET", "/v1/memory/consent-status", nil, "")
	consent := res.body["data"].(map[string]any)
	if consent["enabled"] != false || consent["purge"].(map[string]any)["status"] != "none" {
		t.Fatalf("consent status default: %+v", consent)
	}

	// Calibration status: contract shape with the pinned constants.
	res = h.call("GET", "/recovery/calibration-status", nil, "")
	if res.status != 200 || res.body["windowDays"] != float64(30) ||
		res.body["minimumSampleSize"] != float64(20) {
		t.Fatalf("calibration status: %d %+v", res.status, res.body)
	}
	if _, ok := res.body["calibrations"].([]any); !ok {
		t.Fatalf("calibrations must be a list: %+v", res.body)
	}

	// MCP connections list with descriptor counts (seeded rows — no real
	// discovery needed for the read model).
	if _, err := pool.Exec(ctx,
		`INSERT INTO mcp_connections (id, org_id, alias, transport, enabled, status, expose_to_ai)
		 VALUES ($1, $2, $3, 'stdio', true, 'connected', false)`,
		"mcpc-"+suffix, h.org, "f1sweep"); err != nil {
		t.Fatalf("seed connection: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO mcp_tool_descriptors (id, connection_id, name, enabled)
		 VALUES ($1, $2, 'echo', true), ($3, $2, 'noisy', false)`,
		"mcpt-1-"+suffix, "mcpc-"+suffix, "mcpt-2-"+suffix); err != nil {
		t.Fatalf("seed descriptors: %v", err)
	}
	res = h.call("GET", "/mcp/connections", nil, "")
	if res.status != 200 {
		t.Fatalf("mcp list: %d %+v", res.status, res.body)
	}
	listed := fmt.Sprint(res.body["connections"])
	if !strings.Contains(listed, "f1sweep") || !strings.Contains(listed, "toolCount:2") ||
		!strings.Contains(listed, "enabledToolCount:1") {
		t.Fatalf("mcp list must carry descriptor counts: %s", listed)
	}
}
