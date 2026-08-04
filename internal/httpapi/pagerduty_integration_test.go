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
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/secretstore"
)

func pagerDutySign(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}

func pagerDutyEventBody(eventID, incidentID, occurredAt string) string {
	payload, _ := json.Marshal(map[string]any{
		"event": map[string]any{
			"id": eventID, "event_type": "incident.triggered", "occurred_at": occurredAt,
			"data": map[string]any{
				"id": incidentID, "type": "incident", "title": "db down", "urgency": "high",
				"service": map[string]any{"id": "PSVC1"},
			},
		},
	})
	return string(payload)
}

// The full V3 loop: signed trigger → authoritative read → deterministic
// off-hours policy → acknowledge → snooze, with the defense ladder (bad
// signature, unknown node, bad payload), duplicate convergence, and the
// no-action path when the event lands inside working hours.
func TestPagerDutySignedV3Flow(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())

	// Provider simulator: authoritative read + both mutations.
	var ackCount, snoozeCount atomic.Int32
	simulator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/pagerduty/incidents/"):
			if !strings.Contains(r.Header.Get("authorization"), "pd-token-") {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			incidentID := strings.TrimPrefix(r.URL.Path, "/pagerduty/incidents/")
			_ = json.NewEncoder(w).Encode(map[string]any{"incident": map[string]any{
				"id": incidentID, "status": "triggered", "title": "db down", "urgency": "high",
				"service":     map[string]any{"id": "PSVC1"},
				"assignments": []any{map[string]any{"assignee": map[string]any{"id": "PUSER1"}}},
			}})
		case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/pagerduty/incidents/"):
			ackCount.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"incident": map[string]any{"status": "acknowledged"}})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/snooze"):
			snoozeCount.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"incident": map[string]any{"status": "acknowledged"}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer simulator.Close()
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", simulator.URL)

	signingSecret := "pd-signing-" + suffix
	for _, credential := range []map[string]any{
		{"name": "pagerduty-webhook", "kind": "pagerduty_webhook_secret", "secretValue": signingSecret},
		{"name": "pagerduty-api", "kind": "pagerduty_api_token", "secretValue": "pd-token-" + suffix},
	} {
		if res := h.call("POST", "/credentials", credential, ""); res.status != 200 {
			t.Fatalf("credential %v: %d %+v", credential["name"], res.status, res.body)
		}
	}

	// The deterministic off-hours graph. Policy times BOTH come from the
	// event's occurredAt so the decision never depends on the test clock.
	wfID := "wf-pd-" + suffix
	policyInput := map[string]any{
		"eventType":       "{{context.on_pagerduty.output.event.eventType}}",
		"occurredAt":      "{{context.on_pagerduty.output.event.occurredAt}}",
		"receivedAt":      "{{context.on_pagerduty.output.event.occurredAt}}",
		"incident":        "{{context.load_incident.output.result.incident}}",
		"pagerDutyUserId": "PUSER1",
		"timeZone":        "UTC",
		"workingHours": []any{map[string]any{
			"days": []any{1.0, 2.0, 3.0, 4.0, 5.0}, "start": "09:00", "end": "17:00",
		}},
	}
	apiInput := map[string]any{
		"credential": "pagerduty-api", "requesterEmail": "operator@example.com",
		"region": "us", "incidentId": "{{context.on_pagerduty.output.event.incidentId}}",
	}
	snoozeInput := map[string]any{}
	for key, value := range apiInput {
		snoozeInput[key] = value
	}
	snoozeInput["durationSeconds"] = 43_200
	workflow := map[string]any{
		"id": wfID, "name": "PagerDuty off-hours", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "on_pagerduty", "type": "pagerduty_incident",
				"config": map[string]any{"webhookCredential": "pagerduty-webhook"}},
			map[string]any{"id": "load_incident", "type": "tool", "config": map[string]any{
				"tool": "pagerduty.incident.get", "resultPolicy": "require_ok", "input": apiInput,
			}},
			map[string]any{"id": "evaluate_policy", "type": "tool", "config": map[string]any{
				"tool": "pagerduty.policy.evaluate", "input": policyInput,
			}},
			map[string]any{"id": "acknowledge_incident", "type": "tool", "config": map[string]any{
				"tool": "pagerduty.incident.acknowledge", "resultPolicy": "require_ok", "input": apiInput,
			}},
			map[string]any{"id": "snooze_incident", "type": "tool", "config": map[string]any{
				"tool": "pagerduty.incident.snooze", "resultPolicy": "require_ok", "input": snoozeInput,
			}},
			map[string]any{"id": "action_evidence", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{
					"incidentId": "{{context.on_pagerduty.output.event.incidentId}}",
					"decision":   "{{context.evaluate_policy.output.result.reason}}",
				},
			}},
			map[string]any{"id": "ignored_evidence", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{
					"decision":    "{{context.evaluate_policy.output.result.reason}}",
					"actionTaken": false,
				},
			}},
		},
		"edges": []any{
			map[string]any{"from": "on_pagerduty", "to": "load_incident"},
			map[string]any{"from": "load_incident", "to": "evaluate_policy"},
			map[string]any{"from": "evaluate_policy", "to": "acknowledge_incident",
				"condition": "context.evaluate_policy.output.result.shouldAct === true"},
			map[string]any{"from": "evaluate_policy", "to": "ignored_evidence",
				"condition": "context.evaluate_policy.output.result.shouldAct === false"},
			// Skip does NOT cascade through unconditioned edges (same
			// readiness semantics as the contract runtime), so the whole
			// mutation chain carries the policy condition.
			map[string]any{"from": "acknowledge_incident", "to": "snooze_incident",
				"condition": "context.evaluate_policy.output.result.shouldAct === true"},
			map[string]any{"from": "snooze_incident", "to": "action_evidence",
				"condition": "context.evaluate_policy.output.result.shouldAct === true"},
		},
	}
	if res := h.call("POST", "/v1/workflows/save", workflow, ""); res.status != 200 {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}

	callback := h.server.URL + "/webhooks/pagerduty/" + wfID + "/on_pagerduty"
	post := func(url, body, signature string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", url, bytes.NewReader([]byte(body)))
		req.Header.Set("content-type", "application/json")
		if signature != "" {
			req.Header.Set("x-pagerduty-signature", signature)
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

	// Defense ladder before any pipeline work.
	offHours := pagerDutyEventBody("pdevt-1-"+suffix, "PINC1", "2026-01-10T03:00:00Z") // Saturday
	if status, _ := post(callback, offHours, "v1="+strings.Repeat("a", 64)); status != 403 {
		t.Fatalf("bad signature must 403: %d", status)
	}
	if status, _ := post(callback, offHours, ""); status != 403 {
		t.Fatalf("missing signature must 403: %d", status)
	}
	if status, _ := post(h.server.URL+"/webhooks/pagerduty/"+wfID+"/ghost-node",
		offHours, pagerDutySign(signingSecret, offHours)); status != 404 {
		t.Fatalf("unknown node must 404: %d", status)
	}
	if status, _ := post(callback, `{"event":{}}`,
		pagerDutySign(signingSecret, `{"event":{}}`)); status != 400 {
		t.Fatalf("invalid payload must 400: %d", status)
	}

	// Off-hours event: acknowledge + snooze fire exactly once.
	status, body := post(callback, offHours, pagerDutySign(signingSecret, offHours))
	if status != 200 || body["ok"] != true {
		t.Fatalf("signed ingest: %d %+v", status, body)
	}
	runID, _ := body["runId"].(string)
	if runID == "" {
		t.Fatalf("ingest must start a run: %+v", body)
	}
	h.waitRun(runID, "succeeded")
	if ackCount.Load() != 1 || snoozeCount.Load() != 1 {
		t.Fatalf("mutations after off-hours run: ack=%d snooze=%d", ackCount.Load(), snoozeCount.Load())
	}

	// EXACT redelivery converges without a second run or second mutation.
	status, body = post(callback, offHours, pagerDutySign(signingSecret, offHours))
	if status != 200 || body["duplicate"] != true {
		t.Fatalf("redelivery must dedupe: %d %+v", status, body)
	}
	if ackCount.Load() != 1 {
		t.Fatalf("duplicate delivery must not mutate again: %d", ackCount.Load())
	}

	// In-hours event (Wednesday 10:00 UTC): the run completes on the
	// no-action branch — no new mutations.
	inHours := pagerDutyEventBody("pdevt-2-"+suffix, "PINC2", "2026-01-07T10:00:00Z")
	status, body = post(callback, inHours, pagerDutySign(signingSecret, inHours))
	if status != 200 || body["ok"] != true {
		t.Fatalf("in-hours ingest: %d %+v", status, body)
	}
	inHoursRunID, _ := body["runId"].(string)
	h.waitRun(inHoursRunID, "succeeded")
	if ackCount.Load() != 1 || snoozeCount.Load() != 1 {
		t.Fatalf("in-hours event must not act: ack=%d snooze=%d", ackCount.Load(), snoozeCount.Load())
	}
	var ignoredReason string
	if err := pool.QueryRow(ctx,
		`SELECT state_json->'output'->'result'->>'reason' FROM run_nodes WHERE run_id = $1 AND node_id = 'evaluate_policy'`,
		inHoursRunID).Scan(&ignoredReason); err != nil || ignoredReason != "event_in_working_hours" {
		t.Fatalf("in-hours reason: %q %v", ignoredReason, err)
	}

	// Every API-backed call left a usage row through the chokepoint.
	var usageRows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM usage_events WHERE org_id = $1 AND metric LIKE 'tool.pagerduty.%'`,
		h.org).Scan(&usageRows); err != nil || usageRows < 3 {
		t.Fatalf("usage rows: %d %v", usageRows, err)
	}
}
