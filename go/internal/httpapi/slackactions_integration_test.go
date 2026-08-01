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
	"net/url"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/secretstore"
)

func slackSign(secret, body string, timestamp int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "v0:%d:%s", timestamp, body)
	return "v0=" + hex.EncodeToString(mac.Sum(nil))
}

func slackBody(actionID, value, teamID, slackUser string) string {
	payload, _ := json.Marshal(map[string]any{
		"type":    "block_actions",
		"team":    map[string]any{"id": teamID},
		"user":    map[string]any{"id": slackUser},
		"actions": []any{map[string]any{"action_id": actionID, "value": value}},
	})
	form := url.Values{}
	form.Set("payload", string(payload))
	return form.Encode()
}

// The signed Slack loop: admin config with credential validation, the
// callback's full defense ladder (signature, team, mapping, permission),
// the atomic replay receipt + acknowledge, and the duplicate short-circuit.
func TestSlackRecoveryActions(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	secretstore.ResetForTests()
	t.Cleanup(secretstore.ResetForTests)
	t.Setenv("JANUSLY_CREDENTIAL_MASTER_KEY",
		base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")))
	suffix := fmt.Sprint(time.Now().UnixNano())
	signingSecret := "slack-signing-" + suffix

	// The signing secret lives in the Secret Store (kind slack_signing_secret).
	if res := h.call("POST", "/credentials", map[string]any{
		"name": "slack-signing", "kind": "slack_signing_secret", "secretValue": signingSecret,
	}, ""); res.status != 200 {
		t.Fatalf("credential: %d %+v", res.status, res.body)
	}
	// Mapped member with editor role (the callback authorizes mode
	// supabase — no dev auto-admin, so the row must exist).
	if _, err := pool.Exec(ctx, `INSERT INTO org_members (id, org_id, user_id, role) VALUES (gen_random_uuid()::text, $1, 'oncall-user', 'editor')`,
		h.org); err != nil {
		t.Fatalf("member: %v", err)
	}

	// A ghost credential refuses the connection create.
	if res := h.call("POST", "/integrations/slack/interactions", map[string]any{
		"name": "team-hooks", "teamId": "T123", "signingCredentialName": "ghost",
		"userMappings": []any{},
	}, ""); res.status != 400 {
		t.Fatalf("ghost credential must 400: %d", res.status)
	}
	res := h.call("POST", "/integrations/slack/interactions", map[string]any{
		"name": "team-hooks", "teamId": "T123", "signingCredentialName": "slack-signing",
		"userMappings": []any{map[string]any{"slackUserId": "U777", "userId": "oncall-user"}},
	}, "")
	if res.status != 200 {
		t.Fatalf("create connection: %d %+v", res.status, res.body)
	}
	connectionID := res.body["connection"].(map[string]any)["id"].(string)

	// A recovery item to act on (via a failing run + replay claim).
	brokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer brokenServer.Close()
	workflow := map[string]any{
		"id": "wf-slack-" + suffix, "name": "Slack", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": brokenServer.URL, "timeoutMs": 500,
		}}},
		"edges": []any{},
	}
	res = h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
	runID := extractRunID(t, res)
	h.waitRun(runID, "failed")
	var dlqID, itemID string
	_ = pool.QueryRow(ctx, `SELECT id FROM dead_letters WHERE run_id = $1`, runID).Scan(&dlqID)
	_ = h.call("POST", "/dlq/replay", map[string]any{"deadLetterId": dlqID}, "")
	_ = pool.QueryRow(ctx, `SELECT id FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2`,
		h.org, dlqID).Scan(&itemID)

	post := func(body string, timestamp int64, signature string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", h.server.URL+"/webhooks/slack/interactions/"+connectionID,
			bytes.NewReader([]byte(body)))
		req.Header.Set("content-type", "application/x-www-form-urlencoded")
		req.Header.Set("x-slack-request-timestamp", fmt.Sprint(timestamp))
		req.Header.Set("x-slack-signature", signature)
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
	now := time.Now().Unix()

	// Defense ladder: bad signature, stale timestamp, wrong team, unmapped user.
	body := slackBody(slackActionAcknowledge, itemID, "T123", "U777")
	if status, _ := post(body, now, "v0="+string(bytes.Repeat([]byte("a"), 64))); status != 401 {
		t.Fatalf("bad signature must 401: %d", status)
	}
	stale := now - 3600
	if status, _ := post(body, stale, slackSign(signingSecret, body, stale)); status != 401 {
		t.Fatalf("stale timestamp must 401: %d", status)
	}
	wrongTeam := slackBody(slackActionAcknowledge, itemID, "T999", "U777")
	if status, _ := post(wrongTeam, now, slackSign(signingSecret, wrongTeam, now)); status != 403 {
		t.Fatalf("wrong team must 403: %d", status)
	}
	unmapped := slackBody(slackActionAcknowledge, itemID, "T123", "U000")
	if status, _ := post(unmapped, now, slackSign(signingSecret, unmapped, now)); status != 403 {
		t.Fatalf("unmapped user must 403: %d", status)
	}

	// The signed acknowledge lands atomically with its replay receipt.
	status, responseBody := post(body, now, slackSign(signingSecret, body, now))
	if status != 200 || responseBody["ok"] != true {
		t.Fatalf("acknowledge: %d %+v", status, responseBody)
	}
	var itemStatus, owner string
	_ = pool.QueryRow(ctx, `SELECT status, COALESCE(owner, '') FROM recovery_items WHERE id = $1`,
		itemID).Scan(&itemStatus, &owner)
	if itemStatus != "acknowledged" || owner != "oncall-user" {
		t.Fatalf("item after acknowledge: %s %s", itemStatus, owner)
	}
	// EXACT redelivery → duplicate, no second mutation.
	status, responseBody = post(body, now, slackSign(signingSecret, body, now))
	if status != 200 || responseBody["duplicate"] != true {
		t.Fatalf("redelivery must dedupe: %d %+v", status, responseBody)
	}
	// A FRESH acknowledge (new ts → new receipt) loses the CAS → 409.
	later := now + 1
	status, _ = post(body, later, slackSign(signingSecret, body, later))
	if status != 409 {
		t.Fatalf("second acknowledge must 409: %d", status)
	}
}
