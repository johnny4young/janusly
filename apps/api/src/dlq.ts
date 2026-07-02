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
import { deadLetters, recoveryItems, workflows } from "@janusly/db";
import { eq, desc, asc, and, or, lt, gt, ilike, isNull, count, sql, type SQL } from "drizzle-orm";
import { escapeLikePattern } from "@janusly/data";
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

/** Default recovery-queue page size for keyset ("load more") paging. */
export const RECOVERY_QUEUE_PAGE_DEFAULT = 50;
/** Hard cap on a single recovery-queue page (keeps the `pageSize + 1`
 *  over-fetch under {@link DLQ_LIST_MAX_LIMIT} so `hasMore` is honest). */
export const RECOVERY_QUEUE_PAGE_MAX = 100;

/**
 * A decoded keyset position into the recovery queue. `createdAt` + `id` are the
 * stable tie-break shared by every sort; `key` is the lead-sort value — the
 * `severity` text for the `severity` sort, the `slaTargetAt` ISO string for the
 * `sla` sort, and `null` for `newest`/`oldest` OR for a row with no recovery
 * item (the `NULLS LAST` tail). The keyset predicate interprets `key` per sort.
 */
export type RecoveryQueueCursor = { createdAt: Date; id: string; key: string | null };

/**
 * Encode the keyset position of `row` (the last row of a page) under `sort`
 * into an opaque, URL-safe cursor. The cursor is unsigned — it only names a
 * sort position and every query re-applies `eq(deadLetters.orgId, orgId)`
 * independently, so a tampered cursor can only reorder the caller's own org
 * page (never reach another tenant). Mirrors the unsigned `<iso>|<id>` events
 * cursor posture.
 */
export function encodeRecoveryQueueCursor(sort: RecoveryQueueSort, row: RecoveryQueueRow): string {
  // `created_at` is `defaultNow()`, so a persisted DLQ row always carries it;
  // the epoch fallback only guards the type's nominal `Date | null`.
  const createdAtIso = (row.createdAt ?? new Date(0)).toISOString();
  const key =
    sort === "severity"
      ? row.recovery?.severity ?? null
      : sort === "sla"
        ? row.recovery
          ? row.recovery.slaTargetAt.toISOString()
          : null
        : null;
  const payload = { s: sort, c: createdAtIso, i: row.id, k: key };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode a cursor minted by {@link encodeRecoveryQueueCursor}. Defensive: a
 * malformed / wrong-shape cursor, or one minted under a different sort than the
 * caller now requests, returns `null` (the route then serves page 1 rather than
 * erroring — the client only ever echoes a server-minted cursor, and the web
 * resets it on a sort change). Mirrors `parseEventsCursor`'s null-on-bad posture.
 */
export function decodeRecoveryQueueCursor(
  raw: string | null | undefined,
  expectedSort: RecoveryQueueSort,
): RecoveryQueueCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      s?: unknown;
      c?: unknown;
      i?: unknown;
      k?: unknown;
    };
    if (parsed.s !== expectedSort) return null;
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string" || parsed.i === "") return null;
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) return null;
    const key = typeof parsed.k === "string" ? parsed.k : null;
    // The `sla` lead key round-trips as an ISO timestamp; reject a corrupt one
    // so the keyset never compares against an Invalid Date.
    if (expectedSort === "sla" && key !== null && Number.isNaN(new Date(key).getTime())) return null;
    return { createdAt, id: parsed.i, key };
  } catch {
    return null;
  }
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
  metadataWorkflowId: string | null;
  occurrenceCount: number;
  lastOccurredAt: Date;
};

/** A recovery-queue LIST row: a summary projection of the `dead_letters` row
 *  plus its inline recovery overlay. Deliberately excludes `workflowJson` /
 *  `nodeJson` — those are persisted with `maxBytes: Infinity` for replay
 *  fidelity, so a 200-row page would ship 200 unbounded workflow snapshots to
 *  render a table. The list carries cheap `nodeType` / `workflowName`
 *  projections instead; `GET /dlq?id=` (`getDeadLetter`) returns the full row
 *  and is what the web fetches before opening the Recovery dialog. */
export type RecoveryQueueRow = Omit<typeof deadLetters.$inferSelect, "workflowJson" | "nodeJson"> & {
  /** `node_json->>'type'` — enough for list rendering without the full node. */
  nodeType: string | null;
  /** `workflow_json->>'name'` — enough for list titles without the snapshot. */
  workflowName: string | null;
  recovery: RecoveryQueueOverlay | null;
};

/** Filters + sort for {@link listRecoveryQueue}. `owner`/`severity` key off the
 *  joined `recovery_items` row; an owner/severity filter therefore excludes a
 *  dead letter with no recovery item (its joined columns are null → no match). */
