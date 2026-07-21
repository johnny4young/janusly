/**
 * Durable repair loop for Postgres→BullMQ node publication.
 *
 * Every executable generation sets `run_nodes.queuePublicationRepairAfter`
 * before Queue.add and clears it only after Redis accepts a deterministic job
 * id. The persisted publication generation distinguishes a producer retry
 * from a required new delivery after BullMQ consumed the prior job. This
 * once-per-minute sweep republishes stranded `queued` generations or reruns
 * readiness for a failed-parent consumer restored to `pending`.
 */

import { WorkflowSchema, type Workflow } from "@janusly/shared";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { WorkflowRuntime } from "./core/runtime";
import type { DueQueuePublicationRepair } from "./persistence";
import {
  claimDueQueuePublicationRepairs,
  loadRunWorkflowRaw,
  markQueuePublicationSucceeded,
} from "./persistence";
import { maintenanceQueue } from "./queue";

export const QUEUE_PUBLICATION_RECONCILER_JOB_ID = "system:queue-publication-reconciler";
export const QUEUE_PUBLICATION_RECONCILER_JOB_NAME = "queue-publication-reconciler-trigger";
export const QUEUE_PUBLICATION_RECONCILER_CRON = "* * * * *";
export const QUEUE_PUBLICATION_RECONCILER_LIMIT = 500;

export type QueuePublicationReconcilerDeps = {
  claimDue: (now: Date, limit: number) => Promise<DueQueuePublicationRepair[]>;
  enqueueQueued: (repair: DueQueuePublicationRepair) => Promise<void>;
  loadWorkflow: (runId: string) => Promise<unknown>;
  enqueueReady: (runId: string, workflow: Workflow) => Promise<number>;
};

export type QueuePublicationReconcileResult = {
  scanned: number;
  repaired: number;
  failed: number;
};

/** Repair a claimed batch with per-generation/run fault isolation. */
export async function reconcileQueuePublications(
  deps: QueuePublicationReconcilerDeps,
  now = new Date(),
): Promise<QueuePublicationReconcileResult> {
  const repairs = await deps.claimDue(now, QUEUE_PUBLICATION_RECONCILER_LIMIT);
  const result = { scanned: repairs.length, repaired: 0, failed: 0 };

  for (const repair of repairs.filter(candidate => candidate.status === "queued")) {
    try {
      await deps.enqueueQueued(repair);
      result.repaired += 1;
    } catch (err) {
      result.failed += 1;
      console.warn("[queue-publication-reconciler] failed to publish queued generation", {
        runId: repair.runId,
        nodeId: repair.nodeId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const pendingByRun = new Map<string, DueQueuePublicationRepair>();
  for (const repair of repairs) {
    if (repair.status === "pending" && !pendingByRun.has(repair.runId)) {
      pendingByRun.set(repair.runId, repair);
    }
  }
  for (const repair of pendingByRun.values()) {
    try {
      // Load and release one snapshot at a time. The compact claim can cover
      // 500 distinct runs without retaining 500 arbitrarily large workflow
      // JSON values in one process at once.
      const parsed = WorkflowSchema.safeParse(await deps.loadWorkflow(repair.runId));
      if (!parsed.success) throw new Error("Persisted workflow snapshot is invalid");
      const queued = await deps.enqueueReady(repair.runId, parsed.data);
      if (queued === 0) throw new Error("Restored node was not ready for publication");
      result.repaired += 1;
    } catch (err) {
      result.failed += 1;
      console.warn("[queue-publication-reconciler] failed to restore pending generation", {
        runId: repair.runId,
        nodeId: repair.nodeId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/** Idempotently register the once-per-minute publication repair sweep. */
export async function registerQueuePublicationReconciler(): Promise<boolean> {
  try {
    await maintenanceQueue.upsertJobScheduler(
      QUEUE_PUBLICATION_RECONCILER_JOB_ID,
      { pattern: QUEUE_PUBLICATION_RECONCILER_CRON },
      { name: QUEUE_PUBLICATION_RECONCILER_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[queue-publication-reconciler] upsertJobScheduler failed", {
      jobId: QUEUE_PUBLICATION_RECONCILER_JOB_ID,
      err,
    });
    return false;
  }
}

/** Run one repair sweep; transient DB/Redis faults wait for the next lease. */
export async function handleQueuePublicationReconcilerTrigger(): Promise<void> {
  const queue = new BullMQQueueAdapter();
  const runtime = new WorkflowRuntime(
    new PostgresExecutionStore(),
    queue,
    { execute: async () => ({}) },
  );
  try {
    const result = await reconcileQueuePublications({
      claimDue: claimDueQueuePublicationRepairs,
      enqueueQueued: async repair => {
        await queue.enqueueNode({
          runId: repair.runId,
          nodeId: repair.nodeId,
          attempt: repair.attempt,
          publicationGeneration: repair.publicationGeneration,
          ...(repair.recoveryClaimToken
            ? { recoveryClaimToken: repair.recoveryClaimToken }
            : {}),
        });
        await markQueuePublicationSucceeded(
          repair.runId,
          repair.nodeId,
          repair.attempt,
          repair.publicationGeneration,
          repair.recoveryClaimToken ?? undefined,
        );
      },
      loadWorkflow: async runId => {
        const snapshot = await loadRunWorkflowRaw(runId);
        if (!snapshot.found) throw new Error("Run disappeared before publication repair");
        return snapshot.workflow;
      },
      enqueueReady: (runId, workflow) => runtime.enqueueReadyNodes({ runId, workflow }),
    });
    if (result.scanned > 0) {
      console.log(
        `[queue-publication-reconciler] sweep complete — scanned ${result.scanned}, ` +
        `repaired ${result.repaired}, failed ${result.failed}`,
      );
    }
  } catch (err) {
    console.error("[queue-publication-reconciler] sweep failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
