//go:build integration

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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

	// Audit trail: the operator's create, one system-actor completion, and
	// one item row per replayed entry (the pump replays via the engine, so
	// no dlq.replayed rows — item_replayed is that path's identity).
	pool := testPool(t)
	for action, want := range map[string]int{
		"recovery.campaign.created":       1,
		"recovery.campaign.completed":     1,
		"recovery.campaign.item_replayed": 2,
		"recovery.campaign.item_failed":   0,
		"dlq.replayed":                    0,
	} {
		if got := countAudit(t, pool, h.org, action); got != want {
			t.Fatalf("%s: want %d rows, got %d", action, want, got)
		}
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
	// A cancelled campaign audits the operator action (cancellation is an
	// operator verb, so no system completion row lands).
	if got := countAudit(t, testPool(t), h.org, "recovery.campaign.cancelled"); got != 1 {
		t.Fatalf("recovery.campaign.cancelled: want 1 row, got %d", got)
	}
	if got := countAudit(t, testPool(t), h.org, "recovery.campaign.completed"); got != 0 {
		t.Fatalf("cancelled campaign must not audit completion, got %d", got)
	}
}

// A real recovery cycle feeds the north star: fail → DLQ → heal upstream →
// redrive → verified success, measured detection → terminal success.
func TestVerifiedRecoveryMetrics(t *testing.T) {
	h := newAPIHarness(t)

	// Empty org: sample 0, null percentiles.
	empty := h.call("GET", "/v1/recovery/metrics", nil, "")
	if empty.status != http.StatusOK {
		t.Fatalf("empty metrics status: %d %+v", empty.status, empty.body)
	}
	requireEnvelope(t, empty)
	data := empty.body["data"].(map[string]any)
	requireRecoveryMetricsContract(t, data)
	vr := data["verifiedRecovery"].(map[string]any)
	if vr["definitionVersion"] != "1" || vr["metric"] != "time_to_verified_recovery" ||
		vr["unit"] != "milliseconds" || vr["sampleSize"] != float64(0) ||
		vr["p50Ms"] != nil || data["mttrMs"] != nil {
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
	if after.status != http.StatusOK {
		t.Fatalf("recovery metrics status: %d %+v", after.status, after.body)
	}
	if after.body["apiVersion"] != nil {
		t.Fatalf("legacy wire must be raw: %+v", after.body)
	}
	requireRecoveryMetricsContract(t, after.body)
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

func requireRecoveryMetricsContract(t *testing.T, body map[string]any) {
	t.Helper()
	metricKeys := []string{
		"successRate", "verifiedRecovery", "mttr", "p95Latency", "approvalsPending",
		"replayRate", "costThisWindow", "clustersResolved", "slaAttainment",
		"timeToFirstAction", "recurrenceRate",
	}
	for _, key := range metricKeys {
		metric, ok := body[key].(map[string]any)
		if !ok {
			t.Fatalf("%s metric missing: %+v", key, body[key])
		}
		if _, ok := metric["value"]; !ok {
			t.Fatalf("%s value missing: %+v", key, metric)
		}
		if _, ok := metric["display"].(string); !ok {
			t.Fatalf("%s display missing: %+v", key, metric)
		}
		if _, ok := metric["severity"].(string); !ok {
			t.Fatalf("%s severity missing: %+v", key, metric)
		}
		if _, ok := metric["rationale"].(string); !ok {
			t.Fatalf("%s rationale missing: %+v", key, metric)
		}
		if _, ok := metric["rationaleCode"].(string); !ok {
			t.Fatalf("%s rationaleCode missing: %+v", key, metric)
		}
	}
	verified := body["verifiedRecovery"].(map[string]any)
	if verified["definitionVersion"] != "1" || verified["metric"] != "time_to_verified_recovery" ||
		verified["unit"] != "milliseconds" {
		t.Fatalf("verified recovery definition: %+v", verified)
	}
	cost := body["costThisWindow"].(map[string]any)
	if _, ok := cost["providers"].([]any); !ok {
		t.Fatalf("cost providers missing: %+v", cost)
	}
	cache, ok := cost["cache"].(map[string]any)
	if !ok || cache["inputTokens"] == nil || cache["readTokens"] == nil || cache["creationTokens"] == nil {
		t.Fatalf("cost cache missing: %+v", cost)
	}
	clusters := body["clustersResolved"].(map[string]any)
	if clusters["totalEntries"] == nil || clusters["capped"] == nil {
		t.Fatalf("cluster metadata missing: %+v", clusters)
	}
	sla := body["slaAttainment"].(map[string]any)
	if sla["resolvedInWindow"] == nil || sla["metSla"] == nil {
		t.Fatalf("SLA metadata missing: %+v", sla)
	}
	if _, ok := body["valueEstimate"].(map[string]any); !ok {
		t.Fatalf("value estimate missing: %+v", body["valueEstimate"])
	}
	if _, ok := body["terminalRuns"].(float64); !ok {
		t.Fatalf("terminal run count missing: %+v", body["terminalRuns"])
	}
	if _, ok := body["mttrTrend"].([]any); !ok {
		t.Fatalf("MTTR trend missing: %+v", body["mttrTrend"])
	}
	if _, ok := body["downtimeEndedMs"].(float64); !ok {
		t.Fatalf("downtime total missing: %+v", body["downtimeEndedMs"])
	}
}

// Server-side DLQ filters: status validated against the closed enum,
// nodeId exact, workflowId through the version join.
func TestDlqServerSideFilters(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	failRun(t, h, "wf-filter-a-"+h.org)
	failRun(t, h, "wf-filter-b-"+h.org)
	ids := deadLetterIDs(t, h)
	if len(ids) != 2 {
		t.Fatalf("seed: %v", ids)
	}
	// Seed one terminal replay state directly: this test owns query filters,
	// not worker/redrive behavior. Redriving through the live harness would
	// race the retried failing node, which can legitimately create a third
	// dead letter before the filter assertions run.
	if _, err := pool.Exec(context.Background(), `
		UPDATE dead_letters SET status = 'replayed', replayed_at = now()
		WHERE org_id = $1 AND id = $2`, h.org, ids[0]); err != nil {
		t.Fatalf("seed replayed status: %v", err)
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

// Optional Idempotency-Key on /start: a duplicate returns the ORIGINAL
// run with an indistinguishable body; keys scope per org.
func TestStartIdempotencyKey(t *testing.T) {
	h := newAPIHarness(t)
	doc := map[string]any{
		"nodes": []any{map[string]any{"id": "a", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	key := fmt.Sprintf("deploy-%d", time.Now().UnixNano())
	call := func(org string) apiResponse {
		res := h.callWithHeaders("POST", "/v1/start", map[string]any{"workflow": doc}, org,
			map[string]string{"Idempotency-Key": key})
		return res
	}
	first := call("")
	second := call("")
	runA := first.body["data"].(map[string]any)["runId"].(string)
	runB := second.body["data"].(map[string]any)["runId"].(string)
	if runA != runB {
		t.Fatalf("duplicate key must replay the original run: %s vs %s", runA, runB)
	}
	pool := testPool(t)
	var count int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM runs WHERE org_id = $1`, h.org).Scan(&count)
	if count != 1 {
		t.Fatalf("one run expected, got %d", count)
	}

	// Without the header every call is a fresh run.
	plain := h.call("POST", "/v1/start", map[string]any{"workflow": doc}, "")
	if plain.body["data"].(map[string]any)["runId"].(string) == runA {
		t.Fatal("headerless starts must not join the idempotent family")
	}

	// The same key under ANOTHER org is independent.
	other := call("other-" + h.org)
	if other.body["data"].(map[string]any)["runId"].(string) == runA {
		t.Fatal("keys must scope per org")
	}

	// A retry is a read of the already-committed success. Mutable policy that
	// changed after the first request cannot turn that replay into a rejection.
	if _, err := pool.Exec(t.Context(), `INSERT INTO org_configs
		(id, org_id, key, value_json, category, description, value_type)
		VALUES ($1,$2,'runs.requireSavedWorkflow','true','runs','test','boolean')`,
		h.org+"-saved-only", h.org); err != nil {
		t.Fatal(err)
	}
	replayAfterPolicyChange := call("")
	if replayAfterPolicyChange.status != http.StatusOK ||
		replayAfterPolicyChange.body["data"].(map[string]any)["runId"] != runA {
		t.Fatalf("policy change broke idempotent replay: %d %+v", replayAfterPolicyChange.status, replayAfterPolicyChange.body)
	}

	// Oversized key: 400.
	big := h.callWithHeaders("POST", "/v1/start", map[string]any{"workflow": doc}, "",
		map[string]string{"Idempotency-Key": strings.Repeat("k", 257)})
	if big.status != 400 {
		t.Fatalf("oversized key: %d", big.status)
	}
}

func (h *apiHarness) callWithHeaders(method, path string, body any, org string, headers map[string]string) apiResponse {
	h.t.Helper()
	if org == "" {
		org = h.org
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequest(method, h.server.URL+path, bytes.NewReader(raw))
	if err != nil {
		h.t.Fatalf("request: %v", err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-org-id", org)
	req.Header.Set("x-user-id", "api-tester")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatalf("call: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	var parsed map[string]any
	_ = json.NewDecoder(res.Body).Decode(&parsed)
	return apiResponse{status: res.StatusCode, headers: res.Header, body: parsed}
}

// Supabase mode end to end through the real middleware: a valid JWT with a
// membership grant reads the API; a forged one gets the contract's 401.
func TestSupabaseModeThroughTheMiddleware(t *testing.T) {
	fakeSb := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth/v1/user" && r.Header.Get("Authorization") == "Bearer live-token" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"uuid-mw","email":"mw@example.com"}`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer fakeSb.Close()
	t.Setenv("SUPABASE_URL", fakeSb.URL)
	t.Setenv("SUPABASE_SERVICE_ROLE_KEY", "anon")

	h := newAPIHarness(t)
	pool := testPool(t)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO org_members (id, org_id, user_id, email, role)
		 VALUES ($1, $2, 'uuid-mw', 'mw@example.com', 'editor')`,
		h.org+"-mw-member", h.org); err != nil {
		t.Fatalf("seed member: %v", err)
	}

	res := h.callWithHeaders("GET", "/v1/runs", nil, "", map[string]string{
		"Authorization": "Bearer live-token",
	})
	if res.status != 200 {
		t.Fatalf("granted JWT must read: %d %+v", res.status, res.body)
	}

	forged := h.callWithHeaders("GET", "/v1/runs", nil, "", map[string]string{
		"Authorization": "Bearer forged",
	})
	requireError(t, forged, 401, "server_request_failed", "Unauthorized: missing Supabase JWT or dev headers")
}

// requireRole: a seeded viewer cannot save even through dev headers (the
// auto-grant is for missing rows only); the 403 carries the contract's
// exact message.
func TestRequireRoleGateOnSave(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO org_members (id, org_id, user_id, role)
		 VALUES ($1, $2, 'api-tester', 'viewer')`, h.org+"-viewer-row", h.org); err != nil {
		t.Fatalf("seed: %v", err)
	}
	doc := map[string]any{
		"id":    "wf-rolegate-" + h.org,
		"nodes": []any{map[string]any{"id": "a", "type": "noop", "config": map[string]any{}}},
		"edges": []any{},
	}
	res := h.call("POST", "/v1/workflows/save", doc, "")
	requireError(t, res, 403, "server_request_failed", "Forbidden: requires editor role")

	// A ghost user in the SAME org still auto-grants admin via dev mode.
	ghost := h.callWithHeaders("POST", "/v1/workflows/save", doc, "", map[string]string{
		"x-user-id": "ghost-admin",
	})
	if ghost.status != 200 {
		t.Fatalf("dev auto-grant must pass: %d %+v", ghost.status, ghost.body)
	}
}
