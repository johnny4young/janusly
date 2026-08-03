//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// The alerting pipeline end to end: policy CRUD with 422/409 contracts,
// the dlq.entry_created producer firing through the SSRF-guarded webhook
// channel, honest per-channel results, cooldown dedupe, the parameter
// filter, the recovery_item.created producer, and disable/delete.
func TestAlertingPipeline(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())

	var webhookHits atomic.Int64
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webhookHits.Add(1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer receiver.Close()
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer broken.Close()

	// 422 with the structured error list; then a valid create; then 409.
	res := h.call("POST", "/alerts/policies", map[string]any{
		"name": "bad", "trigger": "nope", "channels": []any{},
	}, "")
	if res.status != 422 || res.body["code"] != "alert_policy_invalid" {
		t.Fatalf("invalid policy: %d %+v", res.status, res.body)
	}
	res = h.call("POST", "/alerts/policies", map[string]any{
		"name": "dlq-alert", "trigger": "dlq.entry_created",
		"channels": []any{
			map[string]any{"type": "webhook", "params": map[string]any{"url": receiver.URL}},
			map[string]any{"type": "slack", "params": map[string]any{"channel": "#oncall"}},
		},
		"cooldownSeconds": 60,
	}, "")
	if res.status != 200 {
		t.Fatalf("create policy: %d %+v", res.status, res.body)
	}
	policyID := res.body["policy"].(map[string]any)["id"].(string)
	if res = h.call("POST", "/alerts/policies", map[string]any{
		"name": "dlq-alert", "trigger": "dlq.entry_created",
		"channels": []any{map[string]any{"type": "webhook", "params": map[string]any{"url": receiver.URL}}},
	}, ""); res.status != 409 {
		t.Fatalf("duplicate name must 409: %d", res.status)
	}
	// A second policy whose signature pattern can never match.
	res = h.call("POST", "/alerts/policies", map[string]any{
		"name": "never-matches", "trigger": "dlq.entry_created",
		"parameters": map[string]any{"errorSignaturePattern": "zz-no-such-signature-zz"},
		"channels":   []any{map[string]any{"type": "webhook", "params": map[string]any{"url": receiver.URL}}},
	}, "")
	if res.status != 200 {
		t.Fatalf("pattern policy: %d %+v", res.status, res.body)
	}

	workflowDoc := func(id string) map[string]any {
		return map[string]any{
			"id": id, "name": "Alerts", "dslVersion": "1.0",
			"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
				"url": broken.URL, "timeoutMs": 500,
			}}},
			"edges": []any{},
		}
	}
	runFailing := func(wfID string) string {
		res := h.call("POST", "/v1/start", map[string]any{"workflow": workflowDoc(wfID)}, "")
		runID := extractRunID(t, res)
		h.waitRun(runID, "failed")
		return runID
	}
	waitFor := func(what string, check func() bool) {
		deadline := time.Now().Add(10 * time.Second)
		for !check() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	dispatchCount := func() int {
		res := h.call("GET", "/alerts/recent", nil, "")
		return len(res.body["dispatches"].([]any))
	}

	// Producer 1: the dead letter fires the matching policy only; the
	// webhook delivers for real, the slack channel records the honest miss.
	runID := runFailing("wf-alert-a-" + suffix)
	waitFor("first dispatch", func() bool { return dispatchCount() == 1 && webhookHits.Load() >= 1 })
	res = h.call("GET", "/alerts/recent", nil, "")
	dispatch := res.body["dispatches"].([]any)[0].(map[string]any)
	if dispatch["policyId"] != policyID || dispatch["outcome"] != "delivered" {
		t.Fatalf("dispatch: %+v", dispatch)
	}
	results := dispatch["channelResults"].([]any)
	if results[0].(map[string]any)["status"] != "delivered" ||
		results[1].(map[string]any)["error"] != "dispatcher_unavailable" {
		t.Fatalf("channel results: %+v", results)
	}

	// Cooldown: the same workflow+node dedupe key inside 60s suppresses.
	_ = runFailing("wf-alert-a-" + suffix)
	time.Sleep(300 * time.Millisecond)
	if dispatchCount() != 1 {
		t.Fatalf("cooldown must suppress the repeat dispatch")
	}
	// A different workflow = a different dedupe key → fires again.
	_ = runFailing("wf-alert-b-" + suffix)
	waitFor("second dispatch", func() bool { return dispatchCount() == 2 })

	// Producer 2: the redrive-opened incident fires recovery_item.created
	// when the severity filter matches.
	res = h.call("POST", "/alerts/policies", map[string]any{
		"name": "p3-items", "trigger": "recovery_item.created",
		"parameters": map[string]any{"severities": []any{"p3"}},
		"channels":   []any{map[string]any{"type": "webhook", "params": map[string]any{"url": receiver.URL}}},
	}, "")
	if res.status != 200 {
		t.Fatalf("item policy: %d %+v", res.status, res.body)
	}
	var dlqID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&dlqID)
	if res = h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": dlqID}, ""); res.status != 200 {
		t.Fatalf("replay: %d", res.status)
	}
	waitFor("item dispatch", func() bool { return dispatchCount() == 3 })

	// Disable stops future fires; delete removes; a second delete is 404.
	if res = h.call("POST", "/alerts/policies/"+policyID, map[string]any{"enabled": false}, ""); res.status != 200 ||
		res.body["policy"].(map[string]any)["enabled"] != false {
		t.Fatalf("disable: %d %+v", res.status, res.body)
	}
	_ = runFailing("wf-alert-c-" + suffix)
	time.Sleep(300 * time.Millisecond)
	if dispatchCount() != 3 {
		t.Fatalf("disabled policy must not fire")
	}
	if res = h.call("DELETE", "/alerts/policies/"+policyID, nil, ""); res.status != 200 {
		t.Fatalf("delete: %d", res.status)
	}
	if res = h.call("DELETE", "/alerts/policies/"+policyID, nil, ""); res.status != 404 {
		t.Fatalf("double delete must 404: %d", res.status)
	}
}
