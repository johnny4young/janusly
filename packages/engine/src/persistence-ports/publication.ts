/** Durable Postgres-to-queue and child-to-parent publication claims. */

import { db, runNodes, runs } from "@janusly/db";
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { asPlainObject, recoveryClaimPredicate } from "./internal";

/** Mark only executable subworkflow children for durable delivery to their exact parent node. */
export function terminalParentNotificationMarker() {
  return sql<Date | null>`CASE
    WHEN ${runs.parentRunId} IS NOT NULL
      AND ${runs.parentNodeId} IS NOT NULL
      AND (
        ${runs.parentLinkKind} = 'subworkflow'
        OR (
          ${runs.parentLinkKind} IS NULL
          AND ${runs.replayMode} IS NULL
        )
      )
    THEN date_trunc('milliseconds', CURRENT_TIMESTAMP)
    ELSE NULL
  END`;
}


export type DueWaitingCheckpoint = {
  runId: string;
  nodeId: string;
  kind: "approval" | "timer";
  targetAt: string;
};

/** Failed repair deliveries become eligible again after this durable lease. */
export const WAITING_CHECKPOINT_REPAIR_LEASE_MS = 2 * 60 * 1_000;

/**
 * Durably claim a bounded batch of overdue active checkpoints whose Redis
 * wake-up can be safely recreated. The lease and NULLS-FIRST ordering ensure
 * a repeatedly failing batch cannot starve later rows; SKIP LOCKED lets
 * multiple workers sweep without claiming the same checkpoint generation.
 * Exact node-generation CAS remains the execution gate.
 */
export async function claimDueWaitingCheckpoints(
  now = new Date(),
  limit = 500,
  leaseMs = WAITING_CHECKPOINT_REPAIR_LEASE_MS,
): Promise<DueWaitingCheckpoint[]> {
  const nowIso = now.toISOString();
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const boundedLeaseMs = Math.max(1_000, Math.trunc(leaseMs));
  const repairAfter = new Date(now.getTime() + boundedLeaseMs);
  const rows = await db.transaction(async (tx) => {
    const claimed = await tx
      .select({
        id: runNodes.id,
        runId: runNodes.runId,
        nodeId: runNodes.nodeId,
        stateJson: runNodes.stateJson,
      })
      .from(runNodes)
      .innerJoin(runs, eq(runs.id, runNodes.runId))
      .where(and(
        eq(runNodes.status, "waiting"),
        eq(runs.status, "running"),
        or(isNull(runNodes.waitingRepairAfter), lte(runNodes.waitingRepairAfter, now)),
        sql`COALESCE(${runNodes.stateJson} #>> '{waiting,deadlineAt}', ${runNodes.stateJson} #>> '{waiting,wakeAt}') <= ${nowIso}`,
        or(
          and(
            sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'approval'`,
            sql`${runNodes.stateJson} #>> '{waiting,timeoutState}' IS NULL`,
          ),
          and(
            sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'timer'`,
          ),
        ),
      ))
      .orderBy(
        sql`${runNodes.waitingRepairAfter} ASC NULLS FIRST`,
        sql`COALESCE(${runNodes.stateJson} #>> '{waiting,deadlineAt}', ${runNodes.stateJson} #>> '{waiting,wakeAt}')`,
        runNodes.runId,
        runNodes.nodeId,
      )
      .limit(boundedLimit)
      .for("update", { of: runNodes, skipLocked: true });
    if (claimed.length === 0) return claimed;

    await tx
      .update(runNodes)
      .set({ waitingRepairAfter: repairAfter })
      .where(inArray(runNodes.id, claimed.map(row => row.id)));
    return claimed;
  });

  const due: DueWaitingCheckpoint[] = [];
  for (const row of rows) {
    const waiting = asPlainObject(asPlainObject(row.stateJson)?.waiting);
    const kind = waiting?.kind;
    const targetAt = kind === "approval" ? waiting?.deadlineAt : waiting?.wakeAt;
    if ((kind !== "approval" && kind !== "timer") || typeof targetAt !== "string") continue;
    const targetMs = Date.parse(targetAt);
    if (!Number.isFinite(targetMs) || targetMs > now.getTime()) continue;
    due.push({ runId: row.runId, nodeId: row.nodeId, kind, targetAt });
  }
  return due;
}

export type DueQueuePublicationRepair = {
  runId: string;
  nodeId: string;
  status: "pending" | "queued";
  attempt: number;
  recoveryClaimToken: string | null;
  publicationGeneration: number;
};

export type DueParentNotification = {
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  leaseUntil: Date;
};

/** Failed queue-publication deliveries become eligible again after this lease. */
export const QUEUE_PUBLICATION_REPAIR_LEASE_MS = 2 * 60 * 1_000;
/** Failed terminal child→parent deliveries become eligible again after this lease. */
export const PARENT_NOTIFICATION_LEASE_MS = 2 * 60 * 1_000;

/** Claim a bounded, fairly leased batch from the terminal child→parent outbox. */
export async function claimDueParentNotifications(
  now = new Date(),
  limit = 500,
  leaseMs = PARENT_NOTIFICATION_LEASE_MS,
): Promise<DueParentNotification[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const boundedLeaseMs = Math.max(1_000, Math.trunc(leaseMs));
  const repairAfter = new Date(now.getTime() + boundedLeaseMs);
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(and(
        isNotNull(runs.parentRunId),
        isNotNull(runs.parentNodeId),
        or(
          eq(runs.parentLinkKind, "subworkflow"),
          and(isNull(runs.parentLinkKind), isNull(runs.replayMode)),
        ),
        inArray(runs.status, ["succeeded", "failed", "cancelled"]),
        lte(runs.parentNotificationAfter, now),
      ))
      .orderBy(runs.parentNotificationAfter, runs.id)
      .limit(boundedLimit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return rows;
    await tx
      .update(runs)
      .set({ parentNotificationAfter: repairAfter })
      .where(inArray(runs.id, rows.map(row => row.id)));
    return rows;
  });

  return claimed.flatMap(row => (
    row.status === "succeeded" || row.status === "failed" || row.status === "cancelled"
      ? [{ runId: row.id, status: row.status, leaseUntil: repairAfter }]
      : []
  ));
}

/** Acknowledge one exact terminal child generation after its parent handoff settles. */
export async function markParentNotificationSucceeded(
  runId: string,
  status: DueParentNotification["status"],
  expectedMarker: Date,
): Promise<boolean> {
  const cleared = await db
    .update(runs)
    .set({ parentNotificationAfter: null })
    .where(and(
      eq(runs.id, runId),
      eq(runs.status, status),
      eq(runs.parentNotificationAfter, expectedMarker),
    ))
    .returning({ id: runs.id });
  return cleared.length > 0;
}

/**
 * Claim a bounded batch from the Postgres→BullMQ outbox. The marker is set
 * before any Queue.add and cleared only after Redis accepts the deterministic
 * job id. SKIP LOCKED plus a durable lease makes multi-worker sweeps safe and
 * prevents a poisoned first batch from starving later generations.
 */
export async function claimDueQueuePublicationRepairs(
  now = new Date(),
  limit = 500,
  leaseMs = QUEUE_PUBLICATION_REPAIR_LEASE_MS,
): Promise<DueQueuePublicationRepair[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const boundedLeaseMs = Math.max(1_000, Math.trunc(leaseMs));
  const repairAfter = new Date(now.getTime() + boundedLeaseMs);
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: runNodes.id,
        runId: runNodes.runId,
        nodeId: runNodes.nodeId,
        status: runNodes.status,
        attempts: runNodes.attempts,
        recoveryClaimToken: runNodes.recoveryClaimToken,
        publicationGeneration: runNodes.queuePublicationGeneration,
      })
      .from(runNodes)
      .innerJoin(runs, eq(runs.id, runNodes.runId))
      .where(and(
        eq(runs.status, "running"),
        inArray(runNodes.status, ["pending", "queued"]),
        lte(runNodes.queuePublicationRepairAfter, now),
      ))
      .orderBy(runNodes.queuePublicationRepairAfter, runNodes.runId, runNodes.nodeId)
      .limit(boundedLimit)
      .for("update", { of: runNodes, skipLocked: true });
    if (rows.length === 0) return rows;
    await tx
      .update(runNodes)
      .set({ queuePublicationRepairAfter: repairAfter })
      .where(inArray(runNodes.id, rows.map(row => row.id)));
    return rows;
  });

  return claimed.flatMap(row => {
    if (row.status !== "pending" && row.status !== "queued") return [];
    return [{
      runId: row.runId,
      nodeId: row.nodeId,
      status: row.status,
      attempt: typeof row.attempts === "number" && row.attempts > 0 ? row.attempts : 1,
      recoveryClaimToken: row.recoveryClaimToken,
      publicationGeneration: row.publicationGeneration,
    }];
  });
}

