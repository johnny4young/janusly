/**
 * Repository for the `recovery_items` table — operator-tracked incidents
 * over open DLQ rows.
 *
 * Used by:
 *  - `apps/api/src/routes/recovery-items-routes.ts` (8 transition routes)
 *  - `packages/engine/src/recovery/recovery-item-hook.ts` (auto-create
 *    on DLQ insert + auto-resolve on `/dlq/replay` /
 *    `/dlq/cluster-apply` success — lives in engine so worker process
 *    can register the creator too)
 *  - `apps/api/src/alerts/scanner.ts` (SLA breach detection via
 *    `listOpenItemsWithBreachedSla`)
 *
 * Invariants:
 *  - Every read filters by `orgId`. Cross-org reads are structurally
 *    impossible — there's no helper that bypasses the predicate.
 *  - `createRecoveryItem` is idempotent on `(orgId, deadLetterId)`. The
 *    cluster-apply route calls it N times; the unique index keeps the
 *    result well-defined.
 *  - Every mutation uses a CAS-style `UPDATE … WHERE status IN
 *    (allowed_pre_states)`. The route layer converts a `null` result
 *    (CAS lost) into a 409 with `{ code: "recovery_item_transition_invalid",
 *    currentStatus }`. This mirrors `recordDecision` in
 *    `autoHealingRepo.ts:264-297`.
 *  - Closed-enum validation lives in `@janusly/shared/src/recovery-item`
 *    (Zod). The repo doesn't re-validate — caller is responsible for
 *    passing schema-parsed input.
 */

import { and, count, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, recoveryItems, recoveryItemChildren } from "@janusly/db";
import { getRecoverySlaSeconds } from "./orgConfigRepo";
import {
  defaultSlaTargetAt,
  isSeverityEscalation,
  MAX_COMMENTS_PER_ITEM,
  type RecoveryItemComment,
  type RecoveryItemResolutionReason,
  type RecoveryItemSeverity,
  type RecoveryItemStatus,
} from "@janusly/shared";

export type RecoveryItemRow = typeof recoveryItems.$inferSelect;

async function defaultSlaTargetAtForOrg(
  orgId: string,
  severity: RecoveryItemSeverity,
  from?: Date,
): Promise<Date> {
  const secondsBySeverity = await getRecoverySlaSeconds(orgId);
  return defaultSlaTargetAt(severity, from ?? new Date(), secondsBySeverity);
}

