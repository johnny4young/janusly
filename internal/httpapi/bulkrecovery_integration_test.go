//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// The bulk recovery loop end to end: cluster members from the normalized
// signature, cluster-apply with an applied fix that actually heals the
// revived runs (snapshot swap), stale-member rejection, mixed-batch
// bulk-replay with the partial-success envelope, and resolve/bulk-resolve
// closing the linked incident as accepted_loss.
func TestBulkRecoverySurfaces(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-bulk-" + suffix

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer broken.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer healthy.Close()

	workflowDoc := func(url string) map[string]any {
		return map[string]any{
			"id": wfID, "name": "Bulk", "dslVersion": "1.0",
			"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
				"url": url, "timeoutMs": 500,
			}}},
			"edges": []any{},
		}
	}
	runFailing := func() (string, string) {
		res := h.call("POST", "/v1/start", map[string]any{"workflow": workflowDoc(broken.URL)}, "")
		runID := extractRunID(t, res)
		h.waitRun(runID, "failed")
		var dlqID string
		if err := pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
			runID).Scan(&dlqID); err != nil {
			t.Fatalf("dead letter for %s: %v", runID, err)
		}
		return runID, dlqID
	}
	run1, dlq1 := runFailing()
	run2, dlq2 := runFailing()
	_, dlq3 := runFailing()

	// The cluster rollup names the signature; members enumerate the ids.
	res := h.call("GET", "/dlq/clusters", nil, "")
	clusters := res.body["clusters"].([]any)
	if len(clusters) != 1 {
		t.Fatalf("one cluster expected: %+v", res.body)
	}
	sig := clusters[0].(map[string]any)["signature"].(string)
	res = h.call("GET", "/dlq/cluster-members?signature="+url.QueryEscape(sig), nil, "")
	if res.status != 200 || res.body["total"] != float64(3) || res.body["capped"] != false {
		t.Fatalf("members: %d %+v", res.status, res.body)
	}
	if len(res.body["deadLetterIds"].([]any)) != 3 {
		t.Fatalf("member ids: %+v", res.body)
	}
	if res = h.call("GET", "/dlq/cluster-members", nil, ""); res.status != 400 {
		t.Fatalf("missing signature must 400: %d", res.status)
	}

	// Shared body validation for the bulk loops.
	if res = h.call("POST", "/dlq/bulk-resolve", map[string]any{}, ""); res.status != 400 ||
		res.body["code"] != "dlq_ids_required" {
		t.Fatalf("empty ids: %d %+v", res.status, res.body)
	}
	tooMany := make([]any, 101)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("x-%d", i)
	}
	if res = h.call("POST", "/dlq/bulk-replay", map[string]any{"deadLetterIds": tooMany}, ""); res.status != 400 ||
		res.body["code"] != "dlq_ids_cap_exceeded" {
		t.Fatalf("cap: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/dlq/cluster-apply", map[string]any{
		"clusterSignature": sig, "deadLetterIds": []any{""},
	}, ""); res.status != 400 || res.body["code"] != "dlq_ids_invalid_entries" {
		t.Fatalf("bad entries: %d %+v", res.status, res.body)
	}

	// A foreign-signature row in the batch is rejected server-side.
	stale := "dlq-stale-" + suffix
	seedQueueDeadLetter(t, h.org, stale, "open", "completely different failure", time.Now().UTC())

	// Cluster-apply dlq1+dlq2 with the healthy-URL fix: the revived runs
	// execute the PATCH (snapshot swap) and succeed.
	res = h.call("POST", "/dlq/cluster-apply", map[string]any{
		"clusterSignature":  sig,
		"deadLetterIds":     []any{dlq1, dlq2, stale},
		"suggestedWorkflow": workflowDoc(healthy.URL),
	}, "")
	if res.status != 200 || res.body["replayed"] != float64(2) || res.body["failed"] != float64(1) {
		t.Fatalf("cluster-apply: %d %+v", res.status, res.body)
	}
	errs := res.body["errors"].([]any)
	if errs[0].(map[string]any)["deadLetterId"] != stale {
		t.Fatalf("stale member must be the rejected one: %+v", errs)
	}
	h.waitRun(run1, "succeeded")
	h.waitRun(run2, "succeeded")
	// Terminal success converged both rows open → replayed; a second apply
	// reports them instead of double-enqueuing.
	res = h.call("POST", "/dlq/cluster-apply", map[string]any{
		"clusterSignature": sig, "deadLetterIds": []any{dlq1},
	}, "")
	if res.body["replayed"] != float64(0) || res.body["failed"] != float64(1) {
		t.Fatalf("re-apply must skip: %+v", res.body)
	}

	// Mixed-batch bulk-replay: dlq3 (open, no fix) replays and fails again;
	// a missing id reports without aborting the batch.
	res = h.call("POST", "/dlq/bulk-replay", map[string]any{
		"deadLetterIds": []any{dlq3, "missing-" + suffix},
	}, "")
	if res.status != 200 || res.body["replayed"] != float64(1) || res.body["failed"] != float64(1) {
		t.Fatalf("bulk-replay: %d %+v", res.status, res.body)
	}
	// The claim is single-use: replaying the same id again loses the CAS.
	res = h.call("POST", "/dlq/bulk-replay", map[string]any{"deadLetterIds": []any{dlq3}}, "")
	if res.body["replayed"] != float64(0) || res.body["failed"] != float64(1) {
		t.Fatalf("bulk-replay reclaim must fail: %+v", res.body)
	}

	// Manual resolve accepts the loss and closes the linked incident with
	// the honest reason (dismiss is NOT a replay win).
	res = h.call("POST", "/dlq/resolve", map[string]any{"id": dlq3}, "")
	if res.status != 200 || res.body["ok"] != true {
		t.Fatalf("resolve: %d %+v", res.status, res.body)
	}
	var dlqStatus, itemStatus, itemReason string
	_ = pool.QueryRow(ctx, `SELECT status FROM dead_letters WHERE id = $1`, dlq3).Scan(&dlqStatus)
	_ = pool.QueryRow(ctx, `SELECT status, COALESCE(resolution_reason, '') FROM recovery_items
		WHERE org_id = $1 AND dead_letter_id = $2`, h.org, dlq3).Scan(&itemStatus, &itemReason)
	if dlqStatus != "resolved" || itemStatus != "resolved" || itemReason != "accepted_loss" {
		t.Fatalf("resolve state: dlq=%s item=%s reason=%s", dlqStatus, itemStatus, itemReason)
	}

	// Bulk-resolve: the stale row resolves; a missing id reports.
	res = h.call("POST", "/dlq/bulk-resolve", map[string]any{
		"deadLetterIds": []any{stale, "missing-" + suffix},
	}, "")
	if res.body["resolved"] != float64(1) || res.body["failed"] != float64(1) {
		t.Fatalf("bulk-resolve: %+v", res.body)
	}
}
