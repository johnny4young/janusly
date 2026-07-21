/**
 * Durable persistence for named, paced DLQ replay campaigns.
 *
 * Used by:
 * - `apps/api/src/routes/replay-campaigns-routes.ts` for create/list/detail/cancel.
 * - `packages/engine/src/replay-campaign.ts` for leased worker dispatch.
 *
 * Invariants:
 * - Every public read/write is organization-scoped.
 * - Parent counters and item terminal transitions commit together.
 * - Dispatch and item claims are leases; stale work is reclaimable.
 * - No foreign keys: campaign evidence is orphan-tolerant like DLQ history.
 */

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lte,
  sql,
} from "drizzle-orm";

import { db, deadLetters, replayCampaignItems, replayCampaigns } from "@janusly/db";
import { safePersistPayload } from "@janusly/shared/src/safe-persist";

export const REPLAY_CAMPAIGN_STATUSES = ["running", "completed", "cancelled"] as const;
export type ReplayCampaignStatus = (typeof REPLAY_CAMPAIGN_STATUSES)[number];

export const REPLAY_CAMPAIGN_ITEM_STATUSES = ["pending", "processing", "replayed", "failed", "cancelled"] as const;
export type ReplayCampaignItemStatus = (typeof REPLAY_CAMPAIGN_ITEM_STATUSES)[number];

export const REPLAY_CAMPAIGN_MAX_ITEMS = 100;
export const REPLAY_CAMPAIGN_NAME_MAX_CHARS = 120;
export const REPLAY_CAMPAIGN_MIN_PACING_MS = 1_000;
export const REPLAY_CAMPAIGN_MAX_PACING_MS = 60_000;
export const REPLAY_CAMPAIGN_ITEM_LEASE_MS = 5 * 60 * 1000;
export const REPLAY_CAMPAIGN_DISPATCH_LEASE_MS = 5 * 60 * 1000;

export type ReplayCampaign = Omit<typeof replayCampaigns.$inferSelect, "status"> & {
  status: ReplayCampaignStatus;
};

export type ReplayCampaignItem = Omit<typeof replayCampaignItems.$inferSelect, "status"> & {
  status: ReplayCampaignItemStatus;
};

export type ReplayCampaignDetail = {
  campaign: ReplayCampaign;
  items: ReplayCampaignItem[];
};

function campaignStatus(value: string): ReplayCampaignStatus {
  return REPLAY_CAMPAIGN_STATUSES.includes(value as ReplayCampaignStatus)
    ? value as ReplayCampaignStatus
    : "cancelled";
}

function itemStatus(value: string): ReplayCampaignItemStatus {
  return REPLAY_CAMPAIGN_ITEM_STATUSES.includes(value as ReplayCampaignItemStatus)
    ? value as ReplayCampaignItemStatus
    : "failed";
}

function toCampaign(row: typeof replayCampaigns.$inferSelect): ReplayCampaign {
  return { ...row, status: campaignStatus(row.status) };
}

function toItem(row: typeof replayCampaignItems.$inferSelect): ReplayCampaignItem {
  return { ...row, status: itemStatus(row.status) };
}

/** Create a running campaign and its immutable ordered cohort atomically. */
export async function createReplayCampaign(input: {
  orgId: string;
  name: string;
  clusterSignature: string;
  deadLetterIds: string[];
  pacingMs: number;
  createdBy: string;
  filterJson?: unknown;
}): Promise<ReplayCampaignDetail> {
  const id = crypto.randomUUID();
  const now = new Date();
  const name = input.name.trim();
  const clusterSignature = input.clusterSignature.trim();
  const uniqueIds = [...new Set(input.deadLetterIds.map(deadLetterId => deadLetterId.trim()))];
  if (
    uniqueIds.length < 2
    || uniqueIds.length > REPLAY_CAMPAIGN_MAX_ITEMS
    || uniqueIds.some(deadLetterId => deadLetterId.length === 0)
  ) {
    throw new Error("replay_campaign_invalid_item_count");
  }
  if (name.length === 0 || name.length > REPLAY_CAMPAIGN_NAME_MAX_CHARS) {
    throw new Error("replay_campaign_invalid_name");
  }
  if (clusterSignature.length === 0) {
    throw new Error("replay_campaign_invalid_cluster_signature");
  }
  if (
    !Number.isInteger(input.pacingMs)
    || input.pacingMs < REPLAY_CAMPAIGN_MIN_PACING_MS
    || input.pacingMs > REPLAY_CAMPAIGN_MAX_PACING_MS
  ) {
    throw new Error("replay_campaign_invalid_pacing");
  }

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(replayCampaigns).values({
      id,
      orgId: input.orgId,
      name,
      clusterSignature,
      filterJson: safePersistPayload(input.filterJson ?? {}, { maxBytes: 64_000 }),
      pacingMs: input.pacingMs,
      totalCount: uniqueIds.length,
      createdBy: input.createdBy,
      nextDispatchAt: now,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    }).returning();

    const itemRows = await tx.insert(replayCampaignItems).values(uniqueIds.map((deadLetterId, position) => ({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      campaignId: id,
      deadLetterId,
      position,
      createdAt: now,
    }))).returning();

    return {
      campaign: toCampaign(row!),
      items: itemRows.map(toItem),
    };
  });
}

