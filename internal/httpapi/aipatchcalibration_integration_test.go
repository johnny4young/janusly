//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A fitted curve must change the actual suggestion response, not just the
// health tile. Raw confidence remains the feedback signal, while calibrated
// confidence chooses the suggestion the dialog presents first.
func TestPatchWorkflowUsesOnlyFreshTenantCalibration(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	h := newAPIHarness(t)
	failRun(t, h, "wf-calibration-"+h.org)
	ids := deadLetterIDs(t, h)
	if len(ids) != 1 {
		t.Fatalf("want one dead letter: %v", ids)
	}
	pool := testPool(t)
	ctx := t.Context()
	for _, curve := range []struct {
		label     string
		slope     float64
		intercept float64
	}{
		{"fix_url", 0.5, 5},
		{"add_retry", 1, 0},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO confidence_calibrations
			(id, org_id, approach_label, accept_rate, sample_size, curve_slope, curve_intercept)
			VALUES ($1, $2, $3, 0.5, 30, $4, $5)`,
			h.org+"-"+curve.label, h.org, curve.label, curve.slope, curve.intercept); err != nil {
			t.Fatalf("seed calibration: %v", err)
		}
	}

	response := `{"suggestions":[
		{"patchedConfig":{"url":"https://api.example.com/fixed"},"rationale":"fix URL","approachLabel":"fix_url","confidence":0.9},
		{"patchedConfig":{"url":"https://api.example.com/retry"},"rationale":"add retry","approachLabel":"add_retry","confidence":0.8}
	]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, anthropicReply(response))
	}))
	t.Cleanup(server.Close)
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LLM_SIMULATED_PROVIDERS", "anthropic")
	t.Setenv("JANUSLY_LLM_SIMULATOR_BASE_URL", server.URL)

	call := func() []map[string]any {
		t.Helper()
		res := h.call("POST", "/ai/patch-workflow", map[string]any{"deadLetterId": ids[0]}, "")
		if res.status != 200 || res.body["mode"] != "ai" {
			t.Fatalf("patch status/mode: %d %+v", res.status, res.body)
		}
		raw := res.body["suggestions"].([]any)
		if len(raw) != 2 {
			t.Fatalf("want two valid suggestions: %+v", raw)
		}
		first := raw[0].(map[string]any)
		if res.body["suggestedWorkflow"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["config"].(map[string]any)["url"] !=
			first["workflow"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["config"].(map[string]any)["url"] {
			t.Fatal("suggestedWorkflow must match the highest-ranked visible suggestion")
		}
		return []map[string]any{first, raw[1].(map[string]any)}
	}
	calibrated := call()
	if calibrated[0]["approachLabel"] != "add_retry" || calibrated[0]["confidence"] != float64(80) ||
		calibrated[0]["calibratedConfidence"] != float64(80) ||
		calibrated[1]["approachLabel"] != "fix_url" || calibrated[1]["confidence"] != float64(90) ||
		calibrated[1]["calibratedConfidence"] != float64(50) {
		t.Fatalf("fresh tenant curves must calibrate and rank: %+v", calibrated)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'ai.confidenceCalibrationEnabled', 'false', 'ai', 'test', 'boolean')`,
		h.org+"-calibration-off", h.org); err != nil {
		t.Fatalf("disable calibration: %v", err)
	}
	disabled := call()
	if disabled[0]["approachLabel"] != "fix_url" || disabled[0]["calibratedConfidence"] != float64(90) {
		t.Fatalf("disabled calibration must preserve raw ranking: %+v", disabled)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM org_configs WHERE org_id = $1 AND key = 'ai.confidenceCalibrationEnabled'`, h.org); err != nil {
		t.Fatalf("re-enable calibration: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE confidence_calibrations SET last_computed_at = now() - interval '3 days'
		WHERE org_id = $1`, h.org); err != nil {
		t.Fatalf("age curves: %v", err)
	}
	stale := call()
	if stale[0]["approachLabel"] != "fix_url" || stale[0]["calibratedConfidence"] != float64(90) {
		t.Fatalf("stale curves must not change suggestions: %+v", stale)
	}
	status := h.call("GET", "/recovery/calibration-status", nil, "")
	if curves := status.body["calibrations"].([]any); len(curves) != 0 {
		t.Fatalf("stale curves must not appear active in health: %+v", curves)
	}
	if _, err := pool.Exec(ctx, `UPDATE confidence_calibrations SET last_computed_at = now(), curve_slope = -1
		WHERE org_id = $1`, h.org); err != nil {
		t.Fatalf("corrupt curve: %v", err)
	}
	invalid := call()
	if invalid[0]["approachLabel"] != "fix_url" || invalid[0]["calibratedConfidence"] != float64(90) {
		t.Fatalf("invalid curves must not change suggestions: %+v", invalid)
	}
	if _, err := pool.Exec(ctx, `UPDATE confidence_calibrations SET curve_slope = 0.5, sample_size = 19
		WHERE org_id = $1`, h.org); err != nil {
		t.Fatalf("lower sample floor: %v", err)
	}
	underfit := call()
	if underfit[0]["approachLabel"] != "fix_url" || underfit[0]["calibratedConfidence"] != float64(90) {
		t.Fatalf("curves below the sample floor must not change suggestions: %+v", underfit)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM confidence_calibrations WHERE org_id = $1`, h.org); err != nil {
		t.Fatalf("remove local curves: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO confidence_calibrations
		(id, org_id, approach_label, accept_rate, sample_size, curve_slope, curve_intercept)
		VALUES ($1, $2, 'fix_url', 0.5, 30, 0.1, 0)`, h.org+"-foreign", h.org+"-foreign"); err != nil {
		t.Fatalf("seed foreign curve: %v", err)
	}
	foreign := call()
	if foreign[0]["approachLabel"] != "fix_url" || foreign[0]["calibratedConfidence"] != float64(90) {
		t.Fatalf("another tenant's curve must be invisible: %+v", foreign)
	}
}
