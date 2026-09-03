//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Semantic run search, write half: a consented terminal run leaves exactly
// one run_summary memory (the hook fires from every completion, so the
// existence guard must hold), a failure summary carries the failing node
// and normalized signature, and a validation replay leaves no trace.
func TestRunSummaryMemoryCommit(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	ctx, pool, eng, org := newHarness(t)
	sweepCtx, stopSweep := context.WithCancel(context.Background())
	sweepDone := make(chan struct{})
	go func() {
		defer close(sweepDone)
		eng.RunRunSummaryMemorySweep(sweepCtx, 10*time.Millisecond, quietLogger())
	}()
	t.Cleanup(func() { stopSweep(); <-sweepDone })

	// Deterministic embedding fixture (fake Ollama).
	var embeddingCalls atomic.Int32
	var embeddingFailures atomic.Int32
	embedder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		embeddingCalls.Add(1)
		if embeddingFailures.Add(-1) >= 0 {
			http.Error(w, "temporary embedding outage", http.StatusServiceUnavailable)
			return
		}
		vector := make([]float64, 1024)
		vector[0] = 1
		_ = json.NewEncoder(w).Encode(map[string]any{"embedding": vector})
	}))
	t.Cleanup(embedder.Close)
	seed := func(key, valueJSON, valueType string) {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'memory', 'test', $5)`, org+"-"+key, org, key, valueJSON, valueType); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	seed("memory.enabled", "true", "boolean")
	seed("memory.allowedKinds", `"run_summary"`, "string")
	seed("memory.embeddingBaseUrl", fmt.Sprintf("%q", embedder.URL), "string")

	inputJSON := `{"workflow":{"id":"wf-summary","name":"Refund triage","dslVersion":"1.0","nodes":[{"id":"fetch","type":"http","config":{"url":"https://x.invalid"}}],"edges":[]},"input":{}}`
	seedRun := func(runID, status, replayMode string) {
		if _, err := pool.Exec(ctx, `INSERT INTO runs
			(id, org_id, status, input_json, workflow_version_id, replay_mode)
			VALUES ($1, $2, $3, $4, 'wv-summary', NULLIF($5, ''))`,
			runID, org, status, inputJSON, replayMode); err != nil {
			t.Fatalf("seed run %s: %v", runID, err)
		}
	}
	countSummaries := func(runID string) int {
		var n int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries
			WHERE org_id = $1 AND run_id = $2 AND kind = 'run_summary'`, org, runID).Scan(&n)
		return n
	}
	waitForSummary := func(runID string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if countSummaries(runID) > 0 {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("no run_summary appeared for %s", runID)
	}

	// 1. Failed run with a dead letter: summary carries node + signature.
	failedRun := "run-summary-fail-" + org
	seedRun(failedRun, "failed", "")
	if _, err := pool.Exec(ctx, `INSERT INTO dead_letters
		(id, org_id, run_id, node_id, attempt, node_json, error_json, workflow_json, status)
		VALUES ($1, $2, $3, 'fetch', 3,
		 '{"id":"fetch","type":"http","config":{"url":"https://x.invalid"}}',
		 '{"code":"http_error","message":"dial tcp: lookup x.invalid: no such host"}',
		 '{}', 'open')`, failedRun+"-dl", org, failedRun); err != nil {
		t.Fatalf("seed dead letter: %v", err)
	}
	var enqueueWG sync.WaitGroup
	for range 12 {
		enqueueWG.Add(1)
		go func() {
			defer enqueueWG.Done()
			eng.maybeCommitRunSummaryMemory(ctx, failedRun)
		}()
	}
	enqueueWG.Wait()
	waitForSummary(failedRun)
	var content string
	if err := pool.QueryRow(ctx, `SELECT content FROM memory_entries
		WHERE org_id = $1 AND run_id = $2 AND kind = 'run_summary'`, org, failedRun).Scan(&content); err != nil {
		t.Fatalf("read summary: %v", err)
	}
	for _, needle := range []string{"Refund triage", "failed", "fetch"} {
		if !strings.Contains(content, needle) {
			t.Fatalf("summary %q must mention %q", content, needle)
		}
	}

	// 2. Re-firing the hook (every completion calls it) stays at one row.
	eng.maybeCommitRunSummaryMemory(ctx, failedRun)
	time.Sleep(300 * time.Millisecond)
	if n := countSummaries(failedRun); n != 1 {
		t.Fatalf("summary must stay deduplicated, got %d", n)
	}
	if calls := embeddingCalls.Load(); calls != 1 {
		t.Fatalf("durable dedupe must embed once, got %d calls", calls)
	}
	var jobs, completed int
	if err := pool.QueryRow(ctx, `SELECT count(*), count(completed_at)
		FROM run_summary_memory_jobs WHERE org_id = $1 AND run_id = $2`, org, failedRun).
		Scan(&jobs, &completed); err != nil || jobs != 1 || completed != 1 {
		t.Fatalf("one completed durable job: jobs=%d completed=%d err=%v", jobs, completed, err)
	}

	// 3. Non-terminal and validation runs leave nothing.
	runningRun := "run-summary-running-" + org
	seedRun(runningRun, "running", "")
	eng.maybeCommitRunSummaryMemory(ctx, runningRun)
	validationRun := "run-summary-validation-" + org
	seedRun(validationRun, "succeeded", "validation")
	eng.maybeCommitRunSummaryMemory(ctx, validationRun)
	time.Sleep(300 * time.Millisecond)
	if countSummaries(runningRun) != 0 || countSummaries(validationRun) != 0 {
		t.Fatal("running and validation runs must leave no memory trace")
	}
	var ineligibleJobs int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_summary_memory_jobs
		WHERE org_id = $1 AND run_id = ANY($2::text[])`, org, []string{runningRun, validationRun}).Scan(&ineligibleJobs)
	if ineligibleJobs != 0 {
		t.Fatalf("ineligible runs must not enqueue summary jobs: %d", ineligibleJobs)
	}

	// 4. A transient embedding outage does not lose the summary: the durable
	// job releases its lease, backs off, and succeeds on the next attempt.
	retryRun := "run-summary-retry-" + org
	seedRun(retryRun, "succeeded", "")
	embeddingFailures.Store(1)
	beforeRetryCalls := embeddingCalls.Load()
	eng.maybeCommitRunSummaryMemory(ctx, retryRun)
	waitForSummary(retryRun)
	var retryAttempts int
	if err := pool.QueryRow(ctx, `SELECT attempts FROM run_summary_memory_jobs
		WHERE org_id = $1 AND run_id = $2`, org, retryRun).Scan(&retryAttempts); err != nil {
		t.Fatalf("read retry attempts: %v", err)
	}
	if retryAttempts != 2 || embeddingCalls.Load()-beforeRetryCalls != 2 {
		t.Fatalf("transient failure must retry once: attempts=%d embeddingCalls=%d",
			retryAttempts, embeddingCalls.Load()-beforeRetryCalls)
	}
}