/** Return one campaign plus its bounded ordered item ledger. */
export async function getReplayCampaign(orgId: string, id: string): Promise<ReplayCampaignDetail | null> {
  const [campaignRows, itemRows] = await Promise.all([
    db.select().from(replayCampaigns).where(and(
      eq(replayCampaigns.orgId, orgId),
      eq(replayCampaigns.id, id),
    )).limit(1),
    db.select().from(replayCampaignItems).where(and(
      eq(replayCampaignItems.orgId, orgId),
      eq(replayCampaignItems.campaignId, id),
    )).orderBy(asc(replayCampaignItems.position)).limit(REPLAY_CAMPAIGN_MAX_ITEMS),
  ]);
  if (!campaignRows[0]) return null;
  return {
    campaign: toCampaign(campaignRows[0]),
    items: itemRows.map(toItem),
  };
}

/** List newest campaigns for one organization, always bounded. */
export async function listReplayCampaigns(orgId: string, limit = 20): Promise<ReplayCampaign[]> {
  const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
  const rows = await db.select().from(replayCampaigns)
    .where(eq(replayCampaigns.orgId, orgId))
    .orderBy(desc(replayCampaigns.createdAt), desc(replayCampaigns.id))
    .limit(bounded);
  return rows.map(toCampaign);
}

/** Cancel a running campaign and retire every item that has not started. */
export async function cancelReplayCampaign(
  orgId: string,
  id: string,
  cancelledBy: string,
): Promise<ReplayCampaignDetail | null> {
  const cancelled = await db.transaction(async (tx) => {
    const now = new Date();
    const campaignRows = await tx.update(replayCampaigns).set({
      status: "cancelled",
      cancelledBy,
      cancelledAt: now,
      updatedAt: now,
    }).where(and(
      eq(replayCampaigns.orgId, orgId),
      eq(replayCampaigns.id, id),
      eq(replayCampaigns.status, "running"),
    )).returning({ id: replayCampaigns.id });
    if (!campaignRows[0]) return false;

    const retired = await tx.update(replayCampaignItems).set({
      status: "cancelled",
      completedAt: now,
    }).where(and(
      eq(replayCampaignItems.orgId, orgId),
      eq(replayCampaignItems.campaignId, id),
      eq(replayCampaignItems.status, "pending"),
    )).returning({ id: replayCampaignItems.id });

    if (retired.length > 0) {
      await tx.update(replayCampaigns).set({
        cancelledCount: sql`${replayCampaigns.cancelledCount} + ${retired.length}`,
        updatedAt: now,
      }).where(and(
        eq(replayCampaigns.orgId, orgId),
        eq(replayCampaigns.id, id),
      ));
    }
    return true;
  });
  return cancelled ? getReplayCampaign(orgId, id) : null;
}

/** Atomically reserve one due campaign dispatch. Duplicate BullMQ jobs lose this CAS. */
export async function claimReplayCampaignDispatch(id: string, now = new Date()): Promise<ReplayCampaign | null> {
  const leaseUntil = new Date(now.getTime() + REPLAY_CAMPAIGN_DISPATCH_LEASE_MS);
  const rows = await db.update(replayCampaigns).set({
    nextDispatchAt: leaseUntil,
    updatedAt: now,
  }).where(and(
    eq(replayCampaigns.id, id),
    eq(replayCampaigns.status, "running"),
    lte(replayCampaigns.nextDispatchAt, now),
  )).returning();
  return rows[0] ? toCampaign(rows[0]) : null;
}

