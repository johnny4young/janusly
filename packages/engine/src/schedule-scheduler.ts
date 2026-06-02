/**
 * Scheduler lifecycle for cron-triggered workflow runs.
 *
 * Responsibilities:
 *   1. Reconcile `schedule_entries` rows + BullMQ job schedulers on workflow
 *      save (`syncWorkflowSchedules`).
 *   2. Tear down both on workflow delete (`unregisterAllForWorkflow`).
 *   3. Re-register every enabled entry on worker boot (`replayAllScheduleEntries`)
 *      so Redis losses or fresh-cluster boots rebuild the schedule from disk.
 *   4. Handle each BullMQ trigger fire (`handleScheduleTrigger`) by spawning
 *      a new run via `startRun`.
 *
 * BullMQ shape:
 *   We use BullMQ 5's `upsertJobScheduler(id, { pattern }, { name, data })`
 *   API — the modern replacement for the deprecated `repeat:` option. The
 *   scheduler id is deterministic
 *   (`schedule:<orgId>:<workflowVersionId>:<nodeId>`) so concurrent worker
 *   replicas re-registering at boot don't double-register; BullMQ treats the
 *   id as the unique key.
 *
 * Atomicity:
 *   The DB write and the BullMQ register/unregister happen in sequence,
 *   not in a single atomic operation. A crash between commit and BullMQ
 *   register leaves a row in the DB without a BullMQ scheduler. The next
 *   save re-syncs, AND the worker's cold-start replay re-registers — both
 *   are idempotent because they use the same deterministic id. We log on
 *   register failures but never throw — a failing register must not undo
 *   the operator's save.
 *
 * Used by:
 * - `apps/api/src/workflows-save.ts` — post-commit `syncWorkflowSchedules`.
 * - `apps/api/src/routes/workflows-routes.ts:DELETE /workflows/:id` —
 *   `unregisterAllForWorkflow`.
 * - `packages/engine/src/worker.ts` — `replayAllScheduleEntries` at boot,
 *   `handleScheduleTrigger` for `job.name === "schedule-trigger"`.
 *
 * Invariants:
 * - The BullMQ data payload carries `{ scheduleEntryId, orgId,
 *   workflowVersionId, nodeId }`. The handler reads `orgId` from the
 *   PERSISTED row (not the payload) so a spoofed payload can't trigger
 *   another tenant's workflow. Stale-scheduler cleanup uses BullMQ's
 *   `repeatJobKey`, not payload hints.
 * - `enabled = false` removes the BullMQ scheduler; the row stays so the
 *   operator can re-enable by re-saving without re-typing the cron.
 * - `schedule.config.enabled = false` is the pause mechanism — re-save the
 *   workflow to flip it; there is no separate pause/resume endpoint.
 */

import { and, eq } from "drizzle-orm";
import { db, workflowVersions } from "@janusly/db";
import {
  deleteAllForWorkflow,
  deletePriorVersions,
  getScheduleEntryById,
  listAllEnabled,
  listForWorkflow,
  recordFire,
  upsertScheduleEntry,
  type ScheduleEntry,
} from "@janusly/data";
import { workflowQueue } from "./queue";
import { resolveScheduleConfig } from "./schedule";
import { startRun } from "./start-run";
import { WorkflowSchema, type Workflow } from "@janusly/shared";

/** Stable separator for the BullMQ scheduler id triple. */
const SCHEDULER_ID_PREFIX = "schedule";
const SCHEDULER_JOB_NAME = "schedule-trigger";

export function buildScheduleJobId(args: {
  orgId: string;
  workflowVersionId: string;
  nodeId: string;
}): string {
  return `${SCHEDULER_ID_PREFIX}:${args.orgId}:${args.workflowVersionId}:${args.nodeId}`;
}

export type SchedulableNode = {
  id: string;
  type: string;
  config: Record<string, unknown>;
};

export type SyncWorkflowSchedulesInput = {
  orgId: string;
  workflowId: string;
  workflowVersionId: string;
  nodes: SchedulableNode[];
  createdBy: string | null;
};

export type ScheduleTriggerPayload = {
  scheduleEntryId: string;
  orgId: string;
  workflowVersionId: string;
  nodeId: string;
};

