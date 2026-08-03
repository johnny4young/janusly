//go:build integration

package httpapi

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func webhookWorkflow(id, endpointKey string) map[string]any {
	return map[string]any{
		"id":   id,
		"name": "webhook flow",
		"nodes": []any{
			map[string]any{"id": "inbox", "type": "webhook_received",
				"config": map[string]any{"endpointKey": endpointKey}},
			map[string]any{"id": "shape", "type": "transform",
				"config": map[string]any{"mapping": map[string]any{
					"total": "{{context.inbox.output.event.payload.total}}",
					"via":   "{{context.inbox.output.triggeredBy}}",
				}}},
		},
		"edges": []any{map[string]any{"from": "inbox", "to": "shape"}},
	}
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), os.Getenv("JANUSLY_GO_DATABASE_URL"))
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestWebhookIngestSpawnsOneConvergentRun(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	wfID := "wf-hook-" + h.org
	if res := h.call("POST", "/v1/workflows/save", webhookWorkflow(wfID, "Orders.v1"), ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}

	event := map[string]any{
		"endpointKey": "orders.V1", // case-insensitive match is part of the contract
		"eventId":     "evt-1",
		"eventType":   "order.created",
		"payload":     map[string]any{"total": 99.5},
	}
	res := h.call("POST", "/v1/webhooks/"+wfID, event, "")
	if res.status != 200 {
		t.Fatalf("ingest: %d %+v", res.status, res.body)
	}
	requireEnvelope(t, res)
	data := res.body["data"].(map[string]any)
	if data["ok"] != true || data["runId"] == nil || data["triggerEventId"] == nil {
		t.Fatalf("ingest body: %+v", data)
	}
	runID := data["runId"].(string)
	h.waitRun(runID, "succeeded")

	// The trigger executor passes the normalized event through to templates.
	status := h.call("GET", "/v1/run?runId="+runID, nil, "")
	nodes := status.body["data"].(map[string]any)["nodes"].([]any)
	var shaped map[string]any
	for _, raw := range nodes {
		node := raw.(map[string]any)
		if node["nodeId"] == "shape" {
			state := node["stateJson"].(map[string]any)
			shaped = state["output"].(map[string]any)
		}
	}
	if shaped["total"] != 99.5 || shaped["via"] != "webhook_received" {
		t.Fatalf("downstream template must read the event: %+v", shaped)
	}

	// The replay anchor row landed and the start claim bound it to the run.
	var evStatus, evRunID string
	err := pool.QueryRow(context.Background(),
		`SELECT status, run_id FROM trigger_events WHERE org_id = $1 AND id = $2`,
		h.org, data["triggerEventId"]).Scan(&evStatus, &evRunID)
	if err != nil || evStatus != "started" || evRunID != runID {
		t.Fatalf("trigger event row: %v %s %s", err, evStatus, evRunID)
	}

	// A relay retry with the same eventId converges: duplicate, same run.
	retry := h.call("POST", "/v1/webhooks/"+wfID, event, "")
	retryData := retry.body["data"].(map[string]any)
	if retryData["duplicate"] != true || retryData["runId"] != runID {
		t.Fatalf("retry must converge: %+v", retryData)
	}
	var runCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM runs WHERE org_id = $1`, h.org).Scan(&runCount); err != nil || runCount != 1 {
		t.Fatalf("one run total, got %d (%v)", runCount, err)
	}

	// One received + one started audit row; the converged relay retry never
	// re-audits, and a trigger start is NOT an adhoc run start.
	for action, want := range map[string]int{
		"trigger.event.received": 1,
		"trigger.event.started":  1,
		"run.started.adhoc":      0,
	} {
		if got := countAudit(t, pool, h.org, action); got != want {
			t.Fatalf("%s: want %d rows, got %d", action, want, got)
		}
	}
}

func TestWebhookLegacySelectorResolvesOneActiveWorkflow(t *testing.T) {
	h := newAPIHarness(t)
	invalid := h.call("POST", "/triggers/webhook/ingest", map[string]any{"eventId": "missing-selector"}, "")
	if invalid.status != 400 || invalid.body["code"] != "trigger_invalid_payload" {
		t.Fatalf("legacy validation must precede selector resolution: %d %+v", invalid.status, invalid.body)
	}

	wfID := "wf-hook-selector-" + h.org
	if res := h.call("POST", "/v1/workflows/save", webhookWorkflow(wfID, "Alerts.v1"), ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}

	event := map[string]any{
		"endpointKey": "alerts.V1",
		"eventId":     "selector-event-1",
		"eventType":   "alert.opened",
		"payload":     map[string]any{"total": 7.0},
	}
	res := h.call("POST", "/triggers/webhook/ingest", event, "")
	if res.status != 200 || res.body["ok"] != true || res.body["runId"] == nil || res.body["triggerEventId"] == nil {
		t.Fatalf("legacy ingest: %d %+v", res.status, res.body)
	}
	runID := res.body["runId"].(string)
	h.waitRun(runID, "succeeded")

	retry := h.call("POST", "/triggers/webhook/ingest", event, "")
	if retry.status != 200 || retry.body["duplicate"] != true || retry.body["runId"] != runID {
		t.Fatalf("legacy retry must converge: %d %+v", retry.status, retry.body)
	}

	otherID := "wf-hook-selector-ambiguous-" + h.org
	if saved := h.call("POST", "/v1/workflows/save", webhookWorkflow(otherID, "ALERTS.V1"), ""); saved.status != 200 {
		t.Fatalf("save ambiguous workflow: %+v", saved.body)
	}
	ambiguous := h.call("POST", "/triggers/webhook/ingest", map[string]any{
		"endpointKey": "alerts.v1", "eventId": "selector-event-2",
	}, "")
	if ambiguous.status != 409 || ambiguous.body["code"] != "trigger_selector_ambiguous" {
		t.Fatalf("org-wide ambiguity: %d %+v", ambiguous.status, ambiguous.body)
	}
}

func TestWebhookIngestContractErrors(t *testing.T) {
	h := newAPIHarness(t)
	wfID := "wf-hookerr-" + h.org
	if res := h.call("POST", "/v1/workflows/save", webhookWorkflow(wfID, "billing"), ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}

	cases := []struct {
		name   string
		path   string
		body   map[string]any
		org    string
		status int
		code   string
	}{
		{"missing eventId", "/v1/webhooks/" + wfID,
			map[string]any{"endpointKey": "billing"}, "", 400, "trigger_invalid_payload"},
		{"wrong endpoint key", "/v1/webhooks/" + wfID,
			map[string]any{"endpointKey": "other", "eventId": "e1"}, "", 404, "trigger_no_matching_node"},
		{"unknown workflow", "/v1/webhooks/wf-nope",
			map[string]any{"endpointKey": "billing", "eventId": "e1"}, "", 404, "trigger_no_matching_node"},
		{"cross-org workflow", "/v1/webhooks/" + wfID,
			map[string]any{"endpointKey": "billing", "eventId": "e1"}, "other-org-" + h.org, 404, "trigger_no_matching_node"},
	}
	for _, tc := range cases {
		res := h.call("POST", tc.path, tc.body, tc.org)
		errBody, _ := res.body["error"].(map[string]any)
		if res.status != tc.status || errBody == nil || errBody["code"] != tc.code {
			t.Fatalf("%s: got %d %+v", tc.name, res.status, res.body)
		}
	}

	// Two nodes matching one endpoint key is ambiguous — 409, no event row.
	ambiguous := webhookWorkflow("wf-hookamb-"+h.org, "dup")
	ambiguous["nodes"] = append(ambiguous["nodes"].([]any),
		map[string]any{"id": "inbox2", "type": "webhook_received",
			"config": map[string]any{"endpointKey": "DUP"}})
	if res := h.call("POST", "/v1/workflows/save", ambiguous, ""); res.status != 200 {
		t.Fatalf("save ambiguous: %+v", res.body)
	}
	res := h.call("POST", "/v1/webhooks/wf-hookamb-"+h.org,
		map[string]any{"endpointKey": "dup", "eventId": "e1"}, "")
	errBody, _ := res.body["error"].(map[string]any)
	if res.status != 409 || errBody["code"] != "trigger_selector_ambiguous" {
		t.Fatalf("ambiguous: %d %+v", res.status, res.body)
	}

	// A soft-deleted workflow is indistinguishable from no matching trigger.
	if res := h.call("DELETE", "/workflows/"+wfID, nil, ""); res.status != 200 {
		t.Fatalf("delete: %+v", res.body)
	}
	res = h.call("POST", "/v1/webhooks/"+wfID,
		map[string]any{"endpointKey": "billing", "eventId": "e2"}, "")
	if res.status != 404 {
		t.Fatalf("tombstoned ingest: %d %+v", res.status, res.body)
	}
}

func TestWebhookIngestBuffersOnPausedWorkflow(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	wfID := "wf-hookpause-" + h.org
	if res := h.call("POST", "/v1/workflows/save", webhookWorkflow(wfID, "pagers"), ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE workflows SET status = 'paused_circuit_breaker' WHERE id = $1`, wfID); err != nil {
		t.Fatalf("pause: %v", err)
	}

	res := h.call("POST", "/v1/webhooks/"+wfID,
		map[string]any{"endpointKey": "pagers", "eventId": "e1"}, "")
	if res.status != 202 {
		t.Fatalf("buffered ingest status: %d %+v", res.status, res.body)
	}
	data := res.body["data"].(map[string]any)
	if data["buffered"] != true || data["reason"] != "paused_circuit_breaker" {
		t.Fatalf("buffered body: %+v", data)
	}
	var evStatus, reason string
	err := pool.QueryRow(context.Background(),
		`SELECT status, skipped_reason FROM trigger_events WHERE org_id = $1 AND id = $2`,
		h.org, data["triggerEventId"]).Scan(&evStatus, &reason)
	if err != nil || evStatus != "buffered" || reason != "paused_circuit_breaker" {
		t.Fatalf("buffered row: %v %s %s", err, evStatus, reason)
	}
	var runCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM runs WHERE org_id = $1`, h.org).Scan(&runCount); err != nil || runCount != 0 {
		t.Fatalf("paused workflow must not spawn runs, got %d (%v)", runCount, err)
	}
	if got := countAudit(t, pool, h.org, "trigger.event.buffered"); got != 1 {
		t.Fatalf("trigger.event.buffered: want 1 row, got %d", got)
	}
}

func TestManualStartOfTriggerWorkflowRunsWithEmptyEvent(t *testing.T) {
	h := newAPIHarness(t)
	res := h.call("POST", "/v1/start", map[string]any{
		"workflow": webhookWorkflow(fmt.Sprintf("wf-hookman-%s-%d", h.org, time.Now().UnixNano()), "manual"),
	}, "")
	if res.status != 200 {
		t.Fatalf("manual start: %d %+v", res.status, res.body)
	}
	runID := res.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "succeeded")

	status := h.call("GET", "/v1/run?runId="+runID, nil, "")
	for _, raw := range status.body["data"].(map[string]any)["nodes"].([]any) {
		node := raw.(map[string]any)
		if node["nodeId"] == "inbox" {
			state := node["stateJson"].(map[string]any)
			output := state["output"].(map[string]any)
			event, ok := output["event"].(map[string]any)
			if !ok || len(event) != 0 || output["triggeredBy"] != "webhook_received" {
				t.Fatalf("manual trigger output: %+v", output)
			}
		}
	}
}

func TestFailureClustersRollup(t *testing.T) {
	h := newAPIHarness(t)
	// One run whose http node fails against a dead upstream → both a failed
	// run_nodes row AND a dead_letters row for the same (run, node).
	doc := map[string]any{
		"id":   "wf-cluster-" + h.org,
		"name": "Cluster Flow",
		"nodes": []any{map[string]any{"id": "call", "type": "http",
			"config": map[string]any{"url": "http://127.0.0.1:1", "timeoutMs": float64(300)}}},
		"edges": []any{},
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": doc}, "")
	if res.status != 200 {
		t.Fatalf("start: %+v", res.body)
	}
	runID := res.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "failed")

	clusters := h.call("GET", "/v1/dlq/clusters?windowDays=7", nil, "")
	requireEnvelope(t, clusters)
	data := clusters.body["data"].(map[string]any)
	if data["windowDays"] != float64(7) || data["totalSamples"] != float64(2) {
		t.Fatalf("raw sample accounting: %+v", data)
	}
	rows := data["clusters"].([]any)
	if len(rows) != 1 {
		t.Fatalf("dual-surface samples must collapse to one cluster: %+v", rows)
	}
	top := rows[0].(map[string]any)
	// The harness blocks private targets, so the failure is the SSRF guard
	// — the signature rules classify it as an HTTP-layer guard failure.
	if top["frequency"] != float64(1) || top["signature"] != "HTTP guard failed on http node" {
		t.Fatalf("cluster shape: %+v", top)
	}
	workflows := top["affectedWorkflows"].([]any)
	if workflows[0].(map[string]any)["workflowName"] != "Cluster Flow" {
		t.Fatalf("workflow identity: %+v", workflows)
	}
	samples := top["samples"].([]any)
	if samples[0].(map[string]any)["source"] != "dead_letter" {
		t.Fatalf("DLQ sample must win dedup: %+v", samples)
	}

	// Legacy wire returns the same raw object, no envelope.
	legacy := h.call("GET", "/dlq/clusters", nil, "")
	if legacy.status != 200 || legacy.body["apiVersion"] != nil || legacy.body["clusters"] == nil {
		t.Fatalf("legacy clusters: %+v", legacy.body)
	}
}

// Cursor round-trip parity: pages via the minted cursor reassemble the
// exact ascending timeline with no skips or repeats — including events
// sharing one millisecond (events are WRITTEN at ms precision, so the
// ms-ISO cursor both backends mint compares exactly).
func TestEventsCursorRoundTrip(t *testing.T) {
	h := newAPIHarness(t)
	doc := map[string]any{
		"id": "wf-cursor-" + h.org,
		"nodes": []any{
			map[string]any{"id": "a", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "b", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "c", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{
			map[string]any{"from": "a", "to": "b"},
			map[string]any{"from": "b", "to": "c"},
		},
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": doc}, "")
	runID := res.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "succeeded")

	full := h.call("GET", "/v1/run?runId="+runID+"&eventsLimit=500", nil, "")
	allEvents := full.body["data"].(map[string]any)["events"].([]any)
	if len(allEvents) < 6 {
		t.Fatalf("timeline too small: %d", len(allEvents))
	}
	ids := func(events []any) []string {
		out := make([]string, 0, len(events))
		for _, raw := range events {
			out = append(out, raw.(map[string]any)["id"].(string))
		}
		return out
	}
	want := ids(allEvents)

	// Walk pages of 2 via the minted cursor; verify the ms-ISO shape.
	var got []string
	cursor := ""
	for {
		url := "/v1/run?runId=" + runID + "&eventsLimit=2"
		if cursor != "" {
			url += "&eventsCursor=" + strings.ReplaceAll(cursor, "|", "%7C")
		}
		page := h.call("GET", url, nil, "")
		data := page.body["data"].(map[string]any)
		got = append(ids(data["events"].([]any)), got...)
		next, _ := data["eventsCursor"].(string)
		if data["eventsHasMore"] != true {
			break
		}
		at, _, _ := strings.Cut(next, "|")
		if !strings.HasSuffix(at, "Z") || len(at) != len("2006-01-02T15:04:05.000Z") {
			t.Fatalf("cursor must be millisecond ISO: %q", next)
		}
		cursor = next
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("pages must reassemble the timeline\n got: %v\nwant: %v", got, want)
	}

	// Same-millisecond collision: two synthetic events sharing one ms
	// timestamp must page through by the id tiebreaker without loss.
	pool := testPool(t)
	at := "2026-07-30T00:00:00.123Z"
	prefix := fmt.Sprintf("0-collide-%d-", time.Now().UnixNano())
	for _, id := range []string{prefix + "a", prefix + "b"} {
		if _, err := pool.Exec(context.Background(),
			`INSERT INTO run_events (id, run_id, type, payload, created_at)
			 VALUES ($1, $2, 'probe', '{}'::jsonb, $3::timestamptz)`, id, runID, at); err != nil {
			t.Fatalf("seed collision: %v", err)
		}
	}
	page := h.call("GET", "/v1/run?runId="+runID+"&eventsCursor="+at+"%7C"+prefix+"b&eventsLimit=1", nil, "")
	events := page.body["data"].(map[string]any)["events"].([]any)
	if len(events) != 1 || events[0].(map[string]any)["id"] != prefix+"a" {
		t.Fatalf("id tiebreaker must order the same-ms pair: %+v", events)
	}
}