export type RecoveryItem = {
  id: string;
  orgId: string;
  deadLetterId: string;
  workflowId: string | null;
  owner: string | null;
  severity: RecoveryItemSeverity;
  status: RecoveryItemStatus;
  slaTargetAt: Date;
  resolutionReason: RecoveryItemResolutionReason | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  /** First meaningful recovery action; set once and never moved by later transitions. */
  firstActionAt: Date | null;
  comments: RecoveryItemComment[];
  /** Normalized failure signature — the debounce match key alongside org + workflow. Null on items created before debounce or from a signature-less DLQ row. */
  errorSignature: string | null;
  /** Number of DLQ failures collapsed into this incident (1 + attached children). */
  occurrenceCount: number;
  /** When the first occurrence (the row's own DLQ failure) landed. */
  firstOccurredAt: Date;
  /** When the most recent occurrence landed — the sliding-window anchor for debounce. */
  lastOccurredAt: Date;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function hydrate(row: RecoveryItemRow): RecoveryItem {
  return {
    id: row.id,
    orgId: row.orgId,
    deadLetterId: row.deadLetterId,
    workflowId: row.workflowId,
    owner: row.owner,
    severity: row.severity as RecoveryItemSeverity,
    status: row.status as RecoveryItemStatus,
    slaTargetAt: row.slaTargetAt,
    resolutionReason: row.resolutionReason as RecoveryItemResolutionReason | null,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
    firstActionAt: row.firstActionAt,
    comments: (row.comments as RecoveryItemComment[]) ?? [],
    errorSignature: row.errorSignature,
    occurrenceCount: row.occurrenceCount,
    firstOccurredAt: row.firstOccurredAt,
    lastOccurredAt: row.lastOccurredAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A DLQ occurrence attached to a recovery_item parent during a failure
 * storm. Powers the "N occurrences" badge + the child-DLQ drawer.
 */
export type RecoveryItemChild = {
  id: string;
  recoveryItemId: string;
  deadLetterId: string;
  occurredAt: Date;
};

function hydrateChild(row: typeof recoveryItemChildren.$inferSelect): RecoveryItemChild {
  return {
    id: row.id,
    recoveryItemId: row.recoveryItemId,
    deadLetterId: row.deadLetterId,
    occurredAt: row.occurredAt,
  };
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function getRecoveryItemById(
  orgId: string,
  id: string,
): Promise<RecoveryItem | null> {
  const rows = await db
    .select()
    .from(recoveryItems)
    .where(and(eq(recoveryItems.orgId, orgId), eq(recoveryItems.id, id)));
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function getRecoveryItemByDeadLetterId(
  orgId: string,
  deadLetterId: string,
): Promise<RecoveryItem | null> {
  const rows = await db
    .select()
    .from(recoveryItems)
    .where(and(eq(recoveryItems.orgId, orgId), eq(recoveryItems.deadLetterId, deadLetterId)));
  return rows[0] ? hydrate(rows[0]) : null;
}

export type ListRecoveryItemsInput = {
  orgId: string;
  status?: RecoveryItemStatus;
  owner?: string;
  severity?: RecoveryItemSeverity;
  limit?: number;
  cursorIso?: string;
};

export async function listRecoveryItems(
  input: ListRecoveryItemsInput,
): Promise<{ items: RecoveryItem[]; cursor: string | null; hasMore: boolean }> {
  const limit = Math.min(Math.max(1, input.limit ?? 50), 200);
  const filters = [eq(recoveryItems.orgId, input.orgId)];
  if (input.status) filters.push(eq(recoveryItems.status, input.status));
  if (input.owner) filters.push(eq(recoveryItems.owner, input.owner));
  if (input.severity) filters.push(eq(recoveryItems.severity, input.severity));
  if (input.cursorIso) filters.push(lt(recoveryItems.createdAt, new Date(input.cursorIso)));

  const rows = await db
    .select()
    .from(recoveryItems)
    .where(and(...filters))
    .orderBy(desc(recoveryItems.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const items = trimmed.map(hydrate);
  const cursor =
    hasMore && items.length > 0 ? items[items.length - 1].createdAt.toISOString() : null;
  return { items, cursor, hasMore };
}

/** Used by the alert scanner to fire `recovery_item.sla_breached`. */
export async function listOpenItemsWithBreachedSla(orgId: string): Promise<RecoveryItem[]> {
  const rows = await db
    .select()
    .from(recoveryItems)
    .where(
      and(
        eq(recoveryItems.orgId, orgId),
        // status NOT IN ('resolved')
        sql`${recoveryItems.status} <> 'resolved'`,
        lte(recoveryItems.slaTargetAt, new Date()),
      ),
    )
    .limit(500);
  return rows.map(hydrate);
}

/** Used by the alert scanner to enumerate orgs with at least one recovery_item. */
export async function listOrgIdsWithRecoveryItems(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: recoveryItems.orgId })
    .from(recoveryItems);
  return rows.map((r) => r.orgId);
}

// ─── Idempotent create ─────────────────────────────────────────────────────

export type CreateRecoveryItemInput = {
  orgId: string;
  deadLetterId: string;
  workflowId?: string | null;
  severity?: RecoveryItemSeverity;
  owner?: string | null;
  createdBy?: string | null;
  /** Normalized failure signature persisted as the debounce match key. */
  errorSignature?: string | null;
};

/**
 * Create a recovery item idempotently. When a row already exists for the
 * `(orgId, deadLetterId)` pair the existing row is returned untouched — the
 * cluster-apply fan-out can call this N times without producing N audit
 * rows or duplicate state. The CALLER decides whether to audit `created`
 * (the result type carries `wasCreated: boolean`).
 */
export async function createRecoveryItem(
  input: CreateRecoveryItemInput,
): Promise<{ item: RecoveryItem; wasCreated: boolean }> {
  const severity = input.severity ?? "p3";
  const now = new Date();
  // Honor the tenant's configured per-severity SLA targets (recovery.slaPolicies);
  // an unconfigured org resolves to the built-in SLA_SECONDS_BY_SEVERITY defaults.
  const slaTargetAt = await defaultSlaTargetAtForOrg(input.orgId, severity, now);
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(recoveryItems)
    .values({
      id,
      orgId: input.orgId,
      deadLetterId: input.deadLetterId,
      workflowId: input.workflowId ?? null,
      owner: input.owner ?? null,
      severity,
      status: "open",
      slaTargetAt,
      resolutionReason: null,
      resolvedBy: null,
      resolvedAt: null,
      firstActionAt: null,
      comments: [],
      errorSignature: input.errorSignature ?? null,
      occurrenceCount: 1,
      firstOccurredAt: now,
      lastOccurredAt: now,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [recoveryItems.orgId, recoveryItems.deadLetterId] })
    .returning({ id: recoveryItems.id });

  if (inserted.length === 0) {
    const existing = await getRecoveryItemByDeadLetterId(input.orgId, input.deadLetterId);
    if (!existing) throw new Error("recovery item insert lost conflict but no existing row was found");
    return { item: existing, wasCreated: false };
  }

  const item = await getRecoveryItemById(input.orgId, inserted[0]!.id);
  if (!item) throw new Error("recovery item disappeared immediately after insert");
  return { item, wasCreated: true };
}

// ─── Debounce / failure-storm grouping ───────────────────────────────────────

export type FindOpenRecoveryItemForDebounceInput = {
  orgId: string;
  workflowId: string | null;
  errorSignature: string | null;
  /** Sliding-window cutoff: only match items whose `lastOccurredAt >= notBefore`. */
  notBefore: Date;
};

/**
 * Find the most-recent still-open recovery item a new DLQ failure should
 * attach to, or `null` when none qualifies. Match key is
 * `(orgId, workflowId, errorSignature)` against any non-`resolved` item
 * whose `lastOccurredAt` falls within the caller's debounce window. Returns
 * `null` immediately when `errorSignature` is null (a signature-less failure
 * can't be grouped). Ordered by `lastOccurredAt` desc so the freshest storm
 * wins when more than one open item somehow matches.
 */
export async function findOpenRecoveryItemForDebounce(
  input: FindOpenRecoveryItemForDebounceInput,
): Promise<RecoveryItem | null> {
  if (!input.errorSignature) return null;
  const rows = await db
    .select()
    .from(recoveryItems)
    .where(
      and(
        eq(recoveryItems.orgId, input.orgId),
        input.workflowId === null
          ? isNull(recoveryItems.workflowId)
          : eq(recoveryItems.workflowId, input.workflowId),
        eq(recoveryItems.errorSignature, input.errorSignature),
        sql`${recoveryItems.status} <> 'resolved'`,
        gte(recoveryItems.lastOccurredAt, input.notBefore),
      ),
    )
    .orderBy(desc(recoveryItems.lastOccurredAt))
    .limit(1);
  return rows[0] ? hydrate(rows[0]) : null;
}

export type AttachDeadLetterInput = {
  orgId: string;
  recoveryItemId: string;
  deadLetterId: string;
  occurredAt?: Date;
};

/**
 * Attach a DLQ occurrence to an existing recovery item. Idempotent on
 * `(recoveryItemId, deadLetterId)`: a replayed insert is a no-op and the
 * parent counter is bumped ONLY when a child row was actually inserted, so
 * repeated calls never inflate `occurrenceCount`. Returns the new
 * `occurrenceCount`, or `null` when the attach was a duplicate (no bump) or
 * the parent vanished.
 */
export async function attachDeadLetterToRecoveryItem(
  input: AttachDeadLetterInput,
): Promise<{ occurrenceCount: number } | null> {
  const occurredAt = input.occurredAt ?? new Date();
  const inserted = await db
    .insert(recoveryItemChildren)
    .values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      recoveryItemId: input.recoveryItemId,
      deadLetterId: input.deadLetterId,
      occurredAt,
    })
    .onConflictDoNothing({
      target: [recoveryItemChildren.recoveryItemId, recoveryItemChildren.deadLetterId],
    })
    .returning({ id: recoveryItemChildren.id });
  if (inserted.length === 0) return null; // duplicate occurrence — don't double-count

  const updated = await db
    .update(recoveryItems)
    .set({
      occurrenceCount: sql`${recoveryItems.occurrenceCount} + 1`,
      lastOccurredAt: occurredAt,
      updatedAt: new Date(),
    })
    .where(and(eq(recoveryItems.orgId, input.orgId), eq(recoveryItems.id, input.recoveryItemId)))
    .returning({ occurrenceCount: recoveryItems.occurrenceCount });
  if (updated.length === 0) return null;
  return { occurrenceCount: updated[0]!.occurrenceCount };
}

const RECOVERY_ITEM_CHILDREN_DEFAULT_LIMIT = 100;
const RECOVERY_ITEM_CHILDREN_MAX_LIMIT = 200;

/** List the DLQ occurrences attached to a recovery item, newest first. Tenant-scoped. */
export async function listRecoveryItemChildren(
  orgId: string,
  recoveryItemId: string,
  limit?: number,
): Promise<RecoveryItemChild[]> {
  const capped = Math.min(
    Math.max(1, limit ?? RECOVERY_ITEM_CHILDREN_DEFAULT_LIMIT),
    RECOVERY_ITEM_CHILDREN_MAX_LIMIT,
  );
  const rows = await db
    .select()
    .from(recoveryItemChildren)
    .where(
      and(
        eq(recoveryItemChildren.orgId, orgId),
        eq(recoveryItemChildren.recoveryItemId, recoveryItemId),
      ),
    )
    .orderBy(desc(recoveryItemChildren.occurredAt))
    .limit(capped);
  return rows.map(hydrateChild);
}

/** Count the DLQ occurrences attached to a recovery item. Tenant-scoped. */
export async function countRecoveryItemChildren(
  orgId: string,
  recoveryItemId: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(recoveryItemChildren)
    .where(
      and(
        eq(recoveryItemChildren.orgId, orgId),
        eq(recoveryItemChildren.recoveryItemId, recoveryItemId),
      ),
    );
  return rows[0]?.value ?? 0;
}

// ─── CAS-style transitions ─────────────────────────────────────────────────

export type TransitionResult = { before: RecoveryItem; after: RecoveryItem } | null;

async function applyCas(
  orgId: string,
  id: string,
  allowedPre: readonly RecoveryItemStatus[],
  patch: Partial<RecoveryItemRow>,
): Promise<TransitionResult> {
  const before = await getRecoveryItemById(orgId, id);
  if (!before) return null;
  if (!allowedPre.includes(before.status)) return null;

  const result = await db
    .update(recoveryItems)
    .set({
      ...patch,
      firstActionAt: sql`coalesce(${recoveryItems.firstActionAt}, now())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recoveryItems.orgId, orgId),
        eq(recoveryItems.id, id),
        inArray(recoveryItems.status, [...allowedPre]),
      ),
    )
    .returning({ id: recoveryItems.id });
  if (result.length === 0) return null;

  const after = await getRecoveryItemById(orgId, id);
  if (!after) return null;
  return { before, after };
}

export async function acknowledgeRecoveryItem(
  orgId: string,
  id: string,
  input: { owner?: string | null; severity?: RecoveryItemSeverity; slaTargetAtOverrideIso?: string },
): Promise<TransitionResult> {
  const patch: Partial<RecoveryItemRow> = { status: "acknowledged" };
  if (input.owner !== undefined) patch.owner = input.owner;
  if (input.severity) {
    patch.severity = input.severity;
    patch.slaTargetAt = input.slaTargetAtOverrideIso
      ? new Date(input.slaTargetAtOverrideIso)
      : await defaultSlaTargetAtForOrg(orgId, input.severity);
  } else if (input.slaTargetAtOverrideIso) {
    patch.slaTargetAt = new Date(input.slaTargetAtOverrideIso);
  }
  return applyCas(orgId, id, ["open", "reopened"], patch);
}

export async function setInProgressRecoveryItem(
  orgId: string,
  id: string,
  input: { owner?: string | null },
): Promise<TransitionResult> {
  const patch: Partial<RecoveryItemRow> = { status: "in_progress" };
  if (input.owner !== undefined) patch.owner = input.owner;
  return applyCas(orgId, id, ["acknowledged", "waiting_external"], patch);
}

export async function setWaitingExternalRecoveryItem(
  orgId: string,
  id: string,
  input: { owner?: string | null },
): Promise<TransitionResult> {
  const patch: Partial<RecoveryItemRow> = { status: "waiting_external" };
  if (input.owner !== undefined) patch.owner = input.owner;
  return applyCas(orgId, id, ["acknowledged", "in_progress"], patch);
}

export async function escalateRecoveryItem(
  orgId: string,
  id: string,
  input: { severity: RecoveryItemSeverity; slaTargetAtOverrideIso?: string },
): Promise<TransitionResult> {
  // Escalate is allowed from ANY non-resolved state, but only to a higher
  // severity. Status itself doesn't change.
  const before = await getRecoveryItemById(orgId, id);
  if (!before) return null;
  if (before.status === "resolved") return null;
  if (!isSeverityEscalation(before.severity, input.severity)) return null;

  const slaTargetAt = input.slaTargetAtOverrideIso
    ? new Date(input.slaTargetAtOverrideIso)
    : await defaultSlaTargetAtForOrg(orgId, input.severity);

  const result = await db
    .update(recoveryItems)
    .set({
      severity: input.severity,
      slaTargetAt,
      firstActionAt: sql`coalesce(${recoveryItems.firstActionAt}, now())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recoveryItems.orgId, orgId),
        eq(recoveryItems.id, id),
        sql`${recoveryItems.status} <> 'resolved'`,
      ),
    )
    .returning({ id: recoveryItems.id });
  if (result.length === 0) return null;

  const after = await getRecoveryItemById(orgId, id);
  if (!after) return null;
  return { before, after };
}

export async function assignOwnerRecoveryItem(
  orgId: string,
  id: string,
  input: { owner: string | null },
): Promise<TransitionResult> {
  // Owner reassignment is allowed in any non-resolved state.
  const before = await getRecoveryItemById(orgId, id);
  if (!before) return null;
  if (before.status === "resolved") return null;

  const result = await db
    .update(recoveryItems)
    .set({
      owner: input.owner,
      firstActionAt: sql`coalesce(${recoveryItems.firstActionAt}, now())`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recoveryItems.orgId, orgId),
        eq(recoveryItems.id, id),
        sql`${recoveryItems.status} <> 'resolved'`,
      ),
    )
    .returning({ id: recoveryItems.id });
  if (result.length === 0) return null;

  const after = await getRecoveryItemById(orgId, id);
  if (!after) return null;
  return { before, after };
}

export async function resolveRecoveryItem(
  orgId: string,
  id: string,
  input: { actor: string; reason: RecoveryItemResolutionReason },
): Promise<TransitionResult> {
  return applyCas(orgId, id, ["open", "acknowledged", "in_progress", "waiting_external", "reopened"], {
    status: "resolved",
    resolutionReason: input.reason,
    resolvedBy: input.actor,
    resolvedAt: new Date(),
  });
}

export async function reopenRecoveryItem(
  orgId: string,
  id: string,
  _input: { actor: string },
): Promise<TransitionResult> {
  return applyCas(orgId, id, ["resolved"], {
    status: "reopened",
    resolutionReason: null,
    resolvedBy: null,
    resolvedAt: null,
  });
}

// ─── Comments (append-only) ────────────────────────────────────────────────

export type AppendCommentInput = {
  orgId: string;
  id: string;
  authorUserId: string;
  body: string;
};

export type AppendCommentResult =
  | { ok: true; comment: RecoveryItemComment; total: number }
  | { ok: false; reason: "not_found" | "comment_cap_reached" };

/**
 * Read-modify-write append into the jsonb `comments` array. Caps at 200
 * comments per item — operators that hit the cap should resolve the
 * incident and open a new one rather than accumulate ad-infinitum.
 */
export async function appendCommentToRecoveryItem(
  input: AppendCommentInput,
): Promise<AppendCommentResult> {
  const item = await getRecoveryItemById(input.orgId, input.id);
  if (!item) return { ok: false, reason: "not_found" };
  if (item.comments.length >= MAX_COMMENTS_PER_ITEM) {
    return { ok: false, reason: "comment_cap_reached" };
  }
  const comment: RecoveryItemComment = {
    id: crypto.randomUUID(),
    authorUserId: input.authorUserId,
    body: input.body,
    createdAt: new Date().toISOString(),
  };
  const nextComments = [...item.comments, comment];
  await db
    .update(recoveryItems)
    .set({
      comments: nextComments,
      firstActionAt: sql`coalesce(${recoveryItems.firstActionAt}, now())`,
      updatedAt: new Date(),
    })
    .where(and(eq(recoveryItems.orgId, input.orgId), eq(recoveryItems.id, input.id)));
  return { ok: true, comment, total: nextComments.length };
}

// Convenience re-exports for callers building Drizzle filters.
export { eq, and, or, isNull };

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
