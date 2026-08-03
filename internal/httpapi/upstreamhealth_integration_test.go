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

// The upstream-health loop: a degraded probe pauses the tagged workflow
// (auto-pause), /start rejects with the upstream_degraded row of the pause
// table while trigger ingest BUFFERS, a recovered probe resumes, and a
// fail-open (unreachable feed) never pauses anything.
func TestUpstreamHealthPauseResumeLoop(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())

	// A status endpoint we can flip between healthy and down.
	var healthy atomic.Bool
	healthy.Store(true)
	feed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if healthy.Load() {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer feed.Close()

	sourceName := "billing-api-" + suffix
	res := h.call("POST", "/upstream/sources", map[string]any{
		"source": map[string]any{
			"name": sourceName, "kind": "http_probe", "url": feed.URL,
			"checkIntervalSeconds": 30,
		},
	}, "")
	if res.status != 201 {
		t.Fatalf("create source: %d %+v", res.status, res.body)
	}
	sourceID := res.body["source"].(map[string]any)["id"].(string)

	// A workflow SUBSCRIBED to the source via the save-body tag list.
	wfID := "wf-upstream-" + suffix
	workflow := map[string]any{
		"id": wfID, "name": "Billing sync", "dslVersion": "1.0",
		"upstreamHealthSources": []any{sourceName},
		"nodes": []any{
			map[string]any{"id": "inbox", "type": "webhook_received",
				"config": map[string]any{"endpointKey": "billing-" + suffix}},
			map[string]any{"id": "step", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "inbox", "to": "step"}},
	}
	if res := h.call("POST", "/v1/workflows/save", workflow, ""); res.status != 200 {
		t.Fatalf("save: %+v", res.body)
	}

	check := func() map[string]any {
		res := h.call("POST", "/upstream/sources/"+sourceID+"/check", nil, "")
		if res.status != 200 {
			t.Fatalf("check now: %d %+v", res.status, res.body)
		}
		return res.body
	}
	workflowStatus := func() string {
		var status string
		_ = pool.QueryRow(ctx, `SELECT status FROM workflows WHERE id = $1`, wfID).Scan(&status)
		return status
	}

	// Healthy probe: nothing pauses.
	if body := check(); body["degraded"] != false {
		t.Fatalf("healthy probe: %+v", body)
	}
	if workflowStatus() != "active" {
		t.Fatalf("workflow must stay active: %s", workflowStatus())
	}

	// Degraded probe: the tagged workflow auto-pauses, audited once.
	healthy.Store(false)
	body := check()
	if body["degraded"] != true || len(body["pausedWorkflowIds"].([]any)) != 1 {
		t.Fatalf("degraded probe must pause: %+v", body)
	}
	if workflowStatus() != "paused_upstream_degraded" {
		t.Fatalf("workflow must be paused: %s", workflowStatus())
	}
	// Idempotent: a second degraded poll flips nothing new.
	if body = check(); len(body["pausedWorkflowIds"].([]any)) != 0 {
		t.Fatalf("second degraded poll must not re-flip: %+v", body)
	}
	var pauseAudits int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'workflow.paused.upstream' AND target_id = $2`,
		h.org, wfID).Scan(&pauseAudits)
	if pauseAudits != 1 {
		t.Fatalf("exactly one pause audit: %d", pauseAudits)
	}

	// The pause table: /start REJECTS naming the upstream cause…
	res = h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	if res.status != 409 || res.body["error"].(map[string]any)["code"] != "upstream_degraded" {
		t.Fatalf("/start must reject upstream_degraded: %d %+v", res.status, res.body)
	}
	// …while an inbound trigger event BUFFERS (202).
	res = h.call("POST", "/v1/webhooks/"+wfID, map[string]any{
		"endpointKey": "billing-" + suffix, "eventId": "evt-paused-" + suffix,
	}, "")
	if res.status != 202 || res.body["data"].(map[string]any)["buffered"] != true {
		t.Fatalf("trigger must buffer while paused: %d %+v", res.status, res.body)
	}

	// FAIL-OPEN: an unreachable feed must not change the pause state — and
	// on a HEALTHY workflow it must never pause. Point the source at a dead
	// port via update.
	if res := h.call("POST", "/upstream/sources/"+sourceID, map[string]any{
		"source": map[string]any{
			"name": sourceName, "kind": "custom_feed", "url": "http://127.0.0.1:1",
			"checkIntervalSeconds": 30,
		},
	}, ""); res.status != 200 {
		t.Fatalf("update source: %d %+v", res.status, res.body)
	}
	if body = check(); body["failedOpen"] != true {
		t.Fatalf("unreachable feed must fail open: %+v", body)
	}
	if workflowStatus() != "paused_upstream_degraded" {
		t.Fatalf("fail-open must not move the pause state: %s", workflowStatus())
	}

	// Recovered probe: the workflow this source paused resumes.
	healthy.Store(true)
	if res := h.call("POST", "/upstream/sources/"+sourceID, map[string]any{
		"source": map[string]any{
			"name": sourceName, "kind": "http_probe", "url": feed.URL,
			"checkIntervalSeconds": 30,
		},
	}, ""); res.status != 200 {
		t.Fatalf("restore source: %d %+v", res.status, res.body)
	}
	body = check()
	if len(body["resumedWorkflowIds"].([]any)) != 1 {
		t.Fatalf("recovered probe must resume: %+v", body)
	}
	if workflowStatus() != "active" {
		t.Fatalf("workflow must be active again: %s", workflowStatus())
	}
	res = h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	if res.status != 200 {
		t.Fatalf("/start after resume: %d %+v", res.status, res.body)
	}
}
