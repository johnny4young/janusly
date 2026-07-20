/**
 * Recovery circuit-breaker persistence (containment slice).
 *
 * Two operations, both org-scoped:
 * - `countConsecutiveWorkflowFailures` — how many terminal runs at the head of
 *   a workflow's history failed with no success between them. Bounded by the
 *   caller's threshold (`LIMIT`), so it never scans a long history: the answer
 *   "are the last N all failed?" needs at most N rows.
 * - `tripWorkflowCircuitBreaker` — the CAS flip to `paused_circuit_breaker`,
 *   mirroring `pauseWorkflowsForUpstream`'s `WHERE status = 'active'` guard so
 *   two workers racing on the same streak produce exactly one pause (and one
 *   alert), and a workflow already paused for another reason keeps its reason.
 *
 * Resolving a run's workflow: `runs.workflowVersionId` holds EITHER an
 * immutable `workflow_versions.id` (scheduled / triggered runs) OR the
 * workflow id itself (`startRun` falls back to `workflow.id` for runs started
 * from the authoring surface — the UI's Run button). The streak query
 * therefore LEFT JOINs and coalesces, the same shape `runs-routes.ts` uses for
 * its list projection. An inner join would silently never match the authoring
 * path, i.e. the breaker would never fire for the most common way runs start.
 *
 * Cascade posture: orphan-tolerant like the rest of the run substrate (text
 * ids, no FK by design) — a run whose version row was purged still resolves
 * through the coalesce.
 *
 * Used by `packages/engine/src/adapters/dead-letter-queue.ts` right after a
 * terminal failure is persisted.
 */

import { and, desc, eq, isNull, inArray, sql } from "drizzle-orm";

import { db, runs, workflows, workflowVersions } from "@janusly/db";

import { withAuditTx } from "./audit-tx";

/**
 * Audit actor for breaker writes. The trip has no human in the loop; the
 * resume does, and carries the operator's own id instead.
 */
const CIRCUIT_BREAKER_ACTOR = "system:circuit-breaker";

/** `workflows.status` value for a tripped breaker. */
export const WORKFLOW_STATUS_PAUSED_CIRCUIT_BREAKER = "paused_circuit_breaker";

/**
 * Count the failure streak at the head of a workflow's terminal-run history.
 *
 * Only ORDINARY runs count: sandbox/validation replays (`replayMode` set) are
 * rehearsals, and letting them trip a production breaker would mean testing a
 * fix could pause the workflow you're fixing. Non-terminal runs are skipped
 * entirely — an in-flight run is not yet evidence either way.
 *
 * Returns at most `limit`; the caller only needs to know whether the streak
 * reached its threshold.
 */
export async function countConsecutiveWorkflowFailures(
  orgId: string,
  workflowId: string,
  limit: number,
): Promise<number> {
  if (limit <= 0) return 0;
  const rows = await db
    .select({ status: runs.status })
    .from(runs)
    // LEFT JOIN + coalesce: authoring-surface runs carry the workflow id in
    // `workflowVersionId` (no version row to join), scheduled ones carry a
    // real version id. See the module header.
    .leftJoin(workflowVersions, and(
      eq(workflowVersions.id, runs.workflowVersionId),
      eq(workflowVersions.orgId, orgId),
    ))
    .where(and(
      eq(runs.orgId, orgId),
      eq(sql`coalesce(${workflowVersions.workflowId}, ${runs.workflowVersionId})`, workflowId),
      isNull(runs.replayMode),
      inArray(runs.status, ["succeeded", "failed"]),
    ))
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  let streak = 0;
  for (const row of rows) {
    if (row.status !== "failed") break;
    streak += 1;
  }
  return streak;
}

/**
 * Flip an ACTIVE workflow to `paused_circuit_breaker`. Returns true only for
 * the caller that actually won the flip — concurrent workers racing the same
 * streak get false, so the pause audit + alert fire exactly once.
 *
 * The flip and its audit row commit together (`withAuditTx`): the breaker
 * stops a workflow with no human in the loop, so a pause the audit trail
 * can't explain would leave the operator with a stopped workflow and no
 * record of what stopped it.
 */
export async function tripWorkflowCircuitBreaker(args: {
  orgId: string;
  workflowId: string;
  reason: string;
  consecutiveFailures: number;
  threshold: number;
  runId?: string;
}): Promise<boolean> {
  const outcome = await withAuditTx(async (tx, audit) => {
    const flipped = await tx
      .update(workflows)
      .set({ status: WORKFLOW_STATUS_PAUSED_CIRCUIT_BREAKER, pausedReason: args.reason })
      .where(and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.id, args.workflowId),
        eq(workflows.status, "active"),
        isNull(workflows.deletedAt),
      ))
      .returning({ id: workflows.id });
    if (flipped.length === 0) return false;

    await audit({
      orgId: args.orgId,
      userId: CIRCUIT_BREAKER_ACTOR,
      action: "workflow.circuit_breaker.tripped",
      targetType: "workflow",
      targetId: args.workflowId,
      metadata: {
        reason: args.reason,
        consecutiveFailures: args.consecutiveFailures,
        threshold: args.threshold,
        ...(args.runId ? { runId: args.runId } : {}),
      },
    });
    return true;
  });
  // A failed transaction means nothing flipped — the caller must not announce
  // a pause that didn't happen.
  return outcome.ok ? outcome.result : false;
}

/** Read a workflow's current status, or null when it's absent / tombstoned. */
export async function getWorkflowBreakerStatus(orgId: string, workflowId: string): Promise<string | null> {
  const rows = await db
    .select({ status: workflows.status })
    .from(workflows)
    .where(and(eq(workflows.orgId, orgId), eq(workflows.id, workflowId), isNull(workflows.deletedAt)))
    .limit(1);
  return rows[0]?.status ?? null;
}

/**
 * Resume a workflow the breaker paused. Only flips rows whose status is
 * exactly `paused_circuit_breaker` — an upstream-health pause is not cleared
 * by a breaker resume, and vice versa. Returns true when it flipped.
 *
 * Deliberately manual: nothing can automatically know the underlying fault is
 * fixed, so an operator asserts it and the audit row records who.
 */
export async function resumeWorkflowCircuitBreaker(args: {
  orgId: string;
  workflowId: string;
  userId: string;
}): Promise<boolean> {
  const outcome = await withAuditTx(async (tx, audit) => {
    // Read the reason BEFORE clearing it: `RETURNING` yields post-update
    // values, so returning `pausedReason` from the flip below would always
    // record null. Same transaction, so the audit can't quote a reason the
    // resume didn't actually clear.
    const before = await tx
      .select({ pausedReason: workflows.pausedReason })
      .from(workflows)
      .where(and(eq(workflows.orgId, args.orgId), eq(workflows.id, args.workflowId)))
      .limit(1);

    const flipped = await tx
      .update(workflows)
      .set({ status: "active", pausedReason: null })
      .where(and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.id, args.workflowId),
        eq(workflows.status, WORKFLOW_STATUS_PAUSED_CIRCUIT_BREAKER),
        isNull(workflows.deletedAt),
      ))
      .returning({ id: workflows.id });
    if (flipped.length === 0) return false;

    await audit({
      orgId: args.orgId,
      userId: args.userId,
      action: "workflow.circuit_breaker.resumed",
      targetType: "workflow",
      targetId: args.workflowId,
      metadata: { clearedReason: before[0]?.pausedReason ?? null },
    });
    return true;
  });
  return outcome.ok ? outcome.result : false;
}