export type RecoveryQueueQuery = {
  status?: string | null;
  owner?: string | null;
  severity?: RecoveryItemSeverity | null;
  /** Case-insensitive substring matched against the dead letter's node id, run
   *  id, or error message (`error_json->>'message'`). Applied with the other
   *  filters BEFORE the cap, so a match older than the newest page surfaces. */
  search?: string | null;
  sort?: RecoveryQueueSort;
  limit?: number;
  /** Decoded keyset position (from {@link decodeRecoveryQueueCursor}). When set,
   *  the query returns only rows strictly AFTER it in the chosen sort order. */
  cursor?: RecoveryQueueCursor | null;
};

/** Build the ORDER BY for a recovery-queue sort. Every sort ends with a
 *  `deadLetters.id` tie-break so the ordering is total — keyset paging needs a
 *  unique final key or it can skip / repeat rows that share the lead value.
 *  `severity`/`sla` push rows with no recovery item last (`NULLS LAST`). */
function recoveryQueueOrderBy(sort: RecoveryQueueSort): SQL[] {
  switch (sort) {
    case "oldest":
      return [asc(deadLetters.createdAt), asc(deadLetters.id)];
    case "severity":
      // Severity text sorts p1<p2<p3<p4 = rank order (most urgent first).
      return [sql`${recoveryItems.severity} asc nulls last`, desc(deadLetters.createdAt), desc(deadLetters.id)];
    case "sla":
      return [sql`${recoveryItems.slaTargetAt} asc nulls last`, desc(deadLetters.createdAt), desc(deadLetters.id)];
    case "newest":
    default:
      return [desc(deadLetters.createdAt), desc(deadLetters.id)];
  }
}

/**
 * The "strictly after the cursor row" keyset predicate for a recovery-queue
 * sort, ANDed into the WHERE so a page continues exactly where the previous one
 * ended. Mirrors {@link recoveryQueueOrderBy} exactly — change one and you must
 * change the other.
 *
 * `newest`/`oldest` are a plain `(createdAt, id)` keyset. `severity`/`sla` are a
 * composite `NULLS LAST` keyset: a row follows the cursor when its lead value is
 * later (`>`), or it is in the null tail (`IS NULL`), or it ties the lead value
 * and advances the `(createdAt DESC, id DESC)` tie-break. When the cursor itself
 * sits in the null tail (`key === null`), only other null-lead rows can follow.
 */
function recoveryQueueKeysetPredicate(sort: RecoveryQueueSort, cursor: RecoveryQueueCursor): SQL | undefined {
  const { createdAt, id, key } = cursor;
  // `(createdAt, id)` advancing for a DESC scan (newest / the severity+sla tie-break).
  const createdDescTie = or(
    lt(deadLetters.createdAt, createdAt),
    and(eq(deadLetters.createdAt, createdAt), lt(deadLetters.id, id)),
  );
  switch (sort) {
    case "oldest":
      return or(
        gt(deadLetters.createdAt, createdAt),
        and(eq(deadLetters.createdAt, createdAt), gt(deadLetters.id, id)),
      );
    case "severity":
      if (key === null) return and(isNull(recoveryItems.severity), createdDescTie);
      return or(
        gt(recoveryItems.severity, key),
        isNull(recoveryItems.severity),
        and(eq(recoveryItems.severity, key), createdDescTie),
      );
    case "sla": {
      if (key === null) return and(isNull(recoveryItems.slaTargetAt), createdDescTie);
      const slaKey = new Date(key);
      return or(
        gt(recoveryItems.slaTargetAt, slaKey),
        isNull(recoveryItems.slaTargetAt),
        and(eq(recoveryItems.slaTargetAt, slaKey), createdDescTie),
      );
    }
    case "newest":
    default:
      return createdDescTie;
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
  if (query.search) {
    // Case-insensitive substring over the dead letter's node id, run id, or
    // error message. LIKE metacharacters are escaped so the term matches
    // literally; the term is parameter-bound by drizzle (no injection). Applied
    // with the other filters → before the cap, ANDed into the org-scoped WHERE.
    const pattern = `%${escapeLikePattern(query.search)}%`;
    filters.push(
      or(
        ilike(deadLetters.nodeId, pattern),
        ilike(deadLetters.runId, pattern),
        ilike(sql`${deadLetters.errorJson}->>'message'`, pattern),
      )!,
    );
  }
  if (query.cursor) {
    const keyset = recoveryQueueKeysetPredicate(query.sort ?? "newest", query.cursor);
    if (keyset) filters.push(keyset);
  }

  const limitValue =
    typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
      ? Math.min(query.limit, DLQ_LIST_MAX_LIMIT)
      : DLQ_LIST_DEFAULT_LIMIT;

  const rows = await db
    .select({
      // Summary projection — see the RecoveryQueueRow doc: workflow_json /
      // node_json are unbounded (replay-fidelity) columns the list never
      // renders; ship one-field `->>` extractions instead.
      dl: {
        id: deadLetters.id,
        orgId: deadLetters.orgId,
        runId: deadLetters.runId,
        nodeId: deadLetters.nodeId,
        attempt: deadLetters.attempt,
        errorJson: deadLetters.errorJson,
        status: deadLetters.status,
        replayedAt: deadLetters.replayedAt,
        createdAt: deadLetters.createdAt,
        nodeType: sql<string | null>`${deadLetters.nodeJson}->>'type'`,
        workflowName: sql<string | null>`${deadLetters.workflowJson}->>'name'`,
      },
      ri: recoveryItems,
      wf: workflows,
    })
    .from(deadLetters)
    .leftJoin(
      recoveryItems,
      and(eq(recoveryItems.orgId, orgId), eq(recoveryItems.deadLetterId, deadLetters.id)),
    )
    .leftJoin(
      workflows,
      and(eq(workflows.orgId, orgId), eq(workflows.id, recoveryItems.workflowId)),
    )
    .where(and(...filters))
    .orderBy(...recoveryQueueOrderBy(query.sort ?? "newest"))
    .limit(limitValue);

  return rows.map(({ dl, ri, wf }) => ({
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
          metadataWorkflowId: wf?.id ?? null,
          occurrenceCount: ri.occurrenceCount,
          lastOccurredAt: ri.lastOccurredAt,
        }
      : null,
  }));
}

