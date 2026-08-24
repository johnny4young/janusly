//go:build integration

package engine

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Weekly digest: opt-in only, the state-row claim makes the send weekly
// and single-shot across sweeps, admins are the recipients, and the body
// carries the 7-day aggregates. The mailer is the simulator pointed at a
// local capture server so no real provider is touched.
func TestWeeklyDigestSendsOncePerWeekToAdmins(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	ctx, pool, eng, org := newHarness(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	var mu sync.Mutex
	var sent []map[string]any
	capture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var payload map[string]any
		_ = json.Unmarshal(raw, &payload)
		mu.Lock()
		sent = append(sent, payload)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "sim-1"})
	}))
	t.Cleanup(capture.Close)
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", capture.URL)

	seed := func(key, valueJSON, valueType string) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'email', 'test', $5)`, org+"-"+key, org, key, valueJSON, valueType); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	seed("email.provider", `"simulator"`, "string")

	// Not opted in: the sweep must not touch the org.
	eng.processWeeklyDigests(ctx, logger)
	if len(sent) != 0 {
		t.Fatal("no digest without the opt-in")
	}

	seed("digest.weeklyEnabled", "true", "boolean")
	// Built-in admins, custom roles inheriting admin, and one viewer; only
	// admin-ranked memberships receive.
	if _, err := pool.Exec(ctx, `INSERT INTO org_roles
		(id, org_id, name, inherits_from, description, is_builtin)
		VALUES ($1, $2, 'operations-admin', 'admin', 'test', false)`, org+"-digest-role", org); err != nil {
		t.Fatalf("seed custom admin role: %v", err)
	}
	for i, row := range []struct{ role, email string }{
		{"admin", "ada@example.com"}, {"admin", "grace@example.com"},
		{"operations-admin", "linus@example.com"}, {"viewer", "eve@example.com"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO org_members (id, org_id, user_id, email, role)
			VALUES ($1, $2, $3, $4, $5)`,
			fmt.Sprintf("%s-m%d", org, i), org, fmt.Sprintf("%s-u%d", org, i), row.email, row.role); err != nil {
			t.Fatalf("seed member: %v", err)
		}
	}
	// A week of runs: 3 ok, 1 failed, plus an open dead letter.
	for i, status := range []string{"succeeded", "succeeded", "succeeded", "failed"} {
		if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
			VALUES ($1, $2, $3, '{}', 'wv-digest')`, fmt.Sprintf("run-digest-%s-%d", org, i), org, status); err != nil {
			t.Fatalf("seed run: %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO dead_letters (id, org_id, run_id, node_id, attempt, node_json, error_json, workflow_json, status)
		VALUES ($1, $2, $3, 'n', 1, '{}', '{}', '{}', 'open')`, "dl-digest-"+org, org, "run-digest-"+org+"-3"); err != nil {
		t.Fatalf("seed dead letter: %v", err)
	}

	eng.processWeeklyDigests(ctx, logger)
	mu.Lock()
	firstBatch := len(sent)
	var body string
	var to string
	if firstBatch > 0 {
		body, _ = sent[0]["text"].(string)
		to, _ = sent[0]["to"].(string)
	}
	mu.Unlock()
	if firstBatch != 3 {
		t.Fatalf("both admins and only admins receive: %d", firstBatch)
	}
	if to != "ada@example.com" && to != "grace@example.com" && to != "linus@example.com" {
		t.Fatalf("recipient must be an admin: %q", to)
	}
	for _, needle := range []string{"Runs: 4", "3 succeeded", "1 failed", "75% success", "recovery: 1"} {
		if !strings.Contains(body, needle) {
			t.Fatalf("digest body %q must contain %q", body, needle)
		}
	}

	// Same sweep an hour later: the claim is not due — nothing sends.
	eng.processWeeklyDigests(ctx, logger)
	mu.Lock()
	after := len(sent)
	mu.Unlock()
	if after != firstBatch {
		t.Fatalf("digest must be weekly, got %d more sends", after-firstBatch)
	}

	// A week later (state row aged), the claim wins again.
	if _, err := pool.Exec(ctx, `UPDATE org_digest_state SET last_sent_at = now() - interval '8 days'
		WHERE org_id = $1`, org); err != nil {
		t.Fatalf("age state: %v", err)
	}
	eng.processWeeklyDigests(ctx, logger)
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		count := len(sent)
		mu.Unlock()
		if count == firstBatch+3 || time.Now().After(deadline) {
			if count != firstBatch+3 {
				t.Fatalf("aged claim must send again: %d", count)
			}
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// A partial provider outage records each successful recipient before releasing
// the lease. The next sweep resumes only the failed address and completes the
// week instead of either skipping it or duplicating the first email.
func TestWeeklyDigestResumesPartialDelivery(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	ctx, pool, eng, org := newHarness(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	var mu sync.Mutex
	requests := make([]string, 0, 3)
	failGrace := true
	capture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		to, _ := payload["to"].(string)
		mu.Lock()
		requests = append(requests, to)
		shouldFail := to == "grace@example.com" && failGrace
		if shouldFail {
			failGrace = false
		}
		mu.Unlock()
		if shouldFail {
			http.Error(w, "temporary provider outage", http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "sim-ok"})
	}))
	t.Cleanup(capture.Close)
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true")
	t.Setenv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", capture.URL)

	for _, row := range []struct{ key, value, valueType string }{
		{"email.provider", `"simulator"`, "string"},
		{"digest.weeklyEnabled", "true", "boolean"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs
			(id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'email', 'test', $5)`,
			org+"-"+row.key, org, row.key, row.value, row.valueType); err != nil {
			t.Fatalf("seed %s: %v", row.key, err)
		}
	}
	for i, email := range []string{"ada@example.com", "grace@example.com"} {
		if _, err := pool.Exec(ctx, `INSERT INTO org_members (id, org_id, user_id, email, role)
			VALUES ($1, $2, $3, $4, 'admin')`,
			fmt.Sprintf("%s-retry-m%d", org, i), org, fmt.Sprintf("%s-retry-u%d", org, i), email); err != nil {
			t.Fatalf("seed admin: %v", err)
		}
	}

	eng.processWeeklyDigests(ctx, logger)
	var delivered []string
	var completed bool
	if err := pool.QueryRow(ctx, `SELECT delivered_recipients, last_sent_at IS NOT NULL
		FROM org_digest_state WHERE org_id = $1`, org).Scan(&delivered, &completed); err != nil {
		t.Fatalf("read partial state: %v", err)
	}
	if completed || len(delivered) != 1 || delivered[0] != "ada@example.com" {
		t.Fatalf("partial success must remain resumable: completed=%v delivered=%v", completed, delivered)
	}

	// Backoff suppresses an immediate retry.
	eng.processWeeklyDigests(ctx, logger)
	mu.Lock()
	requestCount := len(requests)
	mu.Unlock()
	if requestCount != 2 {
		t.Fatalf("backoff must suppress immediate retry, requests=%v", requests)
	}

	if _, err := pool.Exec(ctx, `UPDATE org_digest_state
		SET next_attempt_at = now() - interval '1 second' WHERE org_id = $1`, org); err != nil {
		t.Fatalf("age retry: %v", err)
	}
	eng.processWeeklyDigests(ctx, logger)
	mu.Lock()
	gotRequests := append([]string(nil), requests...)
	mu.Unlock()
	if fmt.Sprint(gotRequests) != "[ada@example.com grace@example.com grace@example.com]" {
		t.Fatalf("retry must send only the failed recipient: %v", gotRequests)
	}
	var batchOpen bool
	if err := pool.QueryRow(ctx, `SELECT batch_started_at IS NOT NULL
		FROM org_digest_state WHERE org_id = $1`, org).Scan(&batchOpen); err != nil || batchOpen {
		t.Fatalf("successful retry must complete batch: open=%v err=%v", batchOpen, err)
	}
}
