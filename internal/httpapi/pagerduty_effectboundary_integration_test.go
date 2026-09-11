//go:build integration

package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/johnny4young/janusly/internal/secretstore"
)

func TestPagerDutyLostWriteResponseDoesNotReplayEffect(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")

	var acknowledgements, unexpectedCalls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		incidentID, valid := pagerDutyAcknowledgeRequestIncidentID(r)
		if !valid || incidentID != "PINC_LOST_RESPONSE" {
			unexpectedCalls.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// The provider committed the action, but the worker never receives a
		// receipt. A transport failure cannot prove that no effect occurred.
		acknowledgements.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack provider response: %v", err)
			return
		}
		_ = conn.Close()
	}))
	t.Cleanup(provider.Close)
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", provider.URL)

	const credential = "pagerduty-lost-response"
	if res := h.call("POST", "/credentials", map[string]any{
		"name": credential, "kind": "pagerduty_api_token", "secretValue": "local-test-token",
	}, ""); res.status != http.StatusOK {
		t.Fatalf("credential: %d %+v", res.status, res.body)
	}
	input := map[string]any{
		"credential": credential, "requesterEmail": "operator@example.com", "incidentId": "PINC_LOST_RESPONSE",
	}
	workflow := map[string]any{
		"id": "wf-pd-lost-response-" + h.org, "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "acknowledge", "type": "tool", "config": map[string]any{
				"tool": "pagerduty.incident.acknowledge", "input": input, "resultPolicy": "require_ok",
				"retry": map[string]any{"maxAttempts": 3, "delayMs": 1},
			}},
			map[string]any{"id": "after", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "acknowledge", "to": "after"}},
	}
	runID := extractRunID(t, h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, ""))
	h.waitRun(runID, "failed")

	var attempts, deadLetters, retryEvents int
	var errorJSON []byte
	var downstreamStatus string
	if err := pool.QueryRow(t.Context(), `SELECT n.attempts, n.error_json,
		(SELECT count(*) FROM dead_letters WHERE run_id=n.run_id),
		(SELECT count(*) FROM run_events WHERE run_id=n.run_id AND type='node.retry'),
		(SELECT status FROM run_nodes WHERE run_id=n.run_id AND node_id='after')
		FROM run_nodes n WHERE n.run_id=$1 AND n.node_id='acknowledge'`, runID).
		Scan(&attempts, &errorJSON, &deadLetters, &retryEvents, &downstreamStatus); err != nil {
		t.Fatalf("read lost-response outcome: %v", err)
	}
	var failure map[string]any
	if err := json.Unmarshal(errorJSON, &failure); err != nil {
		t.Fatalf("decode failure: %v", err)
	}
	details, _ := failure["details"].(map[string]any)
	if acknowledgements.Load() != 1 || unexpectedCalls.Load() != 0 || attempts != 1 ||
		deadLetters != 1 || retryEvents != 0 || downstreamStatus != "pending" ||
		failure["writeSide"] != true || failure["code"] != "TOOL_RESULT_NOT_OK" ||
		details["effectOutcome"] != "unknown" {
		t.Fatalf("lost response must preserve one ambiguous effect: writes=%d unexpected=%d attempts=%d dlq=%d retries=%d downstream=%s error=%s",
			acknowledgements.Load(), unexpectedCalls.Load(), attempts, deadLetters, retryEvents, downstreamStatus, errorJSON)
	}
}
