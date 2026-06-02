/**
 * Repository for the `alert_dispatches` table — operational log of every
 * actual alert delivery attempt. Backs two read paths:
 *
 *  - **Cooldown lookup**: `getLastDispatchAt(orgId, policyId, dedupeKey)`
 *    returns the most recent dispatch for the triple so the dispatcher
 *    can compare against `cooldownSeconds`.
 *  - **`GET /alerts/recent` feed**: `listRecentDispatches` returns paginated
 *    rows ordered by `dispatchedAt DESC`, joined with the policy name
 *    (when the policy still exists).
 *
 * Suppression rows DO NOT live here — cooldown skips only fire an
 * `alert.policy.suppressed` audit row, keeping this table compact.
 *
 * Multi-tenant scope: every read filters by `orgId`. The `system` orgId is
 * honoured for `limiter.degraded` policies (operator-side alerts).
 */

import { and, desc, eq, lt } from "drizzle-orm";
import { alertDispatches, alertPolicies, db } from "@janusly/db";
import type { AlertChannelResult, AlertOutcome, AlertTrigger } from "@janusly/shared";

export type AlertDispatchRow = typeof alertDispatches.$inferSelect;

export type AlertDispatch = {
  id: string;
  orgId: string;
  policyId: string;
  dedupeKey: string;
  dispatchedAt: Date;
  outcome: AlertOutcome;
  channelResults: AlertChannelResult[];
  triggerPayload: Record<string, unknown>;
};

export type AlertDispatchWithPolicy = AlertDispatch & {
  policyName: string | null;
  trigger: AlertTrigger | null;
};

function hydrate(row: AlertDispatchRow): AlertDispatch {
  return {
    id: row.id,
    orgId: row.orgId,
    policyId: row.policyId,
    dedupeKey: row.dedupeKey,
    dispatchedAt: row.dispatchedAt,
    outcome: row.outcome as AlertOutcome,
    channelResults: (row.channelResults as AlertChannelResult[]) ?? [],
    triggerPayload: (row.triggerPayload as Record<string, unknown>) ?? {},
  };
}

/**
 * Returns the most-recent dispatch timestamp for the cooldown triple, or
 * `null` when no prior delivery exists. Used by the dispatcher BEFORE it
 * fans out across channels.
 */
export async function getLastDispatchAt(
  orgId: string,
  policyId: string,
  dedupeKey: string,
): Promise<Date | null> {
  const rows = await db
    .select({ dispatchedAt: alertDispatches.dispatchedAt })
    .from(alertDispatches)
    .where(
      and(
        eq(alertDispatches.orgId, orgId),
        eq(alertDispatches.policyId, policyId),
        eq(alertDispatches.dedupeKey, dedupeKey),
      ),
    )
    .orderBy(desc(alertDispatches.dispatchedAt))
    .limit(1);
  return rows[0]?.dispatchedAt ?? null;
}

export type RecordDispatchInput = {
  orgId: string;
  policyId: string;
  dedupeKey: string;
  outcome: AlertOutcome;
  channelResults: AlertChannelResult[];
  triggerPayload: Record<string, unknown>;
};

/** Insert a dispatch row. Never throws on caller responsibility — the
 * outer dispatcher wraps this in its own try/catch so a DB blip doesn't
 * break the alert response path (the alert was already delivered by the
 * time we record it). */
export async function recordDispatch(input: RecordDispatchInput): Promise<AlertDispatch> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(alertDispatches).values({
    id,
    orgId: input.orgId,
    policyId: input.policyId,
    dedupeKey: input.dedupeKey,
    dispatchedAt: now,
    outcome: input.outcome,
    channelResults: input.channelResults,
    triggerPayload: input.triggerPayload,
  });
  return {
    id,
    orgId: input.orgId,
    policyId: input.policyId,
    dedupeKey: input.dedupeKey,
    dispatchedAt: now,
    outcome: input.outcome,
    channelResults: input.channelResults,
    triggerPayload: input.triggerPayload,
  };
}

export type ListRecentDispatchesInput = {
  orgId: string;
  limit?: number;
  cursorIso?: string;
};

export const RECENT_DISPATCHES_DEFAULT_LIMIT = 50;
export const RECENT_DISPATCHES_MAX_LIMIT = 200;

/**
 * Cursor-paginated recent-feed read joined with `alert_policies` so the
 * row carries the policy name + trigger label. Newest first. The cursor
 * is the previous page's last `dispatchedAt` ISO string.
 */
export async function listRecentDispatches(
  input: ListRecentDispatchesInput,
): Promise<{
  items: AlertDispatchWithPolicy[];
  cursor: string | null;
  hasMore: boolean;
}> {
  const limitRaw = input.limit ?? RECENT_DISPATCHES_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.floor(limitRaw)), RECENT_DISPATCHES_MAX_LIMIT);
  const parsedCursorTs = input.cursorIso ? new Date(input.cursorIso) : null;
  const cursorTs = parsedCursorTs && !Number.isNaN(parsedCursorTs.getTime())
    ? parsedCursorTs
    : null;
  const cursorPredicate = cursorTs ? lt(alertDispatches.dispatchedAt, cursorTs) : undefined;

  const rows = await db
    .select({
      id: alertDispatches.id,
      orgId: alertDispatches.orgId,
      policyId: alertDispatches.policyId,
      dedupeKey: alertDispatches.dedupeKey,
      dispatchedAt: alertDispatches.dispatchedAt,
      outcome: alertDispatches.outcome,
      channelResults: alertDispatches.channelResults,
      triggerPayload: alertDispatches.triggerPayload,
      policyName: alertPolicies.name,
      trigger: alertPolicies.trigger,
    })
    .from(alertDispatches)
    .leftJoin(alertPolicies, eq(alertDispatches.policyId, alertPolicies.id))
    .where(
      cursorPredicate
        ? and(eq(alertDispatches.orgId, input.orgId), cursorPredicate)
        : eq(alertDispatches.orgId, input.orgId),
    )
    .orderBy(desc(alertDispatches.dispatchedAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;

  const items: AlertDispatchWithPolicy[] = trimmed.map((row) => ({
    ...hydrate({
      id: row.id,
      orgId: row.orgId,
      policyId: row.policyId,
      dedupeKey: row.dedupeKey,
      dispatchedAt: row.dispatchedAt,
      outcome: row.outcome,
      channelResults: row.channelResults,
      triggerPayload: row.triggerPayload,
    } as AlertDispatchRow),
    policyName: row.policyName,
    trigger: row.trigger as AlertTrigger | null,
  }));

  const cursor = hasMore && items[items.length - 1]
    ? items[items.length - 1].dispatchedAt.toISOString()
    : null;

  return { items, cursor, hasMore };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