/**
 * Atomic claim — flip `pending → queued` only when the row is still
 * `pending`, persist the publication marker, and return the exact attempt /
 * replay token that Redis must receive. Returns `null` when another worker
 * already claimed. This invariant must not be replaced with a non-atomic
 * read-then-write.
 *
 * Invariant (AGENTS.md "Concurrency"): this conditional UPDATE is the
 * only multi-worker double-claim guard; racing workers get claim/null
 * from the same atomic write. No read-then-write refactors.
 */
export type QueuePublicationClaim = {
  attempt: number;
  recoveryClaimToken: string | null;
  publicationGeneration: number;
};

export async function tryClaimNodeForQueue(
  runId: string,
  nodeId: string,
  attempt = 1,
): Promise<QueuePublicationClaim | null> {
  const claimedAt = new Date();
  const claimed = await db.update(runNodes)
    .set({
      status: "queued",
      attempts: sql`CASE
        WHEN ${runNodes.queuePublicationRepairAfter} IS NOT NULL
          AND coalesce(${runNodes.attempts}, 0) > 0
        THEN ${runNodes.attempts}
        ELSE ${attempt}
      END`,
      queuePublicationRepairAfter: claimedAt,
      queuePublicationGeneration: sql`${runNodes.queuePublicationGeneration} + 1`,
    })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "pending"),
    ))
    .returning({
      attempt: runNodes.attempts,
      recoveryClaimToken: runNodes.recoveryClaimToken,
      publicationGeneration: runNodes.queuePublicationGeneration,
    });
  if (!claimed[0]) return null;
  return {
    attempt: claimed[0].attempt ?? attempt,
    recoveryClaimToken: claimed[0].recoveryClaimToken,
    publicationGeneration: claimed[0].publicationGeneration,
  };
}

/** Confirm that Redis accepted one exact queued generation. */
export async function markQueuePublicationSucceeded(
  runId: string,
  nodeId: string,
  attempt: number,
  publicationGeneration: number,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const published = await db
    .update(runNodes)
    .set({ queuePublicationRepairAfter: null })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "queued"),
      sql`coalesce(${runNodes.attempts}, 1) = ${attempt}`,
      eq(runNodes.queuePublicationGeneration, publicationGeneration),
      recoveryClaimPredicate(recoveryClaimToken),
    ))
    .returning({ id: runNodes.id });
  return published.length > 0;
}
