//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func homeSection(t *testing.T, body map[string]any, name string) map[string]any {
	t.Helper()
	sections, ok := body["sections"].(map[string]any)
	if !ok {
		t.Fatalf("sections expected: %+v", body)
	}
	section, ok := sections[name].(map[string]any)
	if !ok || section["status"] != "ok" {
		t.Fatalf("section %s must settle ok: %+v", name, sections[name])
	}
	return section["value"].(map[string]any)
}

// The coalesced Home snapshot: the impact scope carries ledger + operator
// wins + queue overview from real terminal-impact facts, and the full
// scope adds metrics, heatmap, cases, validation, and clusters with the
// REAL post-recovery recurrence flag (recovered with terminal impact,
// re-occurred within the 7-day monitoring window).
func TestRecoveryHomeReadModel(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-home-" + suffix

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
			"id": wfID, "name": "Home", "dslVersion": "1.0",
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
			t.Fatalf("dead letter: %v", err)
		}
		return runID, dlqID
	}

	// Recovered with terminal impact: fail, cluster-apply the fix, succeed.
	run1, dlq1 := runFailing()
	res := h.call("GET", "/dlq/clusters", nil, "")
	sig := res.body["clusters"].([]any)[0].(map[string]any)["signature"].(string)
	res = h.call("POST", "/dlq/cluster-apply", map[string]any{
		"clusterSignature": sig, "deadLetterIds": []any{dlq1},
		"suggestedWorkflow": workflowDoc(healthy.URL),
	}, "")
	if res.body["replayed"] != float64(1) {
		t.Fatalf("apply: %+v", res.body)
	}
	h.waitRun(run1, "succeeded")

	// The SAME signature re-occurs after the recovery (7-day window) and
	// its redrive opens the later incident the recurrence join needs.
	_, dlq2 := runFailing()
	if res = h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": dlq2}, ""); res.status != 200 {
		t.Fatalf("replay dlq2: %d %+v", res.status, res.body)
	}

	// A third failure stays OPEN so the queue overview has an oldest row.
	_, _ = runFailing()

	// Impact scope: one request, three sections.
	res = h.call("GET", "/recovery/home?scope=impact", nil, "")
	if res.status != 200 || res.body["scope"] != "impact" {
		t.Fatalf("impact scope: %d %+v", res.status, res.body)
	}
	if _, hasFull := res.body["sections"].(map[string]any)["clusters"]; hasFull {
		t.Fatalf("impact scope must not carry full sections")
	}
	ledger := homeSection(t, res.body, "ledger")
	if ledger["totalRecovered"].(float64) < 1 {
		t.Fatalf("ledger: %+v", ledger)
	}
	// The cluster-apply attributed the win to the calling operator.
	wins := homeSection(t, res.body, "wins")
	if wins["recovered"].(float64) < 1 || wins["windowDays"] != float64(30) {
		t.Fatalf("wins: %+v", wins)
	}
	queue := homeSection(t, res.body, "queue")
	if queue["counts"].(map[string]any)["total"].(float64) < 3 || queue["oldestOpen"] == nil {
		t.Fatalf("queue overview: %+v", queue)
	}

	// Full scope adds the projections; clusters carry the REAL recurrence.
	res = h.call("GET", "/recovery/home", nil, "")
	if res.body["scope"] != "full" {
		t.Fatalf("full scope: %+v", res.body)
	}
	clustersValue := homeSection(t, res.body, "clusters")
	recurredSeen := false
	for _, raw := range clustersValue["clusters"].([]any) {
		cluster := raw.(map[string]any)
		if cluster["signature"] == sig && cluster["recurredAfterRecovery"] == true {
			recurredSeen = true
		}
	}
	if !recurredSeen {
		t.Fatalf("recurrence flag expected on %s: %+v", sig, clustersValue)
	}
	metrics := homeSection(t, res.body, "metrics")
	if metrics["verifiedRecovery"].(map[string]any)["sampleSize"].(float64) < 1 {
		t.Fatalf("metrics: %+v", metrics)
	}
	heatmap := homeSection(t, res.body, "heatmap")
	days := heatmap["days"].([]any)
	if len(days) < 1 {
		t.Fatalf("heatmap days: %+v", heatmap)
	}
	today := days[len(days)-1].(map[string]any)
	if today["failures"].(float64) < 3 || today["recovered"].(float64) < 1 {
		t.Fatalf("heatmap today: %+v", today)
	}
	if cases := homeSection(t, res.body, "cases"); cases["cases"] == nil {
		t.Fatalf("cases section: %+v", cases)
	}
	validation := homeSection(t, res.body, "validation")
	validationTotals := validation["totals"].(map[string]any)
	if validation["sampleLimit"] != float64(100) || validationTotals["drills"] != float64(0) ||
		len(validation["samples"].([]any)) != 0 {
		t.Fatalf("validation: %+v", validation)
	}

	// The recurrence flag also rides the focused /dlq/clusters route.
	res = h.call("GET", "/dlq/clusters", nil, "")
	cluster := res.body["clusters"].([]any)[0].(map[string]any)
	if cluster["recurredAfterRecovery"] != true {
		t.Fatalf("focused clusters must carry the flag: %+v", cluster)
	}
}