/** One keyset page of the recovery queue. `nextCursor` is non-null exactly when
 *  `hasMore` is true — the opaque cursor to pass back for the next page. */
export type RecoveryQueuePage = {
  items: RecoveryQueueRow[];
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * Pure page builder over an over-fetched (`pageSize + 1`) result set: trims to
 * `pageSize`, sets `hasMore` from the extra row, and mints the next cursor from
 * the last returned row under `sort`. Pure so it unit-tests without a DB (mirrors
 * `buildAuditPage`).
 */
export function buildRecoveryQueuePage(
  overfetched: RecoveryQueueRow[],
  pageSize: number,
  sort: RecoveryQueueSort,
): RecoveryQueuePage {
  const hasMore = overfetched.length > pageSize;
  const items = hasMore ? overfetched.slice(0, pageSize) : overfetched;
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeRecoveryQueueCursor(sort, last) : null,
  };
}

/**
 * One keyset page of the recovery queue. Over-fetches `pageSize + 1` rows
 * through {@link listRecoveryQueue} (so the JOIN/WHERE/ORDER live in one place)
 * and folds them through {@link buildRecoveryQueuePage}. `pageSize` is clamped to
 * `[1, RECOVERY_QUEUE_PAGE_MAX]`; the over-fetch therefore stays under
 * {@link DLQ_LIST_MAX_LIMIT} so `hasMore` is never a false negative.
 */
export async function queryRecoveryQueuePage(
  orgId: string,
  query: RecoveryQueueQuery = {},
  pageSize?: number,
): Promise<RecoveryQueuePage> {
  const size =
    typeof pageSize === "number" && Number.isFinite(pageSize) && pageSize > 0
      ? Math.min(Math.floor(pageSize), RECOVERY_QUEUE_PAGE_MAX)
      : RECOVERY_QUEUE_PAGE_DEFAULT;
  const sort = query.sort ?? "newest";
  const rows = await listRecoveryQueue(orgId, { ...query, sort, limit: size + 1 });
  return buildRecoveryQueuePage(rows, size, sort);
}

/** The org-wide DLQ status breakdown for the recovery-queue mini-grid.
 *  `total` is every dead letter in the org; the three named buckets are the
 *  closed `deadLetterStatuses` enum. Unscoped by filter — it is the queue's
 *  health summary, NOT the filtered/paginated page. */
export type DeadLetterCounts = {
  total: number;
  open: number;
  replayed: number;
  resolved: number;
};

/**
 * Count the org's dead letters grouped by status, for the recovery-queue
 * mini-grid. Org-scoped but deliberately UNSCOPED by owner/severity/status —
 * the mini-grid summarizes the whole queue, independent of the filtered page
 * the operator is viewing. One `GROUP BY status` over the existing
 * `(orgId, status, createdAt)` index, so it stays cheap.
 */
export async function countDeadLettersByStatus(orgId: string): Promise<DeadLetterCounts> {
  const rows = await db
    .select({ status: deadLetters.status, count: count() })
    .from(deadLetters)
    .where(eq(deadLetters.orgId, orgId))
    .groupBy(deadLetters.status);

  const counts: DeadLetterCounts = { total: 0, open: 0, replayed: 0, resolved: 0 };
  for (const row of rows) {
    const n = Number(row.count) || 0;
    counts.total += n;
    if (row.status === "open") counts.open = n;
    else if (row.status === "replayed") counts.replayed = n;
    else if (row.status === "resolved") counts.resolved = n;
  }
  return counts;
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
