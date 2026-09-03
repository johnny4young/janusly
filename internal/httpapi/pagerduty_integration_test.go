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
	"sync"
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

// pagerDutyAcknowledgeRequestIncidentID deliberately models PagerDuty's bulk
// incident-management contract, even though Janusly mutates exactly one
// incident. Keeping the simulator strict prevents a path/envelope mistake from
// producing a false-green flagship journey.
func pagerDutyAcknowledgeRequestIncidentID(r *http.Request) (string, bool) {
	if r.Method != http.MethodPut || r.URL.Path != "/pagerduty/incidents" {
		return "", false
	}
	var request struct {
		Incidents []struct {
			ID     string `json:"id"`
			Type   string `json:"type"`
			Status string `json:"status"`
		} `json:"incidents"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || len(request.Incidents) != 1 ||
		request.Incidents[0].ID == "" || request.Incidents[0].Type != "incident_reference" ||
		request.Incidents[0].Status != "acknowledged" {
		return "", false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return "", false
	}
	return request.Incidents[0].ID, true
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
		case r.Method == http.MethodPut && r.URL.Path == "/pagerduty/incidents":
			incidentID, valid := pagerDutyAcknowledgeRequestIncidentID(r)
			if !valid {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			ackCount.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"incidents": []any{map[string]any{
				"id": incidentID, "status": "acknowledged",
			}}})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/snooze"):
			snoozeCount.Add(1)
			incidentID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/pagerduty/incidents/"), "/snooze")
			_ = json.NewEncoder(w).Encode(map[string]any{"incident": map[string]any{
				"id": incidentID, "status": "acknowledged",
				"pending_actions": []any{map[string]any{
					"type": "unacknowledge", "at": time.Now().UTC().Add(12 * time.Hour).Format(time.RFC3339Nano),
				}},
			}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer simulator.Close()
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
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
		"evaluatedAt":     "{{context.on_pagerduty.output.event.occurredAt}}",
		"incident":        "{{context.load_incident.output.result.incident}}",
		"pagerDutyUserId": "PUSER1",
		"snoozeSeconds":   43_200,
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
	invalidOccurredAt := pagerDutyEventBody("pdevt-invalid-time-"+suffix, "PINC0", "not-a-time")
	if status, _ := post(callback, invalidOccurredAt,
		pagerDutySign(signingSecret, invalidOccurredAt)); status != 400 {
		t.Fatalf("invalid occurred_at must 400 instead of using receipt time: %d", status)
	}
	oversizedIncidentID := pagerDutyEventBody("pdevt-oversized-"+suffix, strings.Repeat("P", 301), "2026-01-10T03:00:00Z")
	if status, _ := post(callback, oversizedIncidentID,
		pagerDutySign(signingSecret, oversizedIncidentID)); status != 400 {
		t.Fatalf("oversized incident identifier must 400 instead of being truncated: %d", status)
	}

	// Off-hours event: acknowledge + snooze fire exactly once.
	status, body := post(callback, offHours, pagerDutySign(signingSecret, offHours))
	if status != 200 || body["ok"] != true {
		t.Fatalf("signed ingest: %d %+v", status, body)
	}
	expectedTriggerEventID := pagerDutyTriggerEventID(h.org, wfID, "on_pagerduty", "pdevt-1-"+suffix)
	if body["triggerEventId"] != expectedTriggerEventID {
		t.Fatalf("provider delivery must use a stable rollout key: got=%v want=%s", body["triggerEventId"], expectedTriggerEventID)
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
	if body["triggerEventId"] != expectedTriggerEventID {
		t.Fatalf("redelivery changed rollout assignment identity: got=%v want=%s", body["triggerEventId"], expectedTriggerEventID)
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

	// Credential expiration is an authorization boundary, not catalog
	// metadata. Even a cryptographically valid signature must stop before
	// trigger persistence once the selected webhook secret expires.
	if _, err := pool.Exec(ctx, `UPDATE credentials SET expires_at=now()-interval '1 second'
		WHERE org_id=$1 AND kind='pagerduty_webhook_secret' AND name='pagerduty-webhook'`, h.org); err != nil {
		t.Fatal(err)
	}
	expiredEventID := "pdevt-expired-" + suffix
	expiredBody := pagerDutyEventBody(expiredEventID, "PINC_EXPIRED", "2026-01-10T03:00:00Z")
	if status, _ := post(callback, expiredBody, pagerDutySign(signingSecret, expiredBody)); status != http.StatusForbidden {
		t.Fatalf("expired webhook credential must reject a valid signature: %d", status)
	}
	var expiredAnchors int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM trigger_events WHERE org_id=$1 AND dedupe_key=$2`,
		h.org, "pagerduty:"+wfID+":on_pagerduty:"+expiredEventID).Scan(&expiredAnchors); err != nil || expiredAnchors != 0 {
		t.Fatalf("expired credential persisted an event: count=%d err=%v", expiredAnchors, err)
	}
}

