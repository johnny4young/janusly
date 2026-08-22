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
	// Two admins and one viewer; only admins receive.
	for i, row := range []struct{ role, email string }{
		{"admin", "ada@example.com"}, {"admin", "grace@example.com"}, {"viewer", "eve@example.com"},
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
	if firstBatch != 2 {
		t.Fatalf("both admins and only admins receive: %d", firstBatch)
	}
	if to != "ada@example.com" && to != "grace@example.com" {
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
		if count == firstBatch+2 || time.Now().After(deadline) {
			if count != firstBatch+2 {
				t.Fatalf("aged claim must send again: %d", count)
			}
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
}
