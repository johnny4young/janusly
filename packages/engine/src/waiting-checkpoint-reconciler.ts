/**
 * Durable repair loop for approval deadlines and timer wake-ups.
 *
 * Delayed BullMQ jobs remain the precise delivery path. This bounded periodic
 * sweep repairs a job that was lost with Redis state or exhausted its
 * infrastructure retries, so a persisted bounded wait cannot become
 * indefinite. The node-generation CAS in the final handler makes a duplicate
 * repair delivery harmless.
 */

import type { DueWaitingCheckpoint } from "./persistence";
import { claimDueWaitingCheckpoints } from "./persistence";
import { enqueueApprovalTimeout, enqueueWaitUntilResume, workflowQueue } from "./queue";

export const WAITING_CHECKPOINT_RECONCILER_JOB_ID = "system:waiting-checkpoint-reconciler";
export const WAITING_CHECKPOINT_RECONCILER_JOB_NAME = "waiting-checkpoint-reconciler-trigger";
export const WAITING_CHECKPOINT_RECONCILER_CRON = "* * * * *";
export const WAITING_CHECKPOINT_RECONCILER_LIMIT = 500;

export type WaitingCheckpointReconcilerDeps = {
  claimDue: (now: Date, limit: number) => Promise<DueWaitingCheckpoint[]>;
  enqueueApproval: (runId: string, nodeId: string, deadlineAt: string, delayMs: number) => Promise<unknown>;
  enqueueTimer: (runId: string, nodeId: string, delayMs: number) => Promise<unknown>;
};

export type WaitingCheckpointReconcileResult = {
  scanned: number;
  requeued: number;
  failed: number;
};

/** Recreate due jobs in a bounded, per-row fault-isolated batch. */
export async function reconcileWaitingCheckpoints(
  deps: WaitingCheckpointReconcilerDeps,
  now = new Date(),
): Promise<WaitingCheckpointReconcileResult> {
  const checkpoints = await deps.claimDue(now, WAITING_CHECKPOINT_RECONCILER_LIMIT);
  const result = { scanned: checkpoints.length, requeued: 0, failed: 0 };
  for (const checkpoint of checkpoints) {
    try {
      if (checkpoint.kind === "approval") {
        await deps.enqueueApproval(checkpoint.runId, checkpoint.nodeId, checkpoint.targetAt, 0);
      } else {
        await deps.enqueueTimer(checkpoint.runId, checkpoint.nodeId, 0);
      }
      result.requeued += 1;
    } catch (err) {
      result.failed += 1;
      console.warn("[waiting-checkpoint-reconciler] failed to recreate delayed job", {
        runId: checkpoint.runId,
        nodeId: checkpoint.nodeId,
        kind: checkpoint.kind,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/** Idempotently register the once-per-minute repair sweep. */
export async function registerWaitingCheckpointReconciler(): Promise<boolean> {
  try {
    await workflowQueue.upsertJobScheduler(
      WAITING_CHECKPOINT_RECONCILER_JOB_ID,
      { pattern: WAITING_CHECKPOINT_RECONCILER_CRON },
      { name: WAITING_CHECKPOINT_RECONCILER_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[waiting-checkpoint-reconciler] upsertJobScheduler failed", {
      jobId: WAITING_CHECKPOINT_RECONCILER_JOB_ID,
      err,
    });
    return false;
  }
}

/** Run one repair sweep; a transient DB/Redis error waits for the next fire. */
export async function handleWaitingCheckpointReconcilerTrigger(): Promise<void> {
  try {
    const result = await reconcileWaitingCheckpoints({
      claimDue: (now, limit) => claimDueWaitingCheckpoints(now, limit),
      enqueueApproval: enqueueApprovalTimeout,
      enqueueTimer: enqueueWaitUntilResume,
    });
    if (result.scanned > 0) {
      console.log(
        `[waiting-checkpoint-reconciler] sweep complete — scanned ${result.scanned}, ` +
        `requeued ${result.requeued}, failed ${result.failed}`,
      );
    }
  } catch (err) {
    console.error("[waiting-checkpoint-reconciler] sweep failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