async function registerBullMqScheduler(args: {
  jobId: string;
  cronExpression: string;
  payload: ScheduleTriggerPayload;
}): Promise<void> {
  try {
    await workflowQueue.upsertJobScheduler(
      args.jobId,
      { pattern: args.cronExpression },
      { name: SCHEDULER_JOB_NAME, data: args.payload as unknown as Record<string, unknown> },
    );
  } catch (err) {
    console.error("[schedule] upsertJobScheduler failed", { jobId: args.jobId, err });
  }
}

async function removeBullMqScheduler(jobId: string): Promise<void> {
  try {
    await workflowQueue.removeJobScheduler(jobId);
  } catch (err) {
    console.error("[schedule] removeJobScheduler failed", { jobId, err });
  }
}

/**
 * Reconcile `schedule_entries` + BullMQ schedulers for a freshly-saved
 * workflow version. Runs OUTSIDE the save transaction — failures here are
 * logged but don't roll the save back, because the next save (or the
 * worker's cold-start replay) will reconcile via the deterministic id.
 *
 * Behaviour:
 *   1. Delete every entry tied to a prior version of this workflow id
 *      (and remove their BullMQ schedulers) so v3's schedule replaces v2's
 *      without both firing in parallel.
 *   2. For each `schedule` node in the new version, upsert an entry and
 *      register a BullMQ scheduler (or remove it if `enabled === false`).
 */
export async function syncWorkflowSchedules(input: SyncWorkflowSchedulesInput): Promise<void> {
  const { orgId, workflowId, workflowVersionId, nodes, createdBy } = input;

  const prior = await deletePriorVersions(orgId, workflowId, workflowVersionId);
  for (const row of prior) {
    await removeBullMqScheduler(
      buildScheduleJobId({
        orgId: row.orgId,
        workflowVersionId: row.workflowVersionId,
        nodeId: row.nodeId,
      }),
    );
  }

  const scheduleNodes = nodes.filter((node) => node.type === "schedule");
  for (const node of scheduleNodes) {
    let resolved: ReturnType<typeof resolveScheduleConfig>;
    try {
      resolved = resolveScheduleConfig(node.config);
    } catch (err) {
      console.error("[schedule] skipping node with invalid config", { nodeId: node.id, err });
      continue;
    }

    const entry = await upsertScheduleEntry({
      orgId,
      workflowId,
      workflowVersionId,
      nodeId: node.id,
      cronExpression: resolved.cronExpression,
      enabled: resolved.enabled,
      createdBy,
    });

    const jobId = buildScheduleJobId({ orgId, workflowVersionId, nodeId: node.id });
    if (resolved.enabled) {
      await registerBullMqScheduler({
        jobId,
        cronExpression: resolved.cronExpression,
        payload: {
          scheduleEntryId: entry.id,
          orgId,
          workflowVersionId,
          nodeId: node.id,
        },
      });
    } else {
      await removeBullMqScheduler(jobId);
    }
  }
}

/**
 * Tear down every scheduler for a workflow (any version). Used by
 * `DELETE /workflows/:id` and by any test/admin tooling that fully removes
 * a workflow.
 */
export async function unregisterAllForWorkflow(orgId: string, workflowId: string): Promise<void> {
  const rows = await listForWorkflow(orgId, workflowId);
  await deleteAllForWorkflow(orgId, workflowId);
  for (const row of rows) {
    await removeBullMqScheduler(
      buildScheduleJobId({
        orgId: row.orgId,
        workflowVersionId: row.workflowVersionId,
        nodeId: row.nodeId,
      }),
    );
  }
}

/**
 * Worker boot path: idempotently re-register a BullMQ scheduler for every
 * enabled `schedule_entries` row. Safe to call from multiple replicas
 * because `upsertJobScheduler` keys on the deterministic id.
 */
export async function replayAllScheduleEntries(): Promise<number> {
  const rows = await listAllEnabled();
  for (const row of rows) {
    await registerBullMqScheduler({
      jobId: buildScheduleJobId({
        orgId: row.orgId,
        workflowVersionId: row.workflowVersionId,
        nodeId: row.nodeId,
      }),
      cronExpression: row.cronExpression,
      payload: {
        scheduleEntryId: row.id,
        orgId: row.orgId,
        workflowVersionId: row.workflowVersionId,
        nodeId: row.nodeId,
      },
    });
  }
  return rows.length;
}