export type ClaimedReplayCampaignItem = ReplayCampaignItem & { claimToken: string };

/** Lease the next item oldest-first; stale processing leases are reclaimable. */
export async function claimNextReplayCampaignItem(
  orgId: string,
  campaignId: string,
  now = new Date(),
): Promise<ClaimedReplayCampaignItem | null> {
  const claimToken = crypto.randomUUID();
  const staleBefore = new Date(now.getTime() - REPLAY_CAMPAIGN_ITEM_LEASE_MS);
  const rows = await db.execute<{
    id: string;
    orgId: string;
    campaignId: string;
    deadLetterId: string;
    position: number;
    status: string;
    attemptCount: number;
    claimToken: string;
    claimedAt: Date;
    error: string | null;
    completedAt: Date | null;
    createdAt: Date;
  }>(sql`
    WITH candidate AS (
      SELECT item.id
      FROM ${replayCampaignItems} AS item
      INNER JOIN ${replayCampaigns} AS campaign
        ON campaign.id = item.campaign_id
       AND campaign.org_id = item.org_id
      WHERE item.org_id = ${orgId}
        AND item.campaign_id = ${campaignId}
        AND campaign.status = 'running'
        AND (
          item.status = 'pending'
          OR (item.status = 'processing' AND item.claimed_at < ${sql.param(staleBefore, replayCampaignItems.claimedAt)})
        )
      ORDER BY item.position ASC
      FOR UPDATE OF item SKIP LOCKED
      LIMIT 1
    )
    UPDATE ${replayCampaignItems} AS item
    SET
      status = 'processing',
      claim_token = ${claimToken},
      claimed_at = ${sql.param(now, replayCampaignItems.claimedAt)},
      attempt_count = item.attempt_count + 1,
      error = NULL
    FROM candidate
    WHERE item.id = candidate.id
    RETURNING
      item.id AS "id",
      item.org_id AS "orgId",
      item.campaign_id AS "campaignId",
      item.dead_letter_id AS "deadLetterId",
      item.position AS "position",
      item.status AS "status",
      item.attempt_count AS "attemptCount",
      item.claim_token AS "claimToken",
      item.claimed_at AS "claimedAt",
      item.error AS "error",
      item.completed_at AS "completedAt",
      item.created_at AS "createdAt"
  `);
  return rows[0] ? { ...toItem(rows[0]), claimToken } : null;
}

/**
 * Settle one leased item and advance the parent clock/counters atomically.
 * Returns the current campaign, or null when the lease was lost.
 */
export async function completeReplayCampaignItem(input: {
  orgId: string;
  campaignId: string;
  itemId: string;
  claimToken: string;
  outcome: "replayed" | "failed";
  error?: string | null;
  now?: Date;
}): Promise<ReplayCampaign | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const settled = await tx.update(replayCampaignItems).set({
      status: input.outcome,
      error: input.error?.slice(0, 2_000) ?? null,
      completedAt: now,
      claimToken: null,
      claimedAt: null,
    }).where(and(
      eq(replayCampaignItems.orgId, input.orgId),
      eq(replayCampaignItems.campaignId, input.campaignId),
      eq(replayCampaignItems.id, input.itemId),
      eq(replayCampaignItems.status, "processing"),
      eq(replayCampaignItems.claimToken, input.claimToken),
    )).returning({ id: replayCampaignItems.id });
    if (!settled[0]) return null;

    const [parent] = await tx.select().from(replayCampaigns).where(and(
      eq(replayCampaigns.orgId, input.orgId),
      eq(replayCampaigns.id, input.campaignId),
    )).limit(1);
    if (!parent) return null;

    const remainingRows = await tx.select({ count: sql<number>`count(*)::int` })
      .from(replayCampaignItems)
      .where(and(
        eq(replayCampaignItems.orgId, input.orgId),
        eq(replayCampaignItems.campaignId, input.campaignId),
        inArray(replayCampaignItems.status, ["pending", "processing"]),
      ));
    const remaining = remainingRows[0]?.count ?? 0;
    const stillRunning = parent.status === "running";
    const completes = stillRunning && remaining === 0;
    const nextDispatchAt = new Date(now.getTime() + parent.pacingMs);
    const rows = await tx.update(replayCampaigns).set({
      ...(input.outcome === "replayed"
        ? { replayedCount: sql`${replayCampaigns.replayedCount} + 1` }
        : { failedCount: sql`${replayCampaigns.failedCount} + 1` }),
      ...(completes ? { status: "completed", completedAt: now } : {}),
      ...(stillRunning && !completes ? { nextDispatchAt } : {}),
      updatedAt: now,
    }).where(and(
      eq(replayCampaigns.orgId, input.orgId),
      eq(replayCampaigns.id, input.campaignId),
    )).returning();
    return rows[0] ? toCampaign(rows[0]) : null;
  });
}

