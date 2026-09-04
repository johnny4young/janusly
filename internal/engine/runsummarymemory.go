// Terminal-run summaries into tenant memory: the write half of semantic run
// search ("find runs like this failure"). Completion hooks enqueue one durable
// job per run; a supervised, leased sweep performs embedding outside the
// execution transaction. Consent is checked both when enqueuing and consuming.
package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/memory"
	"github.com/johnny4young/janusly/internal/observability"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	runSummaryMaxChars = 2000
	runSummaryJobLease = 30 * time.Second
)

type runSummaryMemoryJob struct {
	OrgID      string
	RunID      string
	LeaseToken string
	Attempts   int
}

// maybeCommitRunSummaryMemory durably enqueues one summary job for a run that
// just flipped terminal. INSERT ON CONFLICT replaces the former racy
// SELECT-then-detached-goroutine path and makes every completion hook safe.
func (e *Engine) maybeCommitRunSummaryMemory(ctx context.Context, runID string) {
	run, err := store.New(e.pool).GetRunHeader(ctx, runID)
	if err != nil || (run.ReplayMode.Valid && run.ReplayMode.String != "") {
		return
	}
	if run.Status != "succeeded" && run.Status != "failed" {
		return
	}
	if !memory.Enabled(ctx, e.pool, run.OrgID) {
		return
	}
	if _, err := e.pool.Exec(ctx, `INSERT INTO run_summary_memory_jobs (org_id, run_id)
		VALUES ($1, $2) ON CONFLICT (org_id, run_id) DO NOTHING`, run.OrgID, runID); err != nil && ctx.Err() == nil {
		// The run's completion must not fail on this, but a lost summary
		// job should not vanish silently either.
		slog.Warn("run summary memory job not queued", "runId", runID, "error", err)
	}
}

func (e *Engine) claimRunSummaryMemoryJob(ctx context.Context) (*runSummaryMemoryJob, error) {
	leaseToken := e.newID()
	row := e.pool.QueryRow(ctx, `WITH candidate AS (
		SELECT org_id, run_id
		FROM run_summary_memory_jobs
		WHERE completed_at IS NULL
		  AND next_attempt_at <= clock_timestamp()
		  AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
		ORDER BY next_attempt_at, created_at, run_id
		FOR UPDATE SKIP LOCKED
		LIMIT 1
	)
	UPDATE run_summary_memory_jobs job
	SET lease_token = $1,
	    lease_expires_at = clock_timestamp() + make_interval(secs => $2::double precision),
	    attempts = job.attempts + 1,
	    updated_at = clock_timestamp()
	FROM candidate
	WHERE job.org_id = candidate.org_id AND job.run_id = candidate.run_id
	RETURNING job.org_id, job.run_id, job.lease_token, job.attempts`,
		leaseToken, runSummaryJobLease.Seconds())
	var job runSummaryMemoryJob
	if err := row.Scan(&job.OrgID, &job.RunID, &job.LeaseToken, &job.Attempts); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &job, nil
}

func (e *Engine) completeRunSummaryMemoryJob(ctx context.Context, job *runSummaryMemoryJob, lastError string) error {
	tag, err := e.pool.Exec(ctx, `UPDATE run_summary_memory_jobs
		SET completed_at = clock_timestamp(), lease_token = NULL, lease_expires_at = NULL,
		    last_error = NULLIF($4, ''), updated_at = clock_timestamp()
		WHERE org_id = $1 AND run_id = $2 AND lease_token = $3`,
		job.OrgID, job.RunID, job.LeaseToken, lastError)
	if err == nil && tag.RowsAffected() != 1 {
		return fmt.Errorf("run summary memory lease lost while completing %s", job.RunID)
	}
	return err
}

func runSummaryRetryDelay(attempts int) time.Duration {
	shift := min(max(attempts-1, 0), 8)
	return min(time.Second<<shift, 5*time.Minute)
}

func (e *Engine) retryRunSummaryMemoryJob(ctx context.Context, job *runSummaryMemoryJob, reason string) error {
	if reason == "" {
		reason = "commit_failed"
	}
	tag, err := e.pool.Exec(ctx, `UPDATE run_summary_memory_jobs
		SET next_attempt_at = clock_timestamp() + make_interval(secs => $4::double precision),
		    lease_token = NULL, lease_expires_at = NULL, last_error = $5,
		    updated_at = clock_timestamp()
		WHERE org_id = $1 AND run_id = $2 AND lease_token = $3`,
		job.OrgID, job.RunID, job.LeaseToken, runSummaryRetryDelay(job.Attempts).Seconds(), reason)
	if err == nil && tag.RowsAffected() != 1 {
		return fmt.Errorf("run summary memory lease lost while retrying %s", job.RunID)
	}
	return err
}

