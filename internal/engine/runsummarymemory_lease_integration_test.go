//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/migrate"
)

// The consumer claims globally, so this test owns a database rather than
// depending on which other integration tests left pending jobs behind.
func summaryLeaseTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	databaseURL, err := url.Parse(dsn)
	if err != nil {
		t.Fatal("invalid PostgreSQL test URL")
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal("invalid PostgreSQL test configuration")
	}
	config.MaxConns, config.MinConns, config.MinIdleConns = 4, 0, 0
	adminConfig := config.Copy()
	adminConfig.ConnConfig.Database = "postgres"
	adminConfig.MaxConns = 1
	admin, err := pgxpool.NewWithConfig(t.Context(), adminConfig)
	if err != nil {
		t.Fatalf("maintenance pool: %v", err)
	}
	name := fmt.Sprintf("janusly_summary_lease_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(t.Context(), "CREATE DATABASE "+identifier+" TEMPLATE template0"); err != nil {
		admin.Close()
		t.Fatalf("create isolated summary database: %v", err)
	}
	t.Cleanup(func() {
		defer admin.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, "DROP DATABASE "+identifier+" WITH (FORCE)"); err != nil {
			t.Errorf("drop owned summary database: %v", err)
		}
	})
	config.ConnConfig.Database = name
	databaseURL.Path = "/" + name
	query := databaseURL.Query()
	query.Del("dbname")
	query.Del("database")
	databaseURL.RawQuery = query.Encode()
	migrationConfig, err := pgxpool.ParseConfig(databaseURL.String())
	if err != nil || migrationConfig.ConnConfig.Database != name {
		t.Fatal("migration URL must target the owned summary database")
	}
	for range 2 {
		if err := migrate.Up(t.Context(), databaseURL.String()); err != nil {
			t.Fatalf("migrate isolated summary database: %v", err)
		}
	}
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatalf("summary pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestRunSummaryMemoryLeaseRecovery(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	t.Setenv("JANUSLY_MEMORY_ENABLED", "true")
	ctx := t.Context()
	pool := summaryLeaseTestPool(t)
	eng, org := New(pool), "org-summary-lease"
	var embeddingCalls atomic.Int32
	embedder := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		embeddingCalls.Add(1)
		vector := make([]float64, 1024)
		vector[0] = 1
		_ = json.NewEncoder(w).Encode(map[string]any{"embedding": vector})
	}))
	t.Cleanup(embedder.Close)
	for key, value := range map[string]string{
		"memory.enabled":          "true",
		"memory.allowedKinds":     `"run_summary"`,
		"memory.embeddingBaseUrl": fmt.Sprintf("%q", embedder.URL),
	} {
		valueType := "string"
		if key == "memory.enabled" {
			valueType = "boolean"
		}
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs
			(id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4, 'memory', 'test', $5)`,
			org+"-"+key, org, key, value, valueType); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	runID := "run-summary-lease-" + org
	if _, err := pool.Exec(ctx, `INSERT INTO runs
		(id, org_id, status, input_json, workflow_version_id)
		VALUES ($1, $2, 'succeeded', '{"workflow":{"id":"wf-lease","name":"Lease recovery","nodes":[],"edges":[]},"input":{}}', 'wv-lease')`, runID, org); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	eng.maybeCommitRunSummaryMemory(ctx, runID)

	// Competing consumers must not both own the live lease.
	type claimResult struct {
		job *runSummaryMemoryJob
		err error
	}
	start := make(chan struct{})
	results := make(chan claimResult, 2)
	for range 2 {
		go func() {
			<-start
			job, err := New(pool).claimRunSummaryMemoryJob(ctx)
			results <- claimResult{job: job, err: err}
		}()
	}
	close(start)
	var first *runSummaryMemoryJob
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatalf("competing claim: %v", result.err)
		}
		if result.job != nil {
			if first != nil {
				t.Fatal("two consumers claimed one live lease")
			}
			first = result.job
		}
	}
	if first == nil || first.RunID != runID || first.Attempts != 1 {
		t.Fatalf("expected one first claim for the queued run: %+v", first)
	}
	if job, err := New(pool).claimRunSummaryMemoryJob(ctx); err != nil || job != nil {
		t.Fatalf("live lease became claimable: %+v err=%v", job, err)
	}
	expire := func(job *runSummaryMemoryJob) {
		t.Helper()
		tag, err := pool.Exec(ctx, `UPDATE run_summary_memory_jobs
			SET lease_expires_at = clock_timestamp() - interval '1 second'
			WHERE org_id = $1 AND run_id = $2 AND lease_token = $3`, org, runID, job.LeaseToken)
		if err != nil || tag.RowsAffected() != 1 {
			t.Fatalf("expire owned lease: affected=%d err=%v", tag.RowsAffected(), err)
		}
	}
	claim := func(consumer *Engine) *runSummaryMemoryJob {
		t.Helper()
		job, err := consumer.claimRunSummaryMemoryJob(ctx)
		if err != nil || job == nil || job.RunID != runID {
			t.Fatalf("expected reclaimed job for %s: %+v err=%v", runID, job, err)
		}
		return job
	}

	// Simulate an abandoned consumer deterministically, without waiting for
	// the production lease duration or relying on host timing.
	expire(first)
	restarted := New(pool)
	second := claim(restarted)
	if second.LeaseToken == first.LeaseToken || second.Attempts != 2 {
		t.Fatalf("reclaim must replace the token and increment attempts: %+v", second)
	}
	if err := eng.completeRunSummaryMemoryJob(ctx, first, ""); err == nil || !strings.Contains(err.Error(), "lease lost") {
		t.Fatalf("stale consumer must lose finalization lease: %v", err)
	}
	if err := eng.retryRunSummaryMemoryJob(ctx, first, "stale consumer"); err == nil || !strings.Contains(err.Error(), "lease lost") {
		t.Fatalf("stale consumer must lose retry lease: %v", err)
	}
	terminal, reason := restarted.processRunSummaryMemoryJob(ctx, second)
	if !terminal || reason != "" || embeddingCalls.Load() != 1 {
		t.Fatalf("first processing: terminal=%v reason=%q embeddingCalls=%d", terminal, reason, embeddingCalls.Load())
	}

	// Memory can commit just before the consumer disappears. The next owner
	// must detect that durable result without issuing another embedding.
	expire(second)
	redelivered := New(pool)
	third := claim(redelivered)
	if third.LeaseToken == second.LeaseToken || third.Attempts != 3 {
		t.Fatalf("post-write redelivery must own a new lease: %+v", third)
	}
	terminal, reason = redelivered.processRunSummaryMemoryJob(ctx, third)
	if !terminal || reason != "" || embeddingCalls.Load() != 1 {
		t.Fatalf("deduplicated redelivery: terminal=%v reason=%q embeddingCalls=%d", terminal, reason, embeddingCalls.Load())
	}
	if err := redelivered.completeRunSummaryMemoryJob(ctx, third, ""); err != nil {
		t.Fatalf("complete current lease: %v", err)
	}
	var summaries, attempts int
	var completed pgtype.Timestamptz
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM memory_entries
		WHERE org_id = $1 AND run_id = $2 AND kind = 'run_summary'`, org, runID).Scan(&summaries); err != nil || summaries != 1 {
		t.Fatalf("one durable summary: count=%d err=%v", summaries, err)
	}
	if err := pool.QueryRow(ctx, `SELECT attempts, completed_at FROM run_summary_memory_jobs
		WHERE org_id = $1 AND run_id = $2`, org, runID).Scan(&attempts, &completed); err != nil || attempts != 3 || !completed.Valid {
		t.Fatalf("completed durable job: attempts=%d completed=%v err=%v", attempts, completed.Valid, err)
	}
	if job, err := redelivered.claimRunSummaryMemoryJob(ctx); err != nil || job != nil {
		t.Fatalf("completed job became claimable: %+v err=%v", job, err)
	}
}
