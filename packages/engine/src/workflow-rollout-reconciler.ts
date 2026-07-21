/**
 * Durable repair loop for terminal workflow-rollout evidence.
 *
 * The immediate terminal observer records rollout outcomes before the rest of
 * the terminal side effects, but database interruptions remain possible. This
 * bounded once-per-minute sweep finds terminal production runs without their
 * idempotency receipt and replays the same recording chokepoint.
 */

import {
  listUnrecordedWorkflowRolloutOutcomes,
  recordWorkflowRolloutOutcome,
  type RecordWorkflowRolloutOutcomeResult,
  type UnrecordedWorkflowRolloutOutcome,
} from "@janusly/data";

import { maintenanceQueue } from "./queue";

export const WORKFLOW_ROLLOUT_RECONCILER_JOB_ID = "system:workflow-rollout-reconciler";
export const WORKFLOW_ROLLOUT_RECONCILER_JOB_NAME = "workflow-rollout-reconciler-trigger";
export const WORKFLOW_ROLLOUT_RECONCILER_CRON = "* * * * *";
export const WORKFLOW_ROLLOUT_RECONCILER_LIMIT = 500;

export type WorkflowRolloutReconcilerDeps = {
  listDue: (limit: number) => Promise<UnrecordedWorkflowRolloutOutcome[]>;
  record: (
    runId: string,
    status: UnrecordedWorkflowRolloutOutcome["status"],
  ) => Promise<RecordWorkflowRolloutOutcomeResult>;
};

export type WorkflowRolloutReconcileResult = {
  scanned: number;
  recorded: number;
  duplicate: number;
  ignored: number;
  failed: number;
};

/** Repair one bounded batch with per-run fault isolation. */
export async function reconcileWorkflowRolloutOutcomes(
  deps: WorkflowRolloutReconcilerDeps,
): Promise<WorkflowRolloutReconcileResult> {
  const candidates = await deps.listDue(WORKFLOW_ROLLOUT_RECONCILER_LIMIT);
  const result = {
    scanned: candidates.length,
    recorded: 0,
    duplicate: 0,
    ignored: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const outcome = await deps.record(candidate.runId, candidate.status);
      result[outcome.kind] += 1;
    } catch (err) {
      result.failed += 1;
      console.warn("[workflow-rollout-reconciler] failed to record terminal outcome", {
        runId: candidate.runId,
        status: candidate.status,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/** Idempotently register the once-per-minute rollout evidence repair sweep. */
export async function registerWorkflowRolloutReconciler(): Promise<boolean> {
  try {
    await maintenanceQueue.upsertJobScheduler(
      WORKFLOW_ROLLOUT_RECONCILER_JOB_ID,
      { pattern: WORKFLOW_ROLLOUT_RECONCILER_CRON },
      { name: WORKFLOW_ROLLOUT_RECONCILER_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[workflow-rollout-reconciler] upsertJobScheduler failed", {
      jobId: WORKFLOW_ROLLOUT_RECONCILER_JOB_ID,
      err,
    });
    return false;
  }
}

/** Run one repair sweep; transient database faults wait for the next pass. */
export async function handleWorkflowRolloutReconcilerTrigger(): Promise<void> {
  try {
    const result = await reconcileWorkflowRolloutOutcomes({
      listDue: listUnrecordedWorkflowRolloutOutcomes,
      record: recordWorkflowRolloutOutcome,
    });
    if (result.scanned > 0) {
      console.log(
        `[workflow-rollout-reconciler] sweep complete — scanned ${result.scanned}, `
        + `recorded ${result.recorded}, duplicate ${result.duplicate}, `
        + `ignored ${result.ignored}, failed ${result.failed}`,
      );
    }
  } catch (err) {
    console.error("[workflow-rollout-reconciler] sweep failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
