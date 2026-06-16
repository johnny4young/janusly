/**
 * `dead_letters` row CRUD for the API. Every helper scopes by `orgId` —
 * the DLQ is multi-tenant. `markDeadLetterReplayed` is the chokepoint
 * called after `DLQReplayAdapter` re-enqueues the failed node.
 *
 * Used by `apps/api/src/routes/dlq-routes.ts` `/dlq/*` routes.
 *
 * Invariants:
 * - Multi-tenant scope: `eq(deadLetters.orgId, orgId)` on every query.
 *   Don't surface a `dead_letters` row to the wrong org.
 */

import { db } from "@janusly/db";
import { deadLetters, recoveryItems } from "@janusly/db";
import { eq, desc, asc, and, sql, type SQL } from "drizzle-orm";
import type { RecoveryItemSeverity } from "@janusly/shared";

/** Closed enum of DLQ row statuses. */
export const deadLetterStatuses = ["open", "replayed", "resolved"] as const;
/** Inferred string-literal union for `deadLetterStatuses`. */
export type DeadLetterStatus = typeof deadLetterStatuses[number];

/** Type guard for `DeadLetterStatus`. */
export function isDeadLetterStatus(value: unknown): value is DeadLetterStatus {
  return typeof value === "string" && (deadLetterStatuses as readonly string[]).includes(value);
}

/** Default cap when no `limit` is supplied. Matches the rest of the API. */
export const DLQ_LIST_DEFAULT_LIMIT = 100;
/** Hard cap on `limit` to prevent unbounded scans. */
export const DLQ_LIST_MAX_LIMIT = 200;

/** Closed set of recovery-queue sort keys (mirrors the web `SORT_KEYS`).
 *  `newest`/`oldest` order by the dead letter's `createdAt`; `severity`/`sla`
 *  order by the joined recovery item with a `createdAt desc` tie-break. */
export const RECOVERY_QUEUE_SORTS = ["newest", "oldest", "severity", "sla"] as const;
/** Inferred string-literal union for `RECOVERY_QUEUE_SORTS`. */
export type RecoveryQueueSort = typeof RECOVERY_QUEUE_SORTS[number];

/** Type guard for `RecoveryQueueSort`. */
export function isRecoveryQueueSort(value: unknown): value is RecoveryQueueSort {
  return typeof value === "string" && (RECOVERY_QUEUE_SORTS as readonly string[]).includes(value);
}

/** The recovery-item overlay surfaced inline on each recovery-queue row — the
 *  badge + drawer fields the web reads. `null` when the dead letter has no
 *  paired recovery item (e.g. a legacy tenant with auto-create off). */
export type RecoveryQueueOverlay = {
  id: string;
  owner: string | null;
  severity: string;
  status: string;
  slaTargetAt: Date;
  resolutionReason: string | null;
  comments: unknown;
  workflowId: string | null;
  occurrenceCount: number;
  lastOccurredAt: Date;
};

/** A recovery-queue row: the `dead_letters` row plus its inline recovery
 *  overlay. The web renders the queue from this single cap-correct shape. */
export type RecoveryQueueRow = typeof deadLetters.$inferSelect & {
  recovery: RecoveryQueueOverlay | null;
};

/** Filters + sort for {@link listRecoveryQueue}. `owner`/`severity` key off the
 *  joined `recovery_items` row; an owner/severity filter therefore excludes a
 *  dead letter with no recovery item (its joined columns are null → no match). */
export type RecoveryQueueQuery = {
  status?: string | null;
  owner?: string | null;
  severity?: RecoveryItemSeverity | null;
  sort?: RecoveryQueueSort;
  limit?: number;
};

/** Build the ORDER BY for a recovery-queue sort. `severity`/`sla` push rows
 *  with no recovery item last (`NULLS LAST`) and tie-break newest-first so the
 *  ordering is deterministic. */
function recoveryQueueOrderBy(sort: RecoveryQueueSort): SQL[] {
  switch (sort) {
    case "oldest":
      return [asc(deadLetters.createdAt)];
    case "severity":
      // Severity text sorts p1<p2<p3<p4 = rank order (most urgent first).
      return [sql`${recoveryItems.severity} asc nulls last`, desc(deadLetters.createdAt)];
    case "sla":
      return [sql`${recoveryItems.slaTargetAt} asc nulls last`, desc(deadLetters.createdAt)];
    case "newest":
    default:
      return [desc(deadLetters.createdAt)];
  }
}

/**
 * The cap-correct recovery-queue list: `dead_letters` LEFT JOINed to
 * `recovery_items`, filtered + sorted SERVER-SIDE before the `limit` cap so a
 * matching row (e.g. a P1 older than the newest 200) surfaces regardless of its
 * `createdAt`. Returns each dead letter with its recovery overlay inline.
 * Multi-tenant: every leg is scoped to `orgId`.
 */
export async function listRecoveryQueue(orgId: string, query: RecoveryQueueQuery = {}): Promise<RecoveryQueueRow[]> {
  const filters = [eq(deadLetters.orgId, orgId)];
  if (isDeadLetterStatus(query.status)) filters.push(eq(deadLetters.status, query.status));
  if (query.owner) filters.push(eq(recoveryItems.owner, query.owner));
  if (query.severity) filters.push(eq(recoveryItems.severity, query.severity));

  const limitValue =
    typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
      ? Math.min(query.limit, DLQ_LIST_MAX_LIMIT)
      : DLQ_LIST_DEFAULT_LIMIT;

  const rows = await db
    .select({ dl: deadLetters, ri: recoveryItems })
    .from(deadLetters)
    .leftJoin(
      recoveryItems,
      and(eq(recoveryItems.orgId, orgId), eq(recoveryItems.deadLetterId, deadLetters.id)),
    )
    .where(and(...filters))
    .orderBy(...recoveryQueueOrderBy(query.sort ?? "newest"))
    .limit(limitValue);

  return rows.map(({ dl, ri }) => ({
    ...dl,
    // `ri.id` is NOT NULL, so a present row always has it — guarding on it is
    // robust whether the LEFT JOIN miss surfaces as `null` or an all-null row.
    recovery: ri && ri.id
      ? {
          id: ri.id,
          owner: ri.owner,
          severity: ri.severity,
          status: ri.status,
          slaTargetAt: ri.slaTargetAt,
          resolutionReason: ri.resolutionReason,
          comments: ri.comments,
          workflowId: ri.workflowId,
          occurrenceCount: ri.occurrenceCount,
          lastOccurredAt: ri.lastOccurredAt,
        }
      : null,
  }));
}

/** Fetch one DLQ row by id, scoped to the org. Returns `null` when absent. */
export async function getDeadLetter(orgId: string, id: string) {
  const rows = await db.select().from(deadLetters).where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId)));
  return rows[0] ?? null;
}

/** Flip status to `replayed` and stamp `replayedAt`. Called after re-enqueue. */
export async function markDeadLetterReplayed(orgId: string, id: string) {
  await db.update(deadLetters)
    .set({ status: "replayed", replayedAt: new Date() })
    .where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId)));
}

/** Flip status to `resolved` (closed without replay). */
export async function markDeadLetterResolved(orgId: string, id: string) {
  await db.update(deadLetters)
    .set({ status: "resolved" })
    .where(and(eq(deadLetters.id, id), eq(deadLetters.orgId, orgId)));
}
