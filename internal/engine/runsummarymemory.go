// Terminal-run summaries into tenant memory: the write half of semantic
// run search ("find runs like this failure"). Consent-gated end to end —
// memory.Commit itself refuses without the process gate, the tenant
// master switch, AND run_summary in the allowed kinds — and always
// best-effort on a detached goroutine: telemetry must never hold a
// completion or fail a worker.
package engine

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/memory"
	"github.com/johnny4young/janusly/internal/store"
)

const runSummaryMaxChars = 2000

// maybeCommitRunSummaryMemory schedules one summary commit for a run
// that just flipped terminal. Callers may fire it from every completion
// (the rollout-outcome pattern): non-terminal runs bail on the status
// check, and the existence probe keeps concurrent-branch races from
// stacking duplicates. Validation replays never leave a memory trace.
func (e *Engine) maybeCommitRunSummaryMemory(ctx context.Context, runID string) {
	run, err := store.New(e.pool).GetRunExecution(ctx, runID)
	if err != nil || (run.ReplayMode.Valid && run.ReplayMode.String != "") {
		return
	}
	if run.Status != "succeeded" && run.Status != "failed" {
		return
	}
	if !memory.Enabled(ctx, e.pool, run.OrgID) {
		return
	}
	orgID, status := run.OrgID, run.Status
	workflowID, workflowName := "", ""
	if wf, _, wfErr := workflowFromRunInput(run.InputJson); wfErr == nil {
		workflowID, workflowName = wf.ID, wf.Name
	}
	detached := context.WithoutCancel(ctx)
	go func() {
		commitCtx, cancel := context.WithTimeout(detached, 15*time.Second)
		defer cancel()
		// One summary per run: Commit has no dedup, and the success hook
		// fires from every node completion once the run reads terminal.
		var exists bool
		if err := e.pool.QueryRow(commitCtx,
			`SELECT EXISTS (SELECT 1 FROM memory_entries
			  WHERE org_id = $1 AND run_id = $2 AND kind = 'run_summary')`,
			orgID, runID).Scan(&exists); err != nil || exists {
			return
		}
		content := e.composeRunSummary(commitCtx, orgID, runID, workflowID, workflowName, status)
		if content == "" {
			return
		}
		_ = memory.Commit(commitCtx, e.pool, memory.CommitInput{
			OrgID: orgID, WorkflowID: workflowID, RunID: runID,
			Kind: "run_summary", Content: content,
			Metadata: map[string]any{"status": status, "workflowName": workflowName},
		})
	}()
}

// composeRunSummary renders the searchable text: workflow identity,
// outcome, and — for failures — the failing node plus its NORMALIZED
// error signature, so semantically similar failures embed near each
// other regardless of ids and timestamps.
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
	summary := strings.Join(parts, " ")
	if len(summary) > runSummaryMaxChars {
		summary = summary[:runSummaryMaxChars]
	}
	return summary
}