// A storm-limit settlement is durable authority not to start. When many
// signed retries race on the same event, exactly one request may settle the
// event as rate_limited and every lock waiter must converge to that row instead
// of interpreting `status != received` as admission.
func TestPagerDutyConcurrentRateLimitSettlementNeverStartsRun(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	suffix := fmt.Sprint(time.Now().UnixNano())
	credentialName := "pagerduty-webhook-storm-" + suffix
	signingSecret := "pagerduty-signing-storm-" + suffix
	if res := h.call("POST", "/credentials", map[string]any{
		"name": credentialName, "kind": "pagerduty_webhook_secret", "secretValue": signingSecret,
	}, ""); res.status != http.StatusOK {
		t.Fatalf("credential: %d %+v", res.status, res.body)
	}

	wfID := "wf-pagerduty-storm-" + suffix
	if res := h.call("POST", "/v1/workflows/save", map[string]any{
		"id": wfID, "name": "PagerDuty storm settlement", "dslVersion": "1.0",
		"nodes": []any{
			map[string]any{"id": "on_pagerduty", "type": "pagerduty_incident", "config": map[string]any{
				"webhookCredential": credentialName, "rateLimitPerMin": 1,
			}},
			map[string]any{"id": "after_trigger", "type": "noop", "config": map[string]any{}},
		},
		"edges": []any{map[string]any{"from": "on_pagerduty", "to": "after_trigger"}},
	}, ""); res.status != http.StatusOK {
		t.Fatalf("save: %d %+v", res.status, res.body)
	}
	var versionID string
	if err := pool.QueryRow(t.Context(), `SELECT id FROM workflow_versions
		WHERE org_id=$1 AND workflow_id=$2 ORDER BY version DESC LIMIT 1`, h.org, wfID).Scan(&versionID); err != nil {
		t.Fatal(err)
	}
	bucket := "trigger." + versionID + ".on_pagerduty"
	if _, err := pool.Exec(t.Context(), `INSERT INTO rate_limit_windows
		(name,key,window_start,count,expires_at)
		VALUES ($1,$2,date_trunc('minute',now()),1,date_trunc('minute',now())+interval '1 minute')`,
		bucket, h.org); err != nil {
		t.Fatal(err)
	}

	providerEventID := "pagerduty-storm-event-" + suffix
	body := pagerDutyEventBody(providerEventID, "PINC_STORM", time.Now().UTC().Format(time.RFC3339Nano))
	callback := h.server.URL + "/webhooks/pagerduty/" + wfID + "/on_pagerduty"
	type response struct {
		status int
		body   map[string]any
		err    error
	}
	const contenders = 12
	start := make(chan struct{})
	responses := make(chan response, contenders)
	var group sync.WaitGroup
	for range contenders {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			req, _ := http.NewRequest(http.MethodPost, callback, strings.NewReader(body))
			req.Header.Set("content-type", "application/json")
			req.Header.Set("x-pagerduty-signature", pagerDutySign(signingSecret, body))
			providerResponse, err := http.DefaultClient.Do(req)
			if err != nil {
				responses <- response{err: err}
				return
			}
			defer providerResponse.Body.Close()
			var envelope map[string]any
			err = json.NewDecoder(providerResponse.Body).Decode(&envelope)
			responses <- response{status: providerResponse.StatusCode, body: envelope, err: err}
		}()
	}
	close(start)
	group.Wait()
	close(responses)

	var limited, duplicates int
	for result := range responses {
		if result.err != nil {
			t.Fatalf("concurrent callback: %v", result.err)
		}
		switch {
		case result.status == http.StatusTooManyRequests && result.body["reason"] == "rate_limited":
			limited++
		case result.status == http.StatusOK && result.body["duplicate"] == true:
			duplicates++
		default:
			t.Fatalf("unexpected concurrent callback: %d %+v", result.status, result.body)
		}
	}
	if limited != 1 || duplicates != contenders-1 {
		t.Fatalf("concurrent settlement: limited=%d duplicates=%d", limited, duplicates)
	}

	triggerEventID := pagerDutyTriggerEventID(h.org, wfID, "on_pagerduty", providerEventID)
	var status, skippedReason, runID string
	if err := pool.QueryRow(t.Context(), `SELECT status, skipped_reason, coalesce(run_id,'') FROM trigger_events
		WHERE org_id=$1 AND id=$2`, h.org, triggerEventID).Scan(&status, &skippedReason, &runID); err != nil ||
		status != "skipped" || skippedReason != "rate_limited" || runID != "" {
		t.Fatalf("durable settlement: status=%s reason=%s run=%v err=%v", status, skippedReason, runID, err)
	}
	var runs, count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM runs WHERE org_id=$1 AND workflow_version_id=$2`,
		h.org, versionID).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("rate-limited event started %d runs err=%v", runs, err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT count FROM rate_limit_windows WHERE name=$1 AND key=$2`,
		bucket, h.org).Scan(&count); err != nil || count != 2 {
		t.Fatalf("storm settlement consumed count=%d err=%v", count, err)
	}
}

