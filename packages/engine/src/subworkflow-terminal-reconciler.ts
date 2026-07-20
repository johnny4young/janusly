/**
 * Durable repair loop for terminal child-run delivery to parent nodes.
 *
 * Every terminal child transition writes `runs.parentNotificationAfter` in
 * the same database update as the status. The immediate notifier clears that
 * marker only after the exact parent checkpoint and its downstream readiness
 * or run rollup are settled. This once-per-minute sweep leases and retries any
 * marker left behind by a process crash or transient dependency failure.
 */

import type { DueParentNotification } from "./persistence";
import {
  claimDueParentNotifications,
  notifyCommittedRunTerminal,
} from "./persistence";
import { workflowQueue } from "./queue";

export const SUBWORKFLOW_TERMINAL_RECONCILER_JOB_ID = "system:subworkflow-terminal-reconciler";
export const SUBWORKFLOW_TERMINAL_RECONCILER_JOB_NAME = "subworkflow-terminal-reconciler-trigger";
export const SUBWORKFLOW_TERMINAL_RECONCILER_CRON = "* * * * *";
export const SUBWORKFLOW_TERMINAL_RECONCILER_LIMIT = 500;

export type SubworkflowTerminalReconcilerDeps = {
  claimDue: (now: Date, limit: number) => Promise<DueParentNotification[]>;
  deliver: (notification: DueParentNotification) => Promise<boolean>;
};

export type SubworkflowTerminalReconcileResult = {
  scanned: number;
  repaired: number;
  failed: number;
};

/** Retry a claimed batch with per-child fault isolation. */
export async function reconcileSubworkflowTerminals(
  deps: SubworkflowTerminalReconcilerDeps,
  now = new Date(),
): Promise<SubworkflowTerminalReconcileResult> {
  const notifications = await deps.claimDue(now, SUBWORKFLOW_TERMINAL_RECONCILER_LIMIT);
  const result = { scanned: notifications.length, repaired: 0, failed: 0 };

  for (const notification of notifications) {
    try {
      const delivered = await deps.deliver(notification);
      if (!delivered) throw new Error("Parent handoff did not settle");
      result.repaired += 1;
    } catch (err) {
      result.failed += 1;
      console.warn("[subworkflow-terminal-reconciler] failed to deliver terminal child", {
        runId: notification.runId,
        status: notification.status,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/** Idempotently register the once-per-minute terminal handoff repair sweep. */
export async function registerSubworkflowTerminalReconciler(): Promise<boolean> {
  try {
    await workflowQueue.upsertJobScheduler(
      SUBWORKFLOW_TERMINAL_RECONCILER_JOB_ID,
      { pattern: SUBWORKFLOW_TERMINAL_RECONCILER_CRON },
      { name: SUBWORKFLOW_TERMINAL_RECONCILER_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[subworkflow-terminal-reconciler] upsertJobScheduler failed", {
      jobId: SUBWORKFLOW_TERMINAL_RECONCILER_JOB_ID,
      err,
    });
    return false;
  }
}

/** Run one repair sweep; transient DB/queue faults wait for the next lease. */
export async function handleSubworkflowTerminalReconcilerTrigger(): Promise<void> {
  try {
    const result = await reconcileSubworkflowTerminals({
      claimDue: claimDueParentNotifications,
      deliver: notification => notifyCommittedRunTerminal(
        notification.runId,
        notification.status,
        notification.leaseUntil,
      ),
    });
    if (result.scanned > 0) {
      console.log(
        `[subworkflow-terminal-reconciler] sweep complete — scanned ${result.scanned}, ` +
        `repaired ${result.repaired}, failed ${result.failed}`,
      );
    }
  } catch (err) {
    console.error("[subworkflow-terminal-reconciler] sweep failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