/** Complete an empty/exhausted running campaign without changing counters. */
export async function completeReplayCampaignIfExhausted(
  orgId: string,
  id: string,
  now = new Date(),
): Promise<ReplayCampaign | null> {
  const remaining = db.select({ id: replayCampaignItems.id }).from(replayCampaignItems).where(and(
    eq(replayCampaignItems.orgId, orgId),
    eq(replayCampaignItems.campaignId, id),
    inArray(replayCampaignItems.status, ["pending", "processing"]),
  ));
  const rows = await db.update(replayCampaigns).set({
    status: "completed",
    completedAt: now,
    updatedAt: now,
  }).where(and(
    eq(replayCampaigns.orgId, orgId),
    eq(replayCampaigns.id, id),
    eq(replayCampaigns.status, "running"),
    sql`NOT EXISTS (${remaining})`,
  )).returning();
  return rows[0] ? toCampaign(rows[0]) : null;
}

/** Make a failed dispatch repairable after a short bounded delay. */
export async function deferReplayCampaignDispatch(id: string, delayMs = 10_000): Promise<void> {
  const now = new Date();
  await db.update(replayCampaigns).set({
    nextDispatchAt: new Date(now.getTime() + Math.max(1_000, delayMs)),
    updatedAt: now,
  }).where(and(eq(replayCampaigns.id, id), eq(replayCampaigns.status, "running")));
}

/** Cross-tenant system scan for due dispatches; returned rows carry org scope. */
export async function listDueReplayCampaigns(now = new Date(), limit = 100): Promise<Array<{
  id: string;
  orgId: string;
  nextDispatchAt: Date;
}>> {
  const bounded = Math.min(500, Math.max(1, Math.trunc(limit)));
  return db.select({
    id: replayCampaigns.id,
    orgId: replayCampaigns.orgId,
    nextDispatchAt: replayCampaigns.nextDispatchAt,
  }).from(replayCampaigns).where(and(
    eq(replayCampaigns.status, "running"),
    lte(replayCampaigns.nextDispatchAt, now),
  )).orderBy(asc(replayCampaigns.nextDispatchAt), asc(replayCampaigns.id)).limit(bounded);
}

/** Load the exact full DLQ snapshot a campaign item is allowed to replay. */
export async function getReplayCampaignDeadLetter(orgId: string, id: string) {
  const rows = await db.select().from(deadLetters).where(and(
    eq(deadLetters.orgId, orgId),
    eq(deadLetters.id, id),
  )).limit(1);
  return rows[0] ?? null;
}

/** Load a bounded set of full DLQ snapshots in one tenant-scoped query. */
export async function listReplayCampaignDeadLetters(orgId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)].slice(0, REPLAY_CAMPAIGN_MAX_ITEMS);
  if (uniqueIds.length === 0) return [];
  return db.select().from(deadLetters).where(and(
    eq(deadLetters.orgId, orgId),
    inArray(deadLetters.id, uniqueIds),
  ));
}

/** Mark a generation-claimed campaign row replayed without touching another tenant. */
export async function markReplayCampaignDeadLetterReplayed(orgId: string, id: string): Promise<boolean> {
  const rows = await db.update(deadLetters).set({
    status: "replayed",
    replayedAt: new Date(),
  }).where(and(
    eq(deadLetters.orgId, orgId),
    eq(deadLetters.id, id),
    eq(deadLetters.status, "open"),
  )).returning({ id: deadLetters.id });
  return rows.length === 1;
}