// A provider retry can arrive after the event anchor was committed but before
// StartRun claimed it. Saving a newer workflow in that crash window must not
// change the behavior already captured by the accepted event.
func TestPagerDutyCrashWindowUsesPersistedWorkflowSnapshot(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	suffix := fmt.Sprint(time.Now().UnixNano())
	capturedCredentialName := "pagerduty-webhook-crash-captured-" + suffix
	currentCredentialName := "pagerduty-webhook-crash-current-" + suffix
	capturedSigningSecret := "pagerduty-signing-crash-captured-" + suffix
	rotatedCapturedSigningSecret := "pagerduty-signing-crash-rotated-" + suffix
	currentSigningSecret := "pagerduty-signing-crash-current-" + suffix
	for _, credential := range []map[string]any{
		{"name": capturedCredentialName, "kind": "pagerduty_webhook_secret", "secretValue": capturedSigningSecret},
		{"name": currentCredentialName, "kind": "pagerduty_webhook_secret", "secretValue": currentSigningSecret},
	} {
		if res := h.call("POST", "/credentials", credential, ""); res.status != http.StatusOK {
			t.Fatalf("credential %s: %d %+v", credential["name"], res.status, res.body)
		}
	}

	wfID := "wf-pd-crash-" + suffix
	workflow := func(marker, webhookCredential string) map[string]any {
		return map[string]any{
			"id": wfID, "name": "PagerDuty crash convergence", "dslVersion": "1.0",
			"nodes": []any{
				map[string]any{"id": "on_pagerduty", "type": "pagerduty_incident", "config": map[string]any{
					"webhookCredential": webhookCredential,
				}},
				map[string]any{"id": marker, "type": "noop", "config": map[string]any{}},
			},
			"edges": []any{map[string]any{"from": "on_pagerduty", "to": marker}},
		}
	}
	if res := h.call("POST", "/v1/workflows/save", workflow("captured_marker", capturedCredentialName), ""); res.status != http.StatusOK {
		t.Fatalf("save captured version: %d %+v", res.status, res.body)
	}
	var capturedVersionID string
	if err := pool.QueryRow(t.Context(), `SELECT id FROM workflow_versions
		WHERE org_id=$1 AND workflow_id=$2 ORDER BY version DESC LIMIT 1`, h.org, wfID).Scan(&capturedVersionID); err != nil {
		t.Fatal(err)
	}
	if res := h.call("POST", "/v1/workflows/save", workflow("latest_marker", currentCredentialName), ""); res.status != http.StatusOK {
		t.Fatalf("save latest version: %d %+v", res.status, res.body)
	}
	var latestVersionID string
	if err := pool.QueryRow(t.Context(), `SELECT id FROM workflow_versions
		WHERE org_id=$1 AND workflow_id=$2 ORDER BY version DESC LIMIT 1`, h.org, wfID).Scan(&latestVersionID); err != nil {
		t.Fatal(err)
	}

	providerEventID := "pdevt-crash-" + suffix
	triggerEventID := pagerDutyTriggerEventID(h.org, wfID, "on_pagerduty", providerEventID)
	dedupeKey := "pagerduty:" + wfID + ":on_pagerduty:" + providerEventID
	persistedPayload, _ := json.Marshal(map[string]any{"event": map[string]any{
		"eventId": providerEventID, "eventType": "incident.triggered", "incidentId": "PINC_CRASH",
		"occurredAt": "2026-01-10T03:00:00Z", "receivedAt": "2026-01-10T03:00:01Z",
	}})
	if _, err := pool.Exec(t.Context(), `INSERT INTO trigger_events
		(id, org_id, trigger_type, workflow_id, workflow_version_id, node_id, status, dedupe_key, payload_json, rate_admitted_at)
		VALUES ($1,$2,'pagerduty_incident',$3,$4,'on_pagerduty','received',$5,$6,now())`,
		triggerEventID, h.org, wfID, capturedVersionID, dedupeKey, persistedPayload); err != nil {
		t.Fatal(err)
	}
	rateBucket := "trigger." + capturedVersionID + ".on_pagerduty"
	if _, err := pool.Exec(t.Context(), `INSERT INTO rate_limit_windows
		(name,key,window_start,count,expires_at)
		VALUES ($1,$2,date_trunc('minute',now()),1000000,date_trunc('minute',now())+interval '1 minute')`,
		rateBucket, h.org); err != nil {
		t.Fatal(err)
	}

	body := pagerDutyEventBody(providerEventID, "PINC_CRASH", "2026-01-10T03:00:00Z")
	callback := h.server.URL + "/webhooks/pagerduty/" + wfID + "/on_pagerduty"
	post := func(eventBody, signingSecret string) (int, map[string]any) {
		req, _ := http.NewRequest(http.MethodPost, callback, strings.NewReader(eventBody))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-pagerduty-signature", pagerDutySign(signingSecret, eventBody))
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var envelope map[string]any
		_ = json.NewDecoder(response.Body).Decode(&envelope)
		return response.StatusCode, envelope
	}
	// A damaged current snapshot is an infrastructure failure for a new
	// delivery, but must not strand an already accepted event whose immutable
	// snapshot and credential binding were committed before the crash.
	if _, err := pool.Exec(t.Context(), `UPDATE workflow_versions
		SET dag_json='{"nodes":"corrupt","edges":[]}'::jsonb
		WHERE org_id=$1 AND id=$2`, h.org, latestVersionID); err != nil {
		t.Fatalf("corrupt latest snapshot: %v", err)
	}

	// The accepted event owns the logical credential binding, not retired
	// secret material. Rotating that same binding revokes the old version and
	// makes the current live secret the only authority for its retry.
	preview := h.call("POST", "/credentials/"+capturedCredentialName+"/bulk-update", map[string]any{
		"dryRun": true,
	}, "")
	if preview.status != http.StatusOK {
		t.Fatalf("preview captured credential rotation: %d %+v", preview.status, preview.body)
	}
	ifMatch, ok := preview.body["updatedAt"].(string)
	if !ok || ifMatch == "" {
		t.Fatalf("captured credential preview omitted ifMatch authority: %+v", preview.body)
	}
	rotation := h.call("POST", "/credentials/"+capturedCredentialName+"/bulk-update", map[string]any{
		"newSecretValue": rotatedCapturedSigningSecret,
		"ifMatch":        ifMatch,
	}, "")
	if rotation.status != http.StatusOK {
		t.Fatalf("rotate captured credential: %d %+v", rotation.status, rotation.body)
	}
	if status, _ := post(body, capturedSigningSecret); status != http.StatusForbidden {
		t.Fatalf("revoked secret retained accepted-event authority: %d", status)
	}

	// Current authority cannot take ownership of the accepted event, even
	// though that different logical binding is valid for new deliveries on the
	// latest DAG.
	if status, _ := post(body, currentSigningSecret); status != http.StatusForbidden {
		t.Fatalf("current credential inherited accepted-event authority: %d", status)
	}

	responseStatus, envelope := post(body, rotatedCapturedSigningSecret)
	if responseStatus != http.StatusOK || envelope["ok"] != true {
		t.Fatalf("retry: %d %+v", responseStatus, envelope)
	}
	runID, _ := envelope["runId"].(string)
	h.waitRun(runID, "succeeded")
	var runVersionID string
	if err := pool.QueryRow(t.Context(), `SELECT workflow_version_id FROM runs WHERE org_id=$1 AND id=$2`, h.org, runID).Scan(&runVersionID); err != nil {
		t.Fatal(err)
	}
	if runVersionID != capturedVersionID {
		t.Fatalf("crash retry ran mutable latest version: got=%s want=%s", runVersionID, capturedVersionID)
	}
	var capturedNodes, latestNodes int
	if err := pool.QueryRow(t.Context(), `SELECT
		count(*) FILTER (WHERE node_id='captured_marker'),
		count(*) FILTER (WHERE node_id='latest_marker')
		FROM run_nodes WHERE run_id=$1`, runID).Scan(&capturedNodes, &latestNodes); err != nil {
		t.Fatal(err)
	}
	if capturedNodes != 1 || latestNodes != 0 {
		t.Fatalf("crash retry topology drifted: captured=%d latest=%d", capturedNodes, latestNodes)
	}
	var rateCount int
	if err := pool.QueryRow(t.Context(), `SELECT count FROM rate_limit_windows
		WHERE name=$1 AND key=$2 ORDER BY window_start DESC LIMIT 1`, rateBucket, h.org).Scan(&rateCount); err != nil || rateCount != 1_000_000 {
		t.Fatalf("crash retry consumed the storm budget twice: count=%d err=%v", rateCount, err)
	}

	// The captured logical binding is not a general fallback: without an
	// already accepted dedupe row it cannot authenticate a new event after the
	// latest workflow moved to a different binding.
	freshBody := pagerDutyEventBody("pdevt-fresh-after-rotation-"+suffix, "PINC_FRESH", "2026-01-10T03:00:00Z")
	if status, _ := post(freshBody, rotatedCapturedSigningSecret); status != http.StatusInternalServerError {
		t.Fatalf("malformed current snapshot was masked as a permanent provider error: %d", status)
	}
	latestDag, err := json.Marshal(workflow("latest_marker", currentCredentialName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE workflow_versions SET dag_json=$1
		WHERE org_id=$2 AND id=$3`, latestDag, h.org, latestVersionID); err != nil {
		t.Fatalf("restore latest snapshot: %v", err)
	}
	if status, _ := post(freshBody, rotatedCapturedSigningSecret); status != http.StatusForbidden {
		t.Fatalf("captured credential authenticated a fresh event after rotation: %d", status)
	}
}

// The authored flagship, not a hand-built test DAG: natural language compiles
// locally, the signed callback drives both provider writes, an authoritative
// re-read proves the outcome, and a deliberately inconsistent provider reply
// opens the V2 semantic recovery case without an LLM.
func TestCompiledPagerDutyFlagshipVerifiesProviderOutcome(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())

	var providerMu sync.Mutex
	providerStatuses := map[string]string{}
	providerSnoozeUntil := map[string]string{}
	var readCount, acknowledgeCount, snoozeCount atomic.Int32
	simulator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var incidentID string
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/pagerduty/incidents":
			var valid bool
			incidentID, valid = pagerDutyAcknowledgeRequestIncidentID(r)
			if !valid {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/pagerduty/incidents/"):
			incidentID = strings.TrimPrefix(r.URL.Path, "/pagerduty/incidents/")
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/pagerduty/incidents/") &&
			strings.HasSuffix(r.URL.Path, "/snooze"):
			incidentID = strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/pagerduty/incidents/"), "/snooze")
		default:
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if incidentID == "" || strings.Contains(incidentID, "/") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		providerMu.Lock()
		defer providerMu.Unlock()
		status := providerStatuses[incidentID]
		if status == "" {
			status = "triggered"
		}
		switch {
		case r.Method == http.MethodGet:
			readCount.Add(1)
			pendingActions := []any{}
			if snoozeUntil := providerSnoozeUntil[incidentID]; snoozeUntil != "" {
				pendingActions = append(pendingActions, map[string]any{
					"type": "unacknowledge", "at": snoozeUntil,
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"incident": map[string]any{
				"id": incidentID, "status": status, "title": "flagship incident", "urgency": "high",
				"service":         map[string]any{"id": "PSVC1"},
				"assignments":     []any{map[string]any{"assignee": map[string]any{"id": "PUSER1"}}},
				"pending_actions": pendingActions,
			}})
		case r.Method == http.MethodPut:
			acknowledgeCount.Add(1)
			// This incident simulates a provider that accepts the request but
			// never exposes the expected authoritative state afterward.
			if incidentID != "PINC_BROKEN" {
				providerStatuses[incidentID] = "acknowledged"
				status = "acknowledged"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"incidents": []any{map[string]any{
				"id": incidentID, "status": "acknowledged",
			}}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/snooze"):
			snoozeCount.Add(1)
			var requestBody struct {
				Duration int `json:"duration"`
			}
			_ = json.NewDecoder(r.Body).Decode(&requestBody)
			snoozeUntil := time.Now().UTC().Add(time.Duration(requestBody.Duration) * time.Second).Format(time.RFC3339Nano)
			if incidentID != "PINC_BROKEN" {
				providerSnoozeUntil[incidentID] = snoozeUntil
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"incident": map[string]any{
				"id": incidentID, "status": "acknowledged",
				"pending_actions": []any{map[string]any{
					"type": "unacknowledge", "at": snoozeUntil,
				}},
			}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(simulator.Close)
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_STACK", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", simulator.URL)

	apiCredential := "pagerduty-api-" + suffix
	webhookCredential := "pagerduty-webhook-" + suffix
	signingSecret := "pagerduty-signing-" + suffix
	for _, credential := range []map[string]any{
		{"name": apiCredential, "kind": "pagerduty_api_token", "secretValue": "pagerduty-token-" + suffix},
		{"name": webhookCredential, "kind": "pagerduty_webhook_secret", "secretValue": signingSecret},
	} {
		if res := h.call("POST", "/credentials", credential, ""); res.status != http.StatusOK {
			t.Fatalf("credential %v: %d %+v", credential["name"], res.status, res.body)
		}
	}

	buildAuthoredWorkflow := func(prompt string) map[string]any {
		t.Helper()
		compiled := h.call("POST", "/v1/ai/workflow-briefs/compile", map[string]any{"prompt": prompt}, "")
		if compiled.status != http.StatusOK {
			t.Fatalf("compile flagship brief: %d %+v", compiled.status, compiled.body)
		}
		compiledData, _ := compiled.body["data"].(map[string]any)
		if compiledData["complete"] != true || compiledData["mode"] != "deterministic" {
			t.Fatalf("compiled flagship brief: %+v", compiledData)
		}
		catalog := h.call("GET", "/v1/authoring/capabilities", nil, "")
		catalogData, _ := catalog.body["data"].(map[string]any)
		proposed := h.call("POST", "/v1/ai/workflow-proposals", map[string]any{
			"prompt": prompt, "brief": compiledData["brief"], "catalogVersion": catalogData["version"],
		}, "")
		if proposed.status != http.StatusOK {
			t.Fatalf("build flagship proposal: %d %+v", proposed.status, proposed.body)
		}
		proposedData, _ := proposed.body["data"].(map[string]any)
		bindings, _ := proposedData["bindings"].(map[string]any)
		proposal, _ := proposedData["proposal"].(map[string]any)
		workflow, _ := proposal["workflow"].(map[string]any)
		if proposedData["mode"] != "fallback" || proposedData["aiError"] != nil ||
			bindings["complete"] != true || proposal["applicable"] != true || workflow == nil {
			t.Fatalf("flagship proposal is not provider-free and applicable: %+v", proposedData)
		}
		return workflow
	}

	now := time.Now().UTC().Truncate(time.Second)
	windowStart := now.Add(10 * time.Hour).Format("15:04")
	windowEnd := now.Add(11 * time.Hour).Format("15:04")
	prompt := fmt.Sprintf(
		"From %s to %s, when PagerDuty alerts user PUSER1 outside working hours %s to %s in UTC, acknowledge it and snooze it for 12 hours. Use API credential %s and webhook credential %s for operator@example.com.",
		now.AddDate(0, 0, -1).Format(time.DateOnly), now.AddDate(0, 0, 7).Format(time.DateOnly),
		windowStart, windowEnd, apiCredential, webhookCredential,
	)
	document := buildAuthoredWorkflow(prompt)
	wfID := document["id"].(string)
	if res := h.call("POST", "/v1/workflows/save", document, ""); res.status != http.StatusOK {
		t.Fatalf("save authored flagship: %d %+v", res.status, res.body)
	}

	postEvent := func(eventID, incidentID string) string {
		t.Helper()
		body := pagerDutyEventBody(eventID, incidentID, now.Add(-time.Second).Format(time.RFC3339))
		req, _ := http.NewRequest(http.MethodPost,
			h.server.URL+"/webhooks/pagerduty/"+wfID+"/on_pagerduty", strings.NewReader(body))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-pagerduty-signature", pagerDutySign(signingSecret, body))
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("post flagship event: %v", err)
		}
		defer response.Body.Close()
		var envelope map[string]any
		_ = json.NewDecoder(response.Body).Decode(&envelope)
		if response.StatusCode != http.StatusOK || envelope["ok"] != true {
			t.Fatalf("post flagship event: %d %+v", response.StatusCode, envelope)
		}
		runID, _ := envelope["runId"].(string)
		if runID == "" {
			t.Fatalf("missing run id: %+v", envelope)
		}
		return runID
	}

	verifiedRunID := postEvent("flagship-pass-"+suffix, "PINC_VERIFIED")
	h.waitRun(verifiedRunID, "succeeded")
	var verified, snoozeVerified bool
	if err := pool.QueryRow(t.Context(), `SELECT
		coalesce((state_json->'output'->>'verified')::bool, false),
		coalesce((state_json->'output'->>'snoozeVerified')::bool, false)
		FROM run_nodes WHERE run_id=$1 AND node_id='action_evidence'`, verifiedRunID).Scan(&verified, &snoozeVerified); err != nil || !verified || !snoozeVerified {
		t.Fatalf("verified action evidence: verified=%v snooze=%v err=%v", verified, snoozeVerified, err)
	}
	var verifiedOutputJSON []byte
	if err := pool.QueryRow(t.Context(), `SELECT output_json FROM runs WHERE id=$1`, verifiedRunID).Scan(&verifiedOutputJSON); err != nil {
		t.Fatal(err)
	}
	var verifiedOutput map[string]any
	_ = json.Unmarshal(verifiedOutputJSON, &verifiedOutput)
	verifiedResult, _ := verifiedOutput["result"].(map[string]any)
	verifiedAction, _ := verifiedResult["action"].(map[string]any)
	if verifiedAction["verified"] != true || verifiedAction["actionTaken"] != true {
		t.Fatalf("stable flagship intent output missing verified action evidence: %s", verifiedOutputJSON)
	}
	var verifiedCases int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM recovery_cases WHERE org_id=$1 AND run_id=$2`, h.org, verifiedRunID).Scan(&verifiedCases); err != nil || verifiedCases != 0 {
		t.Fatalf("verified run recovery cases=%d err=%v", verifiedCases, err)
	}

	// A distinct PagerDuty delivery for an incident Janusly already
	// acknowledged is not authority to extend its snooze. The fresh
	// authoritative read must choose the explicit no-action branch.
	repeatedRunID := postEvent("flagship-repeat-"+suffix, "PINC_VERIFIED")
	h.waitRun(repeatedRunID, "succeeded")
	var repeatedDecision string
	var repeatedAction bool
	if err := pool.QueryRow(t.Context(), `SELECT
		state_json->'output'->>'decision',
		coalesce((state_json->'output'->>'actionTaken')::bool, true)
		FROM run_nodes WHERE run_id=$1 AND node_id='ignored_evidence'`, repeatedRunID).
		Scan(&repeatedDecision, &repeatedAction); err != nil ||
		repeatedDecision != "incident_already_acknowledged" || repeatedAction {
		t.Fatalf("repeat incident no-action evidence: decision=%q action=%v err=%v",
			repeatedDecision, repeatedAction, err)
	}

	brokenRunID := postEvent("flagship-broken-"+suffix, "PINC_BROKEN")
	h.waitRun(brokenRunID, "succeeded")
	var caseState string
	if err := pool.QueryRow(t.Context(), `SELECT state FROM recovery_cases
		WHERE org_id=$1 AND run_id=$2 AND detector_id='pagerduty_action_verified'`, h.org, brokenRunID).Scan(&caseState); err != nil || caseState != "detected" {
		t.Fatalf("unverified provider outcome case: state=%q err=%v", caseState, err)
	}

	// Human approval is not durable authority to act later. Change the
	// provider's incident state while the run waits; after approval the authored
	// graph must re-read and re-evaluate, record no-action evidence, and perform
	// neither write.
	approvalPrompt := prompt + " Require human approval before the PagerDuty writes."
	approvalDocument := buildAuthoredWorkflow(approvalPrompt)
	wfID = approvalDocument["id"].(string)
	if res := h.call("POST", "/v1/workflows/save", approvalDocument, ""); res.status != http.StatusOK {
		t.Fatalf("save approval flagship: %d %+v", res.status, res.body)
	}
	staleRunID := postEvent("flagship-stale-approval-"+suffix, "PINC_STALE")
	waitNodeWaiting(t, h, staleRunID)
	providerMu.Lock()
	providerStatuses["PINC_STALE"] = "resolved"
	providerMu.Unlock()
	if res := h.call("POST", "/v1/resume", map[string]any{
		"runId": staleRunID, "nodeId": "approve_action",
	}, ""); res.status != http.StatusOK {
		t.Fatalf("approve stale flagship: %d %+v", res.status, res.body)
	}
	h.waitRun(staleRunID, "succeeded")
	var staleDecision string
	var actionTaken, approvalRequired, approvalRevalidated bool
	if err := pool.QueryRow(t.Context(), `SELECT
		state_json->'output'->>'decision',
		coalesce((state_json->'output'->>'actionTaken')::bool, true),
		coalesce((state_json->'output'->>'approvalRequired')::bool, false),
		coalesce((state_json->'output'->>'approvalRevalidated')::bool, true)
		FROM run_nodes WHERE run_id=$1 AND node_id='stale_approval_evidence'`, staleRunID).
		Scan(&staleDecision, &actionTaken, &approvalRequired, &approvalRevalidated); err != nil || staleDecision != "incident_resolved" || actionTaken || !approvalRequired || approvalRevalidated {
		t.Fatalf("stale approval evidence: decision=%q action=%v required=%v revalidated=%v err=%v", staleDecision, actionTaken, approvalRequired, approvalRevalidated, err)
	}
	var staleOutputJSON []byte
	if err := pool.QueryRow(t.Context(), `SELECT output_json FROM runs WHERE id=$1`, staleRunID).Scan(&staleOutputJSON); err != nil {
		t.Fatal(err)
	}
	var staleOutput map[string]any
	_ = json.Unmarshal(staleOutputJSON, &staleOutput)
	staleResult, _ := staleOutput["result"].(map[string]any)
	staleEvidence, _ := staleResult["staleApproval"].(map[string]any)
	if staleEvidence["decision"] != "incident_resolved" || staleEvidence["actionTaken"] != false {
		t.Fatalf("stable flagship intent output missing stale-approval evidence: %s", staleOutputJSON)
	}

	// Catalog binding was valid when the workflow was authored, but runtime
	// authority expires independently. The signed trigger may start a run; the
	// first provider read must fail before egress once the API credential lapses.
	if _, err := pool.Exec(t.Context(), `UPDATE credentials SET expires_at=now()-interval '1 second'
		WHERE org_id=$1 AND kind='pagerduty_api_token' AND name=$2`, h.org, apiCredential); err != nil {
		t.Fatal(err)
	}
	expiredRunID := postEvent("flagship-expired-api-credential-"+suffix, "PINC_EXPIRED_API")
	h.waitRun(expiredRunID, "failed")

	if readCount.Load() != 7 || acknowledgeCount.Load() != 2 || snoozeCount.Load() != 2 {
		t.Fatalf("provider calls: read=%d acknowledge=%d snooze=%d", readCount.Load(), acknowledgeCount.Load(), snoozeCount.Load())
	}
}
