package upstream

import "testing"

// The pure parse table: Statuspage components + indicator, custom feed,
// http probe — and every FAIL-OPEN reason.
func TestParseFeed(t *testing.T) {
	statuspage := map[string]any{
		"components": []any{
			map[string]any{"name": "API", "status": "operational"},
			map[string]any{"name": "Webhooks", "status": "partial_outage"},
		},
	}
	result := ParseFeed("statuspage_io", []string{"api", "Webhooks"}, statuspage, 0)
	if !result.OK || result.Status != "partial_outage" || !result.Degraded || len(result.Components) != 2 {
		t.Fatalf("component parse: %+v", result)
	}
	// Worst-wins rollup, case-insensitive matching.
	if result.Components[0].Status != "operational" {
		t.Fatalf("per-component detail: %+v", result.Components)
	}
	// A declared component missing from the feed is operator drift → fail-open.
	if result = ParseFeed("statuspage_io", []string{"Ghost"}, statuspage, 0); result.OK || result.Reason != "component_not_found" {
		t.Fatalf("missing component: %+v", result)
	}
	// Page-level indicator (status.json shape).
	indicator := map[string]any{"status": map[string]any{"indicator": "minor"}}
	if result = ParseFeed("atlassian_statuspage", nil, indicator, 0); !result.OK ||
		result.Status != "degraded_performance" || !result.Degraded {
		t.Fatalf("indicator parse: %+v", result)
	}
	// under_maintenance is healthy for pause purposes.
	maintenance := map[string]any{"status": map[string]any{"indicator": "maintenance"}}
	if result = ParseFeed("statuspage_io", nil, maintenance, 0); !result.OK || result.Degraded {
		t.Fatalf("maintenance must not pause: %+v", result)
	}

	// custom_feed: top-level status; unknown vocabulary → no_status.
	if result = ParseFeed("custom_feed", nil, map[string]any{"status": "major_outage"}, 0); !result.OK || !result.Degraded {
		t.Fatalf("custom feed: %+v", result)
	}
	if result = ParseFeed("custom_feed", nil, map[string]any{"status": "weird"}, 0); result.OK || result.Reason != "no_status" {
		t.Fatalf("unknown custom status must fail open: %+v", result)
	}

	// http_probe: 2xx healthy, anything else degraded.
	if result = ParseFeed("http_probe", nil, nil, 204); !result.OK || result.Degraded {
		t.Fatalf("probe 2xx: %+v", result)
	}
	if result = ParseFeed("http_probe", nil, nil, 503); !result.OK || !result.Degraded || result.Status != "major_outage" {
		t.Fatalf("probe 503: %+v", result)
	}

	// Unreadable bodies + unknown kinds all fail open.
	if result = ParseFeed("statuspage_io", nil, "not-json-object", 0); result.OK {
		t.Fatalf("unparseable must fail open: %+v", result)
	}
	if result = ParseFeed("carrier_pigeon", nil, nil, 0); result.OK || result.Reason != "unsupported_kind" {
		t.Fatalf("unsupported kind: %+v", result)
	}
}
