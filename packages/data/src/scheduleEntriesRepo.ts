/**
 * Repository for `schedule_entries` rows — persistent state for cron-driven
 * trigger nodes (`schedule` node type).
 *
 * Every workflow save scans for `schedule` nodes and reconciles entries here
 * (insert / update / delete) keyed by `(orgId, workflowVersionId, nodeId)`.
 * The BullMQ repeatable job that actually fires the trigger is registered
 * separately by `packages/engine/src/schedule-scheduler.ts`; this repo is
 * the durable source of truth so a cold-start or Redis loss can rebuild
 * the in-memory schedule from disk.
 *
 * Used by:
 * - `packages/engine/src/schedule-scheduler.ts` — sync / unregister / replay
 *   path (calls every function here).
 * - `apps/api/src/index.ts:POST /workflows/save` — indirectly via the
 *   scheduler module on every successful save.
 * - `apps/api/src/index.ts:DELETE /workflows/:id` — indirectly via the
 *   scheduler module on workflow deletion.
 *
 * Invariants:
 * - Multi-tenant scope: every function takes `orgId` and filters via
 *   `eq(scheduleEntries.orgId, orgId)` — EXCEPT `listAllEnabled`, which
 *   the worker calls once at boot to rehydrate every org's schedules and
 *   deliberately omits the filter. It's the single documented exception
 *   and must NEVER be called from a request-path handler.
 * - The unique index on `(org_id, workflow_version_id, node_id)` lets
 *   `upsertScheduleEntry` round-trip an "update or insert" without an
 *   external advisory lock — the DB enforces uniqueness atomically.
 */

import { and, eq, ne } from "drizzle-orm";
import { db, scheduleEntries } from "@janusly/db";

export type ScheduleEntry = typeof scheduleEntries.$inferSelect;

export type UpsertScheduleEntryInput = {
  orgId: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  cronExpression: string;
  enabled: boolean;
  createdBy: string | null;
};

/**
 * Atomically insert a new entry, or update `cron_expression` / `enabled`
 * / `updated_at` when one already exists for
 * `(orgId, workflowVersionId, nodeId)`. Preserves `last_run_at` /
 * `last_run_id` across updates so re-saving a workflow doesn't reset
 * the run history.
 *
 * Single-statement `ON CONFLICT ... DO UPDATE` instead of read-then-write
 * so concurrent saves of the same `(orgId, versionId, nodeId)` triple
 * resolve via the unique index atomically — no race window between the
 * read and the insert.
 */
export async function upsertScheduleEntry(input: UpsertScheduleEntryInput): Promise<ScheduleEntry> {
  const [row] = await db
    .insert(scheduleEntries)
    .values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
      nodeId: input.nodeId,
      cronExpression: input.cronExpression,
      enabled: input.enabled,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [scheduleEntries.orgId, scheduleEntries.workflowVersionId, scheduleEntries.nodeId],
      set: {
        cronExpression: input.cronExpression,
        enabled: input.enabled,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/** List every schedule entry that belongs to a particular workflow (any version). Org-scoped. */
export async function listForWorkflow(orgId: string, workflowId: string): Promise<ScheduleEntry[]> {
  return db
    .select()
    .from(scheduleEntries)
    .where(and(eq(scheduleEntries.orgId, orgId), eq(scheduleEntries.workflowId, workflowId)));
}

/** Delete every schedule entry for a workflow. Used on workflow delete and cross-version churn. */
export async function deleteAllForWorkflow(orgId: string, workflowId: string): Promise<ScheduleEntry[]> {
  return db
    .delete(scheduleEntries)
    .where(and(eq(scheduleEntries.orgId, orgId), eq(scheduleEntries.workflowId, workflowId)))
    .returning();
}

/** Delete schedule entries that belong to PRIOR versions of a workflow (not the new version). */
export async function deletePriorVersions(
  orgId: string,
  workflowId: string,
  keepVersionId: string,
): Promise<ScheduleEntry[]> {
  return db
    .delete(scheduleEntries)
    .where(
      and(
        eq(scheduleEntries.orgId, orgId),
        eq(scheduleEntries.workflowId, workflowId),
        ne(scheduleEntries.workflowVersionId, keepVersionId),
      ),
    )
    .returning();
}

/** Fetch a single entry by id, scoped to the caller's org. */
export async function getScheduleEntry(orgId: string, id: string): Promise<ScheduleEntry | null> {
  const rows = await db
    .select()
    .from(scheduleEntries)
    .where(and(eq(scheduleEntries.orgId, orgId), eq(scheduleEntries.id, id)));
  return rows[0] ?? null;
}

/**
 * Worker-only: fetch an entry by id without an `orgId` filter. The
 * BullMQ scheduler-trigger handler uses this so the orgId is read from
 * the PERSISTED row, not from a (potentially spoofable) payload field.
 * Don't expose to any request-path handler — multi-tenant scope on those
 * paths must always be enforced via the org-scoped `getScheduleEntry`.
 */
export async function getScheduleEntryById(id: string): Promise<ScheduleEntry | null> {
  const rows = await db
    .select()
    .from(scheduleEntries)
    .where(eq(scheduleEntries.id, id));
  return rows[0] ?? null;
}

/**
 * Worker-only: list every enabled schedule entry across every org. Used by
 * the worker's cold-start replay to idempotently re-register BullMQ
 * repeatable jobs. Deliberately NOT org-scoped — there is no caller other
 * than process boot. Don't expose to any request-path handler.
 */
export async function listAllEnabled(): Promise<ScheduleEntry[]> {
  return db.select().from(scheduleEntries).where(eq(scheduleEntries.enabled, true));
}

/** Record a successful trigger fire. Updates `last_run_at` / `last_run_id` for the operator-facing surface. */
export async function recordFire(orgId: string, id: string, runId: string): Promise<void> {
  await db
    .update(scheduleEntries)
    .set({ lastRunAt: new Date(), lastRunId: runId })
    .where(and(eq(scheduleEntries.orgId, orgId), eq(scheduleEntries.id, id)));
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