// processRunSummaryMemoryJob returns (terminal, reason). terminal means the
// durable job should not retry (success, consent revoked, replay, or stale
// source); transient embedding/persistence failures retain the job.
func (e *Engine) processRunSummaryMemoryJob(ctx context.Context, job *runSummaryMemoryJob) (bool, string) {
	run, err := store.New(e.pool).GetRunExecution(ctx, job.RunID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && run.OrgID != job.OrgID) {
		return true, "source_unavailable"
	}
	if err != nil {
		return false, "source_read_failed"
	}
	if (run.ReplayMode.Valid && run.ReplayMode.String != "") ||
		(run.Status != "succeeded" && run.Status != "failed") {
		return true, "source_ineligible"
	}
	if !memory.Enabled(ctx, e.pool, job.OrgID) {
		return true, "memory_disabled"
	}
	var alreadyCommitted bool
	if err := e.pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM memory_entries
		WHERE org_id = $1 AND run_id = $2 AND kind = 'run_summary'
	)`, job.OrgID, job.RunID).Scan(&alreadyCommitted); err != nil {
		return false, "dedupe_read_failed"
	} else if alreadyCommitted {
		return true, ""
	}
	workflowID, workflowName := "", ""
	if workflow, _, workflowErr := workflowFromRunInput(run.InputJson); workflowErr == nil {
		workflowID, workflowName = workflow.ID, workflow.Name
	}
	content := e.composeRunSummary(ctx, job.OrgID, job.RunID, workflowID, workflowName, run.Status)
	if content == "" {
		return true, "empty_summary"
	}
	result := memory.Commit(ctx, e.pool, memory.CommitInput{
		OrgID: job.OrgID, WorkflowID: workflowID, RunID: job.RunID,
		Kind: "run_summary", Content: content,
		Metadata: map[string]any{"status": run.Status, "workflowName": workflowName},
	})
	if result.OK {
		return true, ""
	}
	if result.Error == "memory_disabled" || result.Error == "unknown_kind" {
		return true, result.Error
	}
	return false, result.Error
}

// RunRunSummaryMemorySweep consumes the durable summary queue until shutdown.
// A claimed job finishes on a detached bounded context so runner.Shutdown
// drains it before PostgreSQL pools close; unclaimed jobs remain durable.
func (e *Engine) RunRunSummaryMemorySweep(ctx context.Context, interval time.Duration, logger *slog.Logger) {
	if interval <= 0 {
		interval = time.Second
	}
	if logger == nil {
		logger = slog.Default()
	}
	for ctx.Err() == nil {
		started := time.Now()
		job, err := e.claimRunSummaryMemoryJob(ctx)
		if err != nil {
			if ctx.Err() == nil {
				logger.Error("run summary memory claim failed", "error", err)
			}
		} else if job != nil {
			workCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
			terminal, reason := e.processRunSummaryMemoryJob(workCtx, job)
			if terminal {
				err = e.completeRunSummaryMemoryJob(workCtx, job, reason)
			} else {
				err = e.retryRunSummaryMemoryJob(workCtx, job, reason)
			}
			cancel()
			if err != nil {
				logger.Error("run summary memory finalize failed", "runId", job.RunID, "error", err)
			}
			observability.ObserveSweepPass(observability.SweepRunSummaryMemory, started, err)
			continue
		}
		observability.ObserveSweepPass(observability.SweepRunSummaryMemory, started, err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

// composeRunSummary renders the searchable text: workflow identity, outcome,
// and — for failures — the failing node plus its normalized error signature.
func (e *Engine) composeRunSummary(ctx context.Context, orgID, runID, workflowID, workflowName, status string) string {
	title := workflowName
	if title == "" {
		title = workflowID
	}
	parts := []string{fmt.Sprintf("Workflow %q %s.", title, status)}
	if status == "failed" {
		if dl, err := store.New(e.pool).FindLatestDeadLetterForRun(ctx, store.FindLatestDeadLetterForRunParams{
			OrgID: orgID, RunID: runID,
		}); err == nil {
			parts = append(parts, fmt.Sprintf("Failed at node %q: %s",
				dl.NodeID, deadLetterSignatureFromParts(dl.NodeID, dl.NodeJson, dl.ErrorJson)))
		}
	}
	summary := []rune(strings.Join(parts, " "))
	if len(summary) > runSummaryMaxChars {
		summary = summary[:runSummaryMaxChars]
	}
	return string(summary)
}
