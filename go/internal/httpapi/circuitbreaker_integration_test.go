//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The full breaker loop: a consecutive-failure streak trips EXACTLY one
// pause (CAS + audit), /start rejects with the breaker code, inbound
// trigger events buffer, the resume is manual, and the backfill drains
// the buffered events OLDEST-FIRST through the ordinary claim machinery.
func TestCircuitBreakerLoop(t *testing.T) {
	h := newAPIHarness(t)
	wfID := fmt.Sprintf("wf-breaker-%d", time.Now().UnixNano())
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()

	workflow := map[string]any{
		"id": wfID, "name": "Breaker", "dslVersion": "1.0",
		"recovery": map[string]any{"circuitBreaker": 3},
		"nodes": []any{
			map[string]any{"id": "hook", "type": "webhook_received", "config": map[string]any{
				"endpointKey": "brk-hook",
			}},
			map[string]any{"id": "call", "type": "http", "config": map[string]any{
				"url": upstream.URL, "timeoutMs": 500,
			}},
		},
		"edges": []any{map[string]any{"from": "hook", "to": "call"}},
	}
	if res := h.call("POST", "/workflows/save", workflow, ""); res.status != 200 && res.status != 201 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}

	// 1. Three consecutive failed runs trip the breaker exactly once.
	for i := 0; i < 3; i++ {
		res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
		if res.status != 200 && res.status != 201 {
			t.Fatalf("start %d: %d %+v", i, res.status, res.body)
		}
		h.waitRun(extractRunID(t, res), "failed")
	}
	var status, reason string
	deadline := 50
	for ; deadline > 0; deadline-- {
		_ = pool.QueryRow(ctx, `SELECT status, COALESCE(paused_reason,'') FROM workflows
			WHERE org_id = $1 AND id = $2`, h.org, wfID).Scan(&status, &reason)
		if status == "paused_circuit_breaker" {
			break
		}
	}
	if status != "paused_circuit_breaker" || reason == "" {
		t.Fatalf("streak must trip the pause: %s/%q", status, reason)
	}
	var trips int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1
		AND action = 'workflow.circuit_breaker.tripped'`, h.org).Scan(&trips)
	if trips != 1 {
		t.Fatalf("exactly one trip audit: %d", trips)
	}

	// 2. /start rejects with the breaker's own code.
	res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	if res.status != 409 {
		t.Fatalf("paused start must 409: %d %+v", res.status, res.body)
	}

	// 3. Inbound trigger events BUFFER (202) while paused — oldest first.
	for i := 0; i < 3; i++ {
		res = h.call("POST", "/v1/webhooks/"+wfID, map[string]any{
			"endpointKey": "brk-hook", "eventId": fmt.Sprintf("evt-id-%d", i),
			"payload": map[string]any{"orden": fmt.Sprintf("evt-%d", i)},
		}, "")
		if res.status != 202 {
			t.Fatalf("paused trigger must buffer: %d %+v", res.status, res.body)
		}
	}
	var buffered int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM trigger_events WHERE org_id = $1 AND status = 'buffered'`, h.org).Scan(&buffered)
	if buffered != 3 {
		t.Fatalf("three buffered events: %d", buffered)
	}

	// 4. Resume against a NON-paused workflow rejects with 409/404.
	if res = h.call("POST", "/workflows/wf-fantasma/resume", map[string]any{}, ""); res.status != 404 {
		t.Fatalf("unknown resume: %d", res.status)
	}

	// 5. The manual resume flips + audits + backfills OLDEST-FIRST.
	res = h.call("POST", "/workflows/"+wfID+"/resume", map[string]any{}, "")
	if res.status != 200 || res.body["backfilled"] != float64(3) {
		t.Fatalf("resume+backfill: %d %+v", res.status, res.body)
	}
	_ = pool.QueryRow(ctx, `SELECT status FROM workflows WHERE org_id = $1 AND id = $2`, h.org, wfID).Scan(&status)
	if status != "active" {
		t.Fatalf("resume must activate: %s", status)
	}
	var resumeAudits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1
		AND action = 'workflow.circuit_breaker.resumed'`, h.org).Scan(&resumeAudits)
	if resumeAudits != 1 {
		t.Fatalf("resume audit: %d", resumeAudits)
	}
	// The backfilled runs exist and consumed their events oldest-first:
	// every buffered event now carries a run and none remain buffered.
	var remaining int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM trigger_events WHERE org_id = $1 AND status = 'buffered'`, h.org).Scan(&remaining)
	if remaining != 0 {
		t.Fatalf("backfill must drain: %d", remaining)
	}
	rows, err := pool.Query(ctx, `SELECT te.payload_json->'event'->'payload'->>'orden' FROM trigger_events te
		JOIN runs r ON r.id = te.run_id
		WHERE te.org_id = $1 AND te.run_id IS NOT NULL ORDER BY te.created_at ASC`, h.org)
	if err != nil {
		t.Fatalf("read backfilled: %v", err)
	}
	defer rows.Close()
	var order []string
	for rows.Next() {
		var orden string
		_ = rows.Scan(&orden)
		order = append(order, orden)
	}
	if len(order) != 3 || order[0] != "evt-0" || order[2] != "evt-2" {
		t.Fatalf("oldest-first order: %v", order)
	}

	// 6. A second resume of the ACTIVE workflow reports the no-op cleanly.
	res = h.call("POST", "/workflows/"+wfID+"/resume", map[string]any{}, "")
	if res.status != 200 || res.body["backfilled"] != float64(0) {
		t.Fatalf("idempotent resume drain: %d %+v", res.status, res.body)
	}
}