/**
 * The payload carries `scheduleEntryId` plus the (versionId, nodeId)
 * triple. The handler ONLY reads `scheduleEntryId` to look up the
 * persisted row. Stale-tick cleanup uses BullMQ's `repeatJobKey`, which
 * the worker passes separately from `job.data`; payload hints never
 * choose which scheduler to remove. Multi-tenant scope is enforced via
 * the row's `orgId`, never the payload's.
 */
function parseScheduleTriggerPayload(data: unknown): { scheduleEntryId: string } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.scheduleEntryId !== "string" || obj.scheduleEntryId.length === 0) return null;
  return { scheduleEntryId: obj.scheduleEntryId };
}

function isScheduleJobId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${SCHEDULER_ID_PREFIX}:`);
}

/**
 * Handle one BullMQ scheduler tick. Looks up the persisted entry by id
 * ALONE (no orgId from the payload), then derives every multi-tenant
 * field — orgId, workflowVersionId — from the row itself. A spoofed
 * payload with a different orgId cannot trigger another tenant's run
 * because the lookup ignores the payload's hints.
 *
 * Idempotency: if the entry has been disabled or deleted between the
 * scheduler firing and the worker picking up the job, the handler exits
 * without starting a run.
 *
 * Known limitation: BullMQ schedulers can in rare cases emit duplicate
 * ticks under broker reconnect or clock skew, each of which spawns a run.
 * For minute-granular schedules this is usually tolerated by the
 * downstream workflow's own idempotency; tighter dedup would require a
 * unique constraint on `(scheduleEntryId, triggeredAtMinute)` and is
 * tracked as a future tightening.
 */
export async function handleScheduleTrigger(data: unknown, repeatJobKey?: string): Promise<void> {
  const payload = parseScheduleTriggerPayload(data);
  if (!payload) {
    console.error("[schedule] invalid trigger payload", { data });
    return;
  }

  const entry = await getScheduleEntryById(payload.scheduleEntryId);
  if (!entry) {
    // Stale scheduler tick after a workflow delete. Best-effort cleanup
    // so BullMQ doesn't keep firing into the void. Do not derive the
    // scheduler id from job.data: a forged payload must not be able to
    // unregister another tenant's scheduler.
    if (isScheduleJobId(repeatJobKey)) {
      await removeBullMqScheduler(repeatJobKey);
    }
    return;
  }

  if (!entry.enabled) {
    // Disabled but not yet unregistered — clean up the BullMQ side
    // and exit without firing. The BullMQ id is derived from the
    // ROW, not the payload.
    await removeBullMqScheduler(
      buildScheduleJobId({
        orgId: entry.orgId,
        workflowVersionId: entry.workflowVersionId,
        nodeId: entry.nodeId,
      }),
    );
    return;
  }

  const workflow = await loadWorkflowSnapshot(entry);
  if (!workflow) {
    console.error("[schedule] workflow snapshot missing", { entryId: entry.id });
    return;
  }

  const triggeredAt = new Date().toISOString();
  const { runId } = await startRun({
    ...workflow,
    orgId: entry.orgId,
    versionId: entry.workflowVersionId,
    createdBy: null,
    input: {
      triggeredBy: "schedule",
      scheduleEntryId: entry.id,
      nodeId: entry.nodeId,
      triggeredAt,
    },
  });

  await recordFire(entry.orgId, entry.id, runId);
}

async function loadWorkflowSnapshot(entry: ScheduleEntry): Promise<Workflow | null> {
  const rows = await db
    .select({ dagJson: workflowVersions.dagJson })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.orgId, entry.orgId),
        eq(workflowVersions.id, entry.workflowVersionId),
      ),
    );
  if (!rows[0]?.dagJson) return null;
  const parsed = WorkflowSchema.safeParse(rows[0].dagJson);
  if (!parsed.success) {
    console.error("[schedule] persisted workflow failed schema parse", {
      entryId: entry.id,
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}
