//go:build integration

package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/engine"
)

// The supervised auto-healing ladder end to end: two same-signature dead
// letters → the scan proposes a deterministic patch + sandbox-validates
// it (write sides skipped) → the watcher promotes to `validated` → the
// operator's decide route applies via fix-snapshot redrive (or declines).
// Consent purge: an aged memory.enabled=false flip purges the org's rows.
func TestAutoHealingSupervisedLoop(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	t.Setenv("JANUSLY_AUTO_HEALING_ENABLED", "true")
	suffix := fmt.Sprint(time.Now().UnixNano())
	eng := engine.New(pool)

	// Org opt-in (no env fallback per tenant, by design).
	if res := h.call("POST", "/org/config", map[string]any{
		"key": "autoHealing.enabled", "value": true,
	}, ""); res.status != 200 {
		t.Fatalf("org opt-in: %d %+v", res.status, res.body)
	}

	// A flaky endpoint: fails the first N calls, then succeeds — so the
	// production runs dead-letter but the hardened-retry patch validates.
	var calls atomic.Int32
	flaky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) <= 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer flaky.Close()

	// Two failing runs of the SAME workflow → same signature cluster.
	workflow := map[string]any{
		"id": "wf-heal-" + suffix, "name": "Heal", "dslVersion": "1.0",
		"nodes": []any{map[string]any{"id": "call", "type": "http", "config": map[string]any{
			"url": flaky.URL, "timeoutMs": 2000,
		}}},
		"edges": []any{},
	}
	for i := 0; i < 2; i++ {
		calls.Store(0) // each run's first attempt fails
		res := h.call("POST", "/v1/start", map[string]any{"workflow": workflow}, "")
		runID := extractRunID(t, res)
		h.waitRun(runID, "failed")
	}

	// Scan: proposes ONE run for the cluster and kicks sandbox validation.
	calls.Store(100) // validation replays succeed immediately
	res := h.call("POST", "/auto-healing/scan", nil, "")
	if res.status != 200 || res.body["proposed"] != float64(1) {
		t.Fatalf("scan: %d %+v", res.status, res.body)
	}
	var healingID, validationRunID string
	_ = pool.QueryRow(ctx,
		`SELECT id, coalesce(validation_run_id,'') FROM auto_healing_runs WHERE org_id = $1`,
		h.org).Scan(&healingID, &validationRunID)
	if healingID == "" || validationRunID == "" {
		t.Fatalf("healing row: id=%q validation=%q", healingID, validationRunID)
	}
	h.waitRun(validationRunID, "succeeded")

	// Watcher promotes the terminal sandbox to `validated`.
	if result := eng.SweepAutoHealing(ctx); result.Promoted != 1 {
		t.Fatalf("promotion sweep: %+v", result)
	}
	res = h.call("GET", "/auto-healing/pending", nil, "")
	if res.status != 200 || len(res.body["rows"].([]any)) != 1 {
		t.Fatalf("pending: %d %+v", res.status, res.body)
	}
	row := res.body["rows"].([]any)[0].(map[string]any)
	if row["approachLabel"] != "harden_retries" {
		t.Fatalf("proposal shape: %+v", row)
	}

	// Sandbox evidence is writes-skipped → apply demands the explicit ack.
	res = h.call("POST", "/auto-healing/"+healingID+"/decide", map[string]any{"accepted": true}, "")
	if res.status != 409 {
		t.Fatalf("risk ack required: %d %+v", res.status, res.body)
	}
	// With the ack: CAS to applied + fix-snapshot redrive revives the run.
	calls.Store(100)
	res = h.call("POST", "/auto-healing/"+healingID+"/decide", map[string]any{
		"accepted": true, "acknowledgeValidationRisk": true,
	}, "")
	if res.status != 200 || res.body["ok"] != true {
		t.Fatalf("apply: %d %+v", res.status, res.body)
	}
	var status string
	_ = pool.QueryRow(ctx, `SELECT status FROM auto_healing_runs WHERE id = $1`, healingID).Scan(&status)
	if status != "applied" {
		t.Fatalf("row status: %s", status)
	}
	// A second decide loses the CAS.
	res = h.call("POST", "/auto-healing/"+healingID+"/decide", map[string]any{"accepted": false}, "")
	if res.status != 409 {
		t.Fatalf("second decide must 409: %d", res.status)
	}
	// The loop-breaker: an immediate re-scan proposes nothing new (the
	// dead letters now carry healing rows / the attempt count guards).
	if res = h.call("POST", "/auto-healing/scan", nil, ""); res.body["proposed"] != float64(0) {
		t.Fatalf("re-scan must be idempotent: %+v", res.body)
	}
}

// Consent-revocation purge: an aged memory.enabled=false flip purges the
// org's memory rows and audits; a FRESH flip stays untouched.
func TestMemoryConsentPurgeSweep(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := t.Context()
	eng := engine.New(pool)
	suffix := fmt.Sprint(time.Now().UnixNano())

	seed := func(org string, revokedAgo time.Duration) {
		zeroVector := "[" + strings.TrimSuffix(strings.Repeat("0,", 1023), ",") + ",0]"
		if _, err := pool.Exec(ctx,
			`INSERT INTO memory_entries (id, org_id, kind, content, embedding, embedding_provider, embedding_model, embedding_dimension, retain_until)
			 VALUES ($1, $2, 'workflow_vector', 'remember me', $3::vector, 'test', 'test-embed', 1024, now() + interval '30 days')`,
			"mem-"+org+"-"+suffix, org, zeroVector); err != nil {
			t.Fatalf("seed memory: %v", err)
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO org_configs (id, org_id, key, value_json, value_type, category, description, updated_at)
			 VALUES ($1, $2, 'memory.enabled', 'false'::jsonb, 'boolean', 'memory', 'test', now() - $3::interval)`,
			"cfg-"+org+"-"+suffix, org, fmt.Sprintf("%d seconds", int(revokedAgo.Seconds()))); err != nil {
			t.Fatalf("seed config: %v", err)
		}
	}
	agedOrg, freshOrg := "org-purge-aged-"+suffix, "org-purge-fresh-"+suffix
	seed(agedOrg, 8*24*time.Hour)
	seed(freshOrg, time.Hour)

	if purged := eng.SweepMemoryConsentPurges(ctx); purged != 1 {
		t.Fatalf("sweep must purge exactly the aged org: %d", purged)
	}
	var agedRows, freshRows, audits int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries WHERE org_id = $1`, agedOrg).Scan(&agedRows)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries WHERE org_id = $1`, freshOrg).Scan(&freshRows)
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'memory.bulk.purged'`, agedOrg).Scan(&audits)
	if agedRows != 0 || freshRows != 1 || audits != 1 {
		t.Fatalf("purge outcome: aged=%d fresh=%d audits=%d", agedRows, freshRows, audits)
	}
	// Idempotent: the next sweep has nothing left to purge.
	if purged := eng.SweepMemoryConsentPurges(ctx); purged != 0 {
		t.Fatalf("second sweep must purge nothing: %d", purged)
	}
	_ = h
}