// The metric pair: set-once first-action latency (the second
// transition must NOT move the stamp) and the impact-bound 7-day
// recurrence rate on /recovery/metrics.
func TestFirstActionAndRecurrenceMetrics(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())
	wfID := "wf-metric-" + suffix

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
			"id": wfID, "name": "Metric", "dslVersion": "1.0",
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
		_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
			runID).Scan(&dlqID)
		return runID, dlqID
	}

	// Recover one incident with terminal impact (fix boundary).
	run1, dlq1 := runFailing()
	res := h.call("GET", "/dlq/clusters", nil, "")
	sig := res.body["clusters"].([]any)[0].(map[string]any)["signature"].(string)
	res = h.call("POST", "/dlq/cluster-apply", map[string]any{
		"clusterSignature": sig, "deadLetterIds": []any{dlq1},
		"suggestedWorkflow": workflowDoc(healthy.URL),
	}, "")
	if res.body["replayed"] != float64(1) {
		t.Fatalf("apply: %+v", res.body)
	}
	h.waitRun(run1, "succeeded")

	// Same-signature later incident inside the 7-day window → recurred.
	_, dlq2 := runFailing()
	if res = h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": dlq2}, ""); res.status != 200 {
		t.Fatalf("replay dlq2: %d", res.status)
	}
	var item2 string
	_ = pool.QueryRow(ctx, `SELECT id FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2`,
		h.org, dlq2).Scan(&item2)

	// The unactioned incident carries NO stamp; the first operator
	// transition sets it ONCE and later transitions never move it.
	var pending *time.Time
	_ = pool.QueryRow(ctx, `SELECT first_action_at FROM recovery_items WHERE id = $1`, item2).Scan(&pending)
	if pending != nil {
		t.Fatalf("first_action_at must start unset: %v", pending)
	}
	if res = h.call("POST", "/recovery/items/"+item2+"/acknowledge", map[string]any{"owner": "op"}, ""); res.status != 200 {
		t.Fatalf("acknowledge: %d", res.status)
	}
	var firstAction time.Time
	_ = pool.QueryRow(ctx, `SELECT first_action_at FROM recovery_items WHERE id = $1`, item2).Scan(&firstAction)
	if firstAction.IsZero() {
		t.Fatalf("acknowledge must stamp first_action_at")
	}
	time.Sleep(50 * time.Millisecond)
	if res = h.call("POST", "/recovery/items/"+item2+"/in_progress", map[string]any{}, ""); res.status != 200 {
		t.Fatalf("in_progress: %d", res.status)
	}
	var afterAction time.Time
	_ = pool.QueryRow(ctx, `SELECT first_action_at FROM recovery_items WHERE id = $1`, item2).Scan(&afterAction)
	if !afterAction.Equal(firstAction) {
		t.Fatalf("first_action_at must be SET-ONCE: %v -> %v", firstAction, afterAction)
	}

	res = h.call("GET", "/recovery/metrics", nil, "")
	firstActionMetric := res.body["timeToFirstAction"].(map[string]any)
	if firstActionMetric["sampleSize"].(float64) < 2 || firstActionMetric["avgSeconds"] == nil ||
		firstActionMetric["p95Seconds"] == nil {
		t.Fatalf("timeToFirstAction: %+v", firstActionMetric)
	}
	recurrence := res.body["recurrence"].(map[string]any)
	if recurrence["resolved"].(float64) < 1 || recurrence["recurred"].(float64) < 1 ||
		recurrence["windowDays"] != float64(7) {
		t.Fatalf("recurrence: %+v", recurrence)
	}
	if rate, ok := recurrence["stayedFixedRate"].(float64); !ok || rate < 0 || rate > 100 {
		t.Fatalf("stayedFixedRate: %+v", recurrence)
	}
}
