//go:build integration

package httpapi

import (
	"fmt"
	"testing"
)

// The per-trigger storm guard end to end proves the compatibility contract:
// a trigger over its configured rateLimitPerMin marks the event skipped,
// audits trigger.event.skipped, and answers 429 with the reference's
// exact body — while a distinct trigger keeps its own budget.
func TestWebhookStormGuardSkipsOverLimit(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	wfID := "wf-storm-" + h.org

	// rateLimitPerMin 2: the third distinct event inside the window skips.
	doc := map[string]any{
		"id": wfID, "name": "Storm Guard",
		"nodes": []any{
			map[string]any{"id": "hook", "type": "webhook_received", "config": map[string]any{
				"endpointKey": "storm", "rateLimitPerMin": float64(2),
			}},
			map[string]any{"id": "shape", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"via": "{{context.input.event.endpointKey}}"},
			}},
		},
		"edges": []any{map[string]any{"from": "hook", "to": "shape"}},
	}
	if res := h.call("POST", "/v1/workflows/save", doc, ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}

	ingest := func(eventID string) apiResponse {
		return h.call("POST", "/v1/webhooks/"+wfID, map[string]any{
			"endpointKey": "storm", "eventId": eventID,
		}, "")
	}
	for i := range 2 {
		if res := ingest(fmt.Sprintf("evt-%d", i)); res.status != 200 {
			t.Fatalf("event %d must start: %d %+v", i, res.status, res.body)
		}
	}
	skipped := ingest("evt-over")
	if skipped.status != 429 {
		t.Fatalf("over-limit must 429: %d %+v", skipped.status, skipped.body)
	}
	data := skipped.body["data"].(map[string]any)
	if data["ok"] != false || data["skipped"] != true || data["reason"] != "rate_limited" || data["triggerEventId"] == nil {
		t.Fatalf("skip body must match the reference: %+v", data)
	}

	// The event row is persisted as skipped — the payload is never lost
	// silently, and the audit row carries the effective limit.
	var evStatus, reason string
	if err := pool.QueryRow(t.Context(),
		`SELECT status, skipped_reason FROM trigger_events WHERE org_id = $1 AND id = $2`,
		h.org, data["triggerEventId"]).Scan(&evStatus, &reason); err != nil || evStatus != "skipped" || reason != "rate_limited" {
		t.Fatalf("skipped row: %v %s %s", err, evStatus, reason)
	}
	var audited int
	_ = pool.QueryRow(t.Context(), `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'trigger.event.skipped'
		  AND metadata @> '{"reason":"rate_limited","ratePerMin":2}'`, h.org).Scan(&audited)
	if audited != 1 {
		t.Fatalf("trigger.event.skipped must audit once with the limit: %d", audited)
	}

	// A different trigger (its own bucket) is unaffected by the storm.
	otherID := "wf-storm-other-" + h.org
	other := map[string]any{
		"id": otherID, "name": "Other Trigger",
		"nodes": []any{map[string]any{"id": "hook", "type": "webhook_received",
			"config": map[string]any{"endpointKey": "calm"}}},
		"edges": []any{},
	}
	if res := h.call("POST", "/v1/workflows/save", other, ""); res.status != 200 {
		t.Fatalf("save other: %+v", res.body)
	}
	if res := h.call("POST", "/v1/webhooks/"+otherID, map[string]any{
		"endpointKey": "calm", "eventId": "evt-1",
	}, ""); res.status != 200 {
		t.Fatalf("independent trigger must pass: %d %+v", res.status, res.body)
	}
}
