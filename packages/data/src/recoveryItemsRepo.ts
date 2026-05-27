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

import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, recoveryItems } from "@janusly/db";
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
  comments: RecoveryItemComment[];
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
    comments: (row.comments as RecoveryItemComment[]) ?? [],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
  const slaTargetAt = defaultSlaTargetAt(severity);
  const id = crypto.randomUUID();
  const now = new Date();
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
      comments: [],
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
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(recoveryItems.orgId, orgId),
        eq(recoveryItems.id, id),
        inArray(recoveryItems.status, allowedPre as unknown as string[]),
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
      : defaultSlaTargetAt(input.severity);
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
    : defaultSlaTargetAt(input.severity);

  const result = await db
    .update(recoveryItems)
    .set({
      severity: input.severity,
      slaTargetAt,
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
    .set({ owner: input.owner, updatedAt: new Date() })
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
    .set({ comments: nextComments, updatedAt: new Date() })
    .where(and(eq(recoveryItems.orgId, input.orgId), eq(recoveryItems.id, input.id)));
  return { ok: true, comment, total: nextComments.length };
}

// Convenience re-exports for callers building Drizzle filters.
export { eq, and, or, isNull };

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
