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

// failRun starts a workflow whose http node fails against a blocked target,
// waits for the terminal failure, and returns its runId.
func failRun(t *testing.T, h *apiHarness, id string) string {
	t.Helper()
	doc := map[string]any{
		"id":   id,
		"name": "Campaign Flow",
		"nodes": []any{map[string]any{"id": "call", "type": "http",
			"config": map[string]any{"url": "http://127.0.0.1:1", "timeoutMs": float64(200)}}},
		"edges": []any{},
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": doc}, "")
	if res.status != 200 {
		t.Fatalf("start %s: %+v", id, res.body)
	}
	runID := res.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "failed")
	return runID
}

func deadLetterIDs(t *testing.T, h *apiHarness) []string {
	t.Helper()
	res := h.call("GET", "/v1/dlq?limit=50", nil, "")
	rows, _ := res.body["data"].([]any)
	ids := make([]string, 0, len(rows))
	for _, raw := range rows {
		ids = append(ids, raw.(map[string]any)["id"].(string))
	}
	return ids
}

func TestReplayCampaignLifecycle(t *testing.T) {
	h := newAPIHarness(t)
	failRun(t, h, "wf-camp-a-"+h.org)
	failRun(t, h, "wf-camp-b-"+h.org)
	ids := deadLetterIDs(t, h)
	if len(ids) != 2 {
		t.Fatalf("want 2 dead letters, got %v", ids)
	}

	// Preview resolves the cohort server-side: same signature, both open.
	preview := h.call("POST", "/recovery/campaigns/preview", map[string]any{"deadLetterIds": ids}, "")
	if preview.status != 200 || preview.body["canCreate"] != true {
		t.Fatalf("preview: %d %+v", preview.status, preview.body)
	}
	if preview.body["clusterSignature"] != "HTTP guard failed on http node" {
		t.Fatalf("cohort signature: %+v", preview.body)
	}

	// A single-item cohort can never be a campaign (minimum two).
	solo := h.call("POST", "/recovery/campaigns", map[string]any{
		"deadLetterIds": ids[:1], "name": "solo", "pacingMs": float64(1000),
	}, "")
	if solo.status != 409 || solo.body["code"] != "replay_campaign_invalid_cohort" {
		t.Fatalf("solo cohort must 409: %d %+v", solo.status, solo.body)
	}

	created := h.call("POST", "/recovery/campaigns", map[string]any{
		"deadLetterIds": ids, "name": "burst fix", "pacingMs": float64(1000),
	}, "")
	if created.status != 202 {
		t.Fatalf("create: %d %+v", created.status, created.body)
	}
	campaign := created.body["campaign"].(map[string]any)
	if campaign["totalCount"] != float64(2) || campaign["status"] != "running" ||
		created.body["publicationDeferred"] != false {
		t.Fatalf("created shape: %+v", created.body)
	}
	campaignID := campaign["id"].(string)
	if len(created.body["items"].([]any)) != 2 {
		t.Fatalf("items snapshot: %+v", created.body["items"])
	}

	// The pump drains one item per pacing period until completion. Two
	// items at 1s pacing finish comfortably inside the deadline.
	deadline := time.Now().Add(20 * time.Second)
	for {
		detail := h.call("GET", "/recovery/campaigns/"+campaignID, nil, "")
		status := detail.body["campaign"].(map[string]any)["status"]
		if status == "completed" {
			final := detail.body["campaign"].(map[string]any)
			if final["replayedCount"] != float64(2) || final["failedCount"] != float64(0) {
				t.Fatalf("final counters: %+v", final)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("campaign never completed: %+v", detail.body)
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Replayed dead letters are no longer open — a second campaign over the
	// same ids must reject the whole cohort.
	rePreview := h.call("POST", "/recovery/campaigns/preview", map[string]any{"deadLetterIds": ids}, "")
	if rePreview.body["canCreate"] != false {
		t.Fatalf("replayed rows must not be re-eligible: %+v", rePreview.body)
	}

	// List surfaces the campaign.
	list := h.call("GET", "/recovery/campaigns", nil, "")
	if rows := list.body["campaigns"].([]any); len(rows) != 1 {
		t.Fatalf("list: %+v", list.body)
	}
}

func TestReplayCampaignCancellation(t *testing.T) {
	h := newAPIHarness(t)
	for i := range 3 {
		failRun(t, h, fmt.Sprintf("wf-campcancel-%d-%s", i, h.org))
	}
	ids := deadLetterIDs(t, h)
	created := h.call("POST", "/recovery/campaigns", map[string]any{
		"deadLetterIds": ids, "name": "slow drain", "pacingMs": float64(60000),
	}, "")
	if created.status != 202 {
		t.Fatalf("create: %+v", created.body)
	}
	campaignID := created.body["campaign"].(map[string]any)["id"].(string)

	// With 60s pacing at most one item processes before the cancel lands.
	cancelled := h.call("POST", "/recovery/campaigns/"+campaignID+"/cancel", nil, "")
	if cancelled.status != 200 {
		t.Fatalf("cancel: %d %+v", cancelled.status, cancelled.body)
	}
	campaign := cancelled.body["campaign"].(map[string]any)
	if campaign["status"] != "cancelled" || campaign["cancelledBy"] != "api-tester" {
		t.Fatalf("cancelled shape: %+v", campaign)
	}

	// An item claimed before the cancel legitimately finishes AFTER it —
	// poll until every item settles, then the counters must be truthful.
	deadline := time.Now().Add(10 * time.Second)
	for {
		detail := h.call("GET", "/recovery/campaigns/"+campaignID, nil, "")
		final := detail.body["campaign"].(map[string]any)
		replayed := final["replayedCount"].(float64)
		failed := final["failedCount"].(float64)
		cancelledCount := final["cancelledCount"].(float64)
		if replayed+failed+cancelledCount == 3 {
			if cancelledCount < 2 {
				t.Fatalf("cancel must park the unclaimed majority: %+v", final)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("items never settled: %+v", final)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Cancelling again: 409 not-running; unknown id: 404.
	again := h.call("POST", "/recovery/campaigns/"+campaignID+"/cancel", nil, "")
	if again.status != 409 || again.body["code"] != "replay_campaign_not_running" {
		t.Fatalf("double cancel: %d %+v", again.status, again.body)
	}
	missing := h.call("POST", "/recovery/campaigns/nope/cancel", nil, "")
	if missing.status != 404 || missing.body["code"] != "replay_campaign_not_found" {
		t.Fatalf("missing cancel: %d %+v", missing.status, missing.body)
	}
}

// A real recovery cycle feeds the north star: fail → DLQ → heal upstream →
// redrive → verified success, measured detection → terminal success.
func TestVerifiedRecoveryMetrics(t *testing.T) {
	h := newAPIHarness(t)

	// Empty org: sample 0, null percentiles.
	empty := h.call("GET", "/v1/recovery/metrics", nil, "")
	requireEnvelope(t, empty)
	data := empty.body["data"].(map[string]any)
	vr := data["verifiedRecovery"].(map[string]any)
	if vr["sampleSize"] != float64(0) || vr["p50Ms"] != nil || data["mttrMs"] != nil {
		t.Fatalf("empty metrics: %+v", data)
	}

	// Healable upstream: fails until told otherwise.
	var healed atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if healed.Load() {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")

	doc := map[string]any{
		"id": "wf-vr-" + h.org,
		"nodes": []any{map[string]any{"id": "call", "type": "http",
			"config": map[string]any{"url": upstream.URL, "timeoutMs": float64(500)}}},
		"edges": []any{},
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": doc}, "")
	runID := res.body["data"].(map[string]any)["runId"].(string)
	h.waitRun(runID, "failed")

	healed.Store(true)
	ids := deadLetterIDs(t, h)
	if len(ids) != 1 {
		t.Fatalf("dead letters: %v", ids)
	}
	redrive := h.call("POST", "/v1/dlq/redrive", map[string]any{"deadLetterId": ids[0]}, "")
	if _, ok := redrive.body["data"]; !ok {
		t.Fatalf("redrive: %+v", redrive.body)
	}
	h.waitRun(runID, "succeeded")

	after := h.call("GET", "/recovery/metrics?windowDays=7", nil, "")
	if after.body["apiVersion"] != nil {
		t.Fatalf("legacy wire must be raw: %+v", after.body)
	}
	vr = after.body["verifiedRecovery"].(map[string]any)
	p50, _ := vr["p50Ms"].(float64)
	p90, _ := vr["p90Ms"].(float64)
	if vr["sampleSize"] != float64(1) || p50 <= 0 || p50 != p90 {
		t.Fatalf("north star: %+v", vr)
	}
	if mttr, _ := after.body["mttrMs"].(float64); mttr != p50 {
		t.Fatalf("legacy average with one sample must equal the median: %+v", after.body)
	}
}

// Server-side DLQ filters: status validated against the closed enum,
// nodeId exact, workflowId through the version join.
func TestDlqServerSideFilters(t *testing.T) {
	h := newAPIHarness(t)
	failRun(t, h, "wf-filter-a-"+h.org)
	failRun(t, h, "wf-filter-b-"+h.org)
	ids := deadLetterIDs(t, h)
	if len(ids) != 2 {
		t.Fatalf("seed: %v", ids)
	}
	// Replay one so the statuses diverge.
	if res := h.call("POST", "/v1/dlq/redrive", map[string]any{"deadLetterId": ids[0]}, ""); res.status != 200 {
		t.Fatalf("redrive: %+v", res.body)
	}

	rows := func(res apiResponse) []any {
		data, _ := res.body["data"].([]any)
		return data
	}
	if got := rows(h.call("GET", "/v1/dlq?status=open", nil, "")); len(got) != 1 {
		t.Fatalf("status=open: %+v", got)
	}
	if got := rows(h.call("GET", "/v1/dlq?status=replayed", nil, "")); len(got) != 1 {
		t.Fatalf("status=replayed: %+v", got)
	}
	if got := rows(h.call("GET", "/v1/dlq?nodeId=call", nil, "")); len(got) != 2 {
		t.Fatalf("nodeId=call: %+v", got)
	}
	if got := rows(h.call("GET", "/v1/dlq?nodeId=ghost", nil, "")); len(got) != 0 {
		t.Fatalf("nodeId=ghost: %+v", got)
	}
	if got := rows(h.call("GET", "/v1/dlq?workflowId=wf-filter-a-"+h.org, nil, "")); len(got) != 1 {
		t.Fatalf("workflowId: %+v", got)
	}
	combined := rows(h.call("GET", "/v1/dlq?workflowId=wf-filter-a-"+h.org+"&status=resolved", nil, ""))
	if len(combined) != 0 {
		t.Fatalf("combined filters: %+v", combined)
	}
	bad := h.call("GET", "/v1/dlq?status=bogus", nil, "")
	requireError(t, bad, 400, "dlq_invalid_status", "Invalid DLQ status")
}
