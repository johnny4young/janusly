//go:build integration

package httpapi

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/secretstore"
)

func externalRuntimeSign(secret, body string, timestamp int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%d.%s", timestamp, body)
	return fmt.Sprintf("t=%d,v1=%s", timestamp, hex.EncodeToString(mac.Sum(nil)))
}

// The observation-only shadow loop: signed CloudEvents ingestion with the
// strict contract, idempotent receipts, monotonic projections (stale
// events retained but never applied), the external recovery-case ladder
// detected → observed_recovered, and the sensitive-identity firewall.
func TestExternalRuntimeShadowIngestion(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	suffix := fmt.Sprint(time.Now().UnixNano())
	secret := "ext-signing-" + suffix

	if res := h.call("POST", "/credentials", map[string]any{
		"name": "ext-runtime", "kind": "external_runtime_signing_secret", "secretValue": secret,
	}, ""); res.status != 200 {
		t.Fatalf("credential: %d %+v", res.status, res.body)
	}

	// Admin CRUD: ghost credential 422; create; duplicate runtimeKey 409.
	if res := h.call("POST", "/integrations/external-runtimes", map[string]any{
		"name": "temporal-prod", "runtimeKey": "temporal.prod", "signingCredentialName": "ghost",
	}, ""); res.status != 422 {
		t.Fatalf("ghost credential must 422: %d %+v", res.status, res.body)
	}
	res := h.call("POST", "/integrations/external-runtimes", map[string]any{
		"name": "temporal-prod", "runtimeKey": "temporal.prod", "signingCredentialName": "ext-runtime",
	}, "")
	if res.status != 201 {
		t.Fatalf("create connection: %d %+v", res.status, res.body)
	}
	connectionID := res.body["connection"].(map[string]any)["id"].(string)
	if res := h.call("POST", "/integrations/external-runtimes", map[string]any{
		"name": "other", "runtimeKey": "temporal.prod", "signingCredentialName": "ext-runtime",
	}, ""); res.status != 409 {
		t.Fatalf("duplicate runtimeKey must 409: %d", res.status)
	}

	callback := h.server.URL + "/webhooks/external-runtimes/" + connectionID
	post := func(body string, signature string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", callback, bytes.NewReader([]byte(body)))
		req.Header.Set("content-type", "application/json")
		if signature != "" {
			req.Header.Set("x-janusly-signature", signature)
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("callback: %v", err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		var parsed map[string]any
		_ = json.Unmarshal(raw, &parsed)
		return response.StatusCode, parsed
	}
	event := func(eventID, eventType string, sequence float64, data map[string]any) string {
		data["sequence"] = sequence
		payload, _ := json.Marshal(map[string]any{
			"specversion": "1.0", "id": eventID, "source": "//temporal/prod",
			"time": "2026-08-01T10:00:00Z", "type": eventType, "data": data,
		})
		return string(payload)
	}
	now := time.Now().Unix()

	// Defense ladder.
	runFailed := event("evt-1-"+suffix, "io.janusly.external.run.observed", 5, map[string]any{
		"externalWorkflowId": "order-flow", "externalRunId": "run-9", "status": "failed",
		"snapshot": map[string]any{"error": "boom", "apiKey": "sk-abcdefghijklmnopqrstuvwxyz0123456789"},
	})
	if status, _ := post(runFailed, ""); status != 401 {
		t.Fatalf("missing signature must 401: %d", status)
	}
	stale := now - 3600
	if status, _ := post(runFailed, externalRuntimeSign(secret, runFailed, stale)); status != 401 {
		t.Fatalf("skewed timestamp must 401: %d", status)
	}
	invalidContract := event("evt-x-"+suffix, "io.janusly.external.run.observed", 1, map[string]any{
		"externalWorkflowId": "order-flow", "externalRunId": "run-9", "status": "failed",
		"surprise": true,
	})
	if status, _ := post(invalidContract, externalRuntimeSign(secret, invalidContract, now)); status != 400 {
		t.Fatalf("strict contract must reject unknown fields: %d", status)
	}
	sensitive := event("sk-abcdefghijklmnopqrstuvwxyz0123456789", "io.janusly.external.run.observed", 1, map[string]any{
		"externalWorkflowId": "order-flow", "externalRunId": "run-9", "status": "failed",
	})
	if status, _ := post(sensitive, externalRuntimeSign(secret, sensitive, now)); status != 400 {
		t.Fatalf("sensitive identity must 400: %d", status)
	}

	// Failed run observation → projection applied + case detected.
	status, body := post(runFailed, externalRuntimeSign(secret, runFailed, now))
	if status != 202 || body["accepted"] != true || body["projectionState"] != "applied" {
		t.Fatalf("failed-run ingest: %d %+v", status, body)
	}
	var caseState string
	_ = pool.QueryRow(ctx, `SELECT state FROM external_recovery_cases WHERE connection_id = $1 AND subject_key = 'run:run-9'`,
		connectionID).Scan(&caseState)
	if caseState != "detected" {
		t.Fatalf("case must be detected: %q", caseState)
	}
	// The projected snapshot passed the scrubber.
	var snapshot string
	_ = pool.QueryRow(ctx, `SELECT snapshot_json::text FROM external_runs WHERE connection_id = $1 AND external_run_id = 'run-9'`,
		connectionID).Scan(&snapshot)
	if strings.Contains(snapshot, "sk-abcdefghijklmnop") || !strings.Contains(snapshot, "[redacted]") {
		t.Fatalf("snapshot must be scrubbed: %s", snapshot)
	}

	// Exact duplicate → duplicate receipt, no reprojection.
	if status, body = post(runFailed, externalRuntimeSign(secret, runFailed, now)); status != 202 || body["duplicate"] != true {
		t.Fatalf("duplicate must converge: %d %+v", status, body)
	}

	// LOWER sequence with a happier status → retained as stale, projection unchanged.
	staleEvent := event("evt-2-"+suffix, "io.janusly.external.run.observed", 3, map[string]any{
		"externalWorkflowId": "order-flow", "externalRunId": "run-9", "status": "succeeded",
	})
	if status, body = post(staleEvent, externalRuntimeSign(secret, staleEvent, now)); status != 202 || body["projectionState"] != "stale" {
		t.Fatalf("lower sequence must be stale: %d %+v", status, body)
	}
	var runStatus string
	_ = pool.QueryRow(ctx, `SELECT status FROM external_runs WHERE connection_id = $1 AND external_run_id = 'run-9'`,
		connectionID).Scan(&runStatus)
	if runStatus != "failed" {
		t.Fatalf("stale event must not move the projection: %q", runStatus)
	}

	// HIGHER-sequence success applies and flips the case to observed_recovered.
	recovered := event("evt-3-"+suffix, "io.janusly.external.run.observed", 9, map[string]any{
		"externalWorkflowId": "order-flow", "externalRunId": "run-9", "status": "succeeded",
		"evidence": []any{map[string]any{"kind": "url", "label": "retry run", "locator": "https://temporal/run-9b"}},
	})
	if status, body = post(recovered, externalRuntimeSign(secret, recovered, now)); status != 202 || body["projectionState"] != "applied" {
		t.Fatalf("recovery observation: %d %+v", status, body)
	}
	_ = pool.QueryRow(ctx, `SELECT state FROM external_recovery_cases WHERE connection_id = $1 AND subject_key = 'run:run-9'`,
		connectionID).Scan(&caseState)
	if caseState != "observed_recovered" {
		t.Fatalf("case must be observed_recovered: %q", caseState)
	}

	// A step observation materializes workflow+run placeholders.
	step := event("evt-4-"+suffix, "io.janusly.external.step.observed", 2, map[string]any{
		"externalWorkflowId": "billing-flow", "externalRunId": "run-77",
		"externalStepId": "charge", "name": "Charge card", "status": "failed", "attempt": 3,
	})
	if status, body = post(step, externalRuntimeSign(secret, step, now)); status != 202 || body["projectionState"] != "applied" {
		t.Fatalf("step ingest: %d %+v", status, body)
	}

	// The read-only shadow carries every projection and says so.
	res = h.call("GET", "/integrations/external-runtimes", nil, "")
	if res.status != 200 || res.body["observerOnly"] != true {
		t.Fatalf("shadow read: %d %+v", res.status, res.body)
	}
	if len(res.body["workflows"].([]any)) != 2 || len(res.body["runs"].([]any)) != 2 ||
		len(res.body["steps"].([]any)) != 1 || len(res.body["cases"].([]any)) != 2 {
		t.Fatalf("shadow projections: wf=%d runs=%d steps=%d cases=%d",
			len(res.body["workflows"].([]any)), len(res.body["runs"].([]any)),
			len(res.body["steps"].([]any)), len(res.body["cases"].([]any)))
	}
	caseRows := res.body["cases"].([]any)
	states := map[string]map[string]any{}
	for _, raw := range caseRows {
		row := raw.(map[string]any)
		state, _ := row["state"].(string)
		states[state] = row
		if _, leaked := row["State"]; leaked {
			t.Fatalf("shadow case leaked Go field names: %+v", row)
		}
	}
	if recoveredCase := states["observed_recovered"]; recoveredCase == nil ||
		recoveredCase["connectionId"] != connectionID || recoveredCase["externalRunId"] != "run-9" ||
		recoveredCase["observedRecoveredAt"] == nil {
		t.Fatalf("recovered case wire projection: %+v", recoveredCase)
	}
	if detectedCase := states["detected"]; detectedCase == nil ||
		detectedCase["externalStepId"] != "charge" || detectedCase["firstDetectedAt"] == nil {
		t.Fatalf("detected case wire projection: %+v", detectedCase)
	}
	runRows := res.body["runs"].([]any)
	if run := runRows[0].(map[string]any); run["connectionId"] == nil || run["externalRunId"] == nil ||
		run["lastObservedAt"] == nil {
		t.Fatalf("external run wire projection: %+v", run)
	}

	// Disabling the connection closes the door (opaque 404).
	if res := h.call("POST", "/integrations/external-runtimes/"+connectionID, map[string]any{
		"name": "temporal-prod", "runtimeKey": "temporal.prod",
		"signingCredentialName": "ext-runtime", "enabled": false,
	}, ""); res.status != 200 {
		t.Fatalf("disable: %d %+v", res.status, res.body)
	}
	if status, _ := post(runFailed, externalRuntimeSign(secret, runFailed, now)); status != 404 {
		t.Fatalf("disabled connection must 404: %d", status)
	}
}
