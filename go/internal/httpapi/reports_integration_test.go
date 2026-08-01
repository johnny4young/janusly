//go:build integration

package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func (h *apiHarness) rawGet(t *testing.T, path string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", h.server.URL+path, nil)
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", "api-tester")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("raw get %s: %v", path, err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	return res, body
}

// Run-explain + evidence exports: the failed run renders root cause /
// failed node / capped timeline / next action with secrets scrubbed,
// downloads carry a filename, cross-org ids 404 uniformly, and the
// incident evidence bundle stitches run + DLQ + validation + audit trail.
func TestRunExplainAndEvidenceExports(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer broken.Close()
	workflow := map[string]any{
		"id": "wf-explain-" + suffix, "name": "Explain", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": broken.URL, "timeoutMs": 500,
		}}},
		"edges": []any{},
	}
	res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	runID := extractRunID(t, res)
	h.waitRun(runID, "failed")

	// Markdown download (default format): headline sections + disposition.
	rawRes, body := h.rawGet(t, "/reports/run-explain?runId="+runID)
	if rawRes.StatusCode != 200 ||
		!strings.Contains(rawRes.Header.Get("Content-Disposition"), "run-explain-") {
		t.Fatalf("markdown export: %d %q", rawRes.StatusCode, rawRes.Header.Get("Content-Disposition"))
	}
	markdown := string(body)
	for _, section := range []string{"# Run Explain Report", "## Root cause", "## Failed node", "## Timeline", "## Next action"} {
		if !strings.Contains(markdown, section) {
			t.Fatalf("markdown missing %q:\n%s", section, markdown[:min(600, len(markdown))])
		}
	}

	// JSON envelope: failure summary, root cause owner, bounded timeline.
	rawRes, body = h.rawGet(t, "/reports/run-explain?runId="+runID+"&format=json")
	var report map[string]any
	if err := json.Unmarshal(body, &report); err != nil || rawRes.StatusCode != 200 {
		t.Fatalf("json export: %d %v", rawRes.StatusCode, err)
	}
	summary := report["summary"].(map[string]any)
	if summary["isFailure"] != true || summary["status"] != "failed" {
		t.Fatalf("summary: %+v", summary)
	}
	if report["rootCause"] == nil || report["failedNode"] == nil {
		t.Fatalf("root cause + failed node expected: %+v", report)
	}
	if len(report["timeline"].([]any)) == 0 {
		t.Fatalf("timeline expected")
	}
	if !strings.Contains(report["nextAction"].(string), " ") {
		t.Fatalf("next action: %+v", report["nextAction"])
	}

	// Contract errors + tenant isolation.
	if rawRes, _ = h.rawGet(t, "/reports/run-explain"); rawRes.StatusCode != 400 {
		t.Fatalf("missing runId must 400: %d", rawRes.StatusCode)
	}
	if rawRes, _ = h.rawGet(t, "/reports/run-explain?runId="+runID+"&format=pdf"); rawRes.StatusCode != 400 {
		t.Fatalf("unknown format must 400: %d", rawRes.StatusCode)
	}
	foreign := h.call("GET", "/reports/run-explain?runId="+runID, nil, h.org+"-other")
	if foreign.status != 404 {
		t.Fatalf("cross-org must 404: %d", foreign.status)
	}

	// Evidence bundle: replay opens the incident + a validation run
	// exists; the export stitches every block and audits itself.
	var dlqID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&dlqID)
	if res = h.call("POST", "/dlq/validate-fix", map[string]any{
		"deadLetterId": dlqID, "suggestedWorkflow": workflow,
	}, ""); res.status != 200 {
		t.Fatalf("validate-fix: %d %+v", res.status, res.body)
	}
	if res = h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": dlqID}, ""); res.status != 200 {
		t.Fatalf("replay: %d", res.status)
	}
	var itemID string
	if err := pool.QueryRow(ctx, `SELECT id FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2`,
		h.org, dlqID).Scan(&itemID); err != nil {
		t.Fatalf("item: %v", err)
	}
	req, _ := http.NewRequest("POST", h.server.URL+"/recovery/items/"+itemID+"/evidence?format=json", nil)
	req.Header.Set("x-org-id", h.org)
	req.Header.Set("x-user-id", "api-tester")
	evidenceRes, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("evidence: %v", err)
	}
	evidenceBody, _ := io.ReadAll(evidenceRes.Body)
	_ = evidenceRes.Body.Close()
	if evidenceRes.StatusCode != 200 {
		t.Fatalf("evidence export: %d %s", evidenceRes.StatusCode, evidenceBody)
	}
	var evidence map[string]any
	_ = json.Unmarshal(evidenceBody, &evidence)
	if evidence["incident"].(map[string]any)["id"] != itemID {
		t.Fatalf("incident block: %+v", evidence["incident"])
	}
	if evidence["deadLetter"].(map[string]any)["id"] != dlqID {
		t.Fatalf("dead letter block: %+v", evidence["deadLetter"])
	}
	if evidence["originalRun"] == nil || evidence["validationRun"] == nil {
		t.Fatalf("run + validation blocks expected: %+v", evidence)
	}
	if len(evidence["auditTrail"].([]any)) == 0 {
		t.Fatalf("audit trail expected")
	}
	var audited int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'report.evidence.exported' AND target_id = $2`,
		h.org, itemID).Scan(&audited)
	if audited != 1 {
		t.Fatalf("evidence export must audit itself: %d", audited)
	}
}
