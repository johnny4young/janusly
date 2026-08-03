/** Atomic terminal-recovery impact persistence. */

import { db } from "@janusly/db";
import {
  auditLogs,
  deadLetters,
  recoveryImpactEvents,
  recoveryImpactRollups,
  recoveryItemChildren,
  recoveryItems,
  runs,
} from "@janusly/db";
import { and, eq, or, sql } from "drizzle-orm";
import { buildRecoveryNorthStarSample } from "@janusly/shared";
import { safePersistPayload } from "@janusly/shared/src/safe-persist";
import { recordRecoveryPlaybookAppliedTx } from "../recoveryPlaybooksRepo";
import type { RecoveryImpactCompletion } from "./contracts";

/**
 * Transaction handle accepted by the node-success persistence path. Keeping
 * impact-event insertion and rollup increment inside the SAME transaction as
 * `run_nodes.status = 'succeeded'` prevents crash gaps and false wins.
 */
type RecoveryImpactTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Record one terminally successful DLQ recovery and increment its tenant's
 * lifetime projection. `dead_letter_id` is unique, so duplicate worker
 * completion attempts are idempotent and never inflate value.
 */
export async function recordRecoveryImpactTx(
  tx: RecoveryImpactTx,
  input: RecoveryImpactCompletion,
): Promise<boolean> {
  if (!input.deadLetterId) return false;

  const [dlq] = await tx
    .select({
      orgId: deadLetters.orgId,
      createdAt: deadLetters.createdAt,
      replayClaimedAt: deadLetters.replayClaimedAt,
      replayedAt: deadLetters.replayedAt,
      replayMode: runs.replayMode,
    })
    .from(deadLetters)
    .innerJoin(
      runs,
      and(
        eq(runs.id, deadLetters.runId),
        eq(runs.orgId, deadLetters.orgId),
      ),
    )
    .where(and(
      eq(deadLetters.id, input.deadLetterId),
      eq(deadLetters.runId, input.runId),
      eq(deadLetters.nodeId, input.nodeId),
    ))
    .limit(1);
  if (!dlq) return false;
  if (!dlq.createdAt) return false;

  const productionNorthStar = buildRecoveryNorthStarSample({
    caseId: input.deadLetterId,
    source: "technical_failure",
    verificationKind: "generation_bound_terminal_success",
    runKind: dlq.replayMode === null ? "production" : "validation",
    outcome: "verified_recovered",
    detectedAt: dlq.createdAt,
    verifiedRecoveredAt: input.recoveredAt,
  });
  const detectedAtMs = dlq.createdAt.getTime();
  const recoveredAtMs = input.recoveredAt.getTime();
  if (
    !Number.isFinite(detectedAtMs)
    || !Number.isFinite(recoveredAtMs)
    || recoveredAtMs < detectedAtMs
  ) {
    return false;
  }

  // The API normally stamps queue acceptance immediately after BullMQ
  // enqueue, but a process crash can land between those two operations. A
  // generation-matched terminal success is stronger evidence than enqueue
  // acceptance, so converge a still-open row here in the same transaction as
  // the impact fact. Preserve `resolved`: an explicit accepted-loss dismissal
  // must not be rewritten by a late in-flight worker.
  await tx
    .update(deadLetters)
    .set({ status: "replayed", replayedAt: input.recoveredAt })
    .where(and(
      eq(deadLetters.id, input.deadLetterId),
      eq(deadLetters.orgId, dlq.orgId),
      eq(deadLetters.runId, input.runId),
      eq(deadLetters.nodeId, input.nodeId),
      eq(deadLetters.status, "open"),
    ));

  // Controlled drills retain the same immutable terminal fact for their
  // measured validation dossier, but never enter the production north-star
  // rollup. Ordinary sandbox runs do not carry a recoveryDeadLetterId, so
  // they cannot reach this branch.
  const downtimeEndedMs = productionNorthStar.included
    ? productionNorthStar.sample.durationMs
    : Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.round(recoveredAtMs - detectedAtMs),
      );
  const inserted = await tx
    .insert(recoveryImpactEvents)
    .values({
      deadLetterId: input.deadLetterId,
      orgId: dlq.orgId,
      runId: input.runId,
      nodeId: input.nodeId,
      userId: input.userId,
      recoveredAt: input.recoveredAt,
      downtimeEndedMs,
    })
    .onConflictDoNothing({ target: recoveryImpactEvents.deadLetterId })
    .returning({ deadLetterId: recoveryImpactEvents.deadLetterId });
  if (inserted.length === 0) return false;

  if (productionNorthStar.included) {
    await tx
      .insert(recoveryImpactRollups)
      .values({
        orgId: dlq.orgId,
        totalRecovered: 1,
        downtimeEndedMs,
        firstRecoveredAt: input.recoveredAt,
        updatedAt: input.recoveredAt,
      })
      .onConflictDoUpdate({
        target: recoveryImpactRollups.orgId,
        set: {
          totalRecovered: sql`${recoveryImpactRollups.totalRecovered} + 1`,
          downtimeEndedMs: sql`${recoveryImpactRollups.downtimeEndedMs} + ${downtimeEndedMs}`,
          firstRecoveredAt: sql`least(
            coalesce(${recoveryImpactRollups.firstRecoveredAt}, excluded."first_recovered_at"),
            excluded."first_recovered_at"
          )`,
          updatedAt: sql`greatest(
            ${recoveryImpactRollups.updatedAt},
            excluded."updated_at"
          )`,
        },
      });
  }

  // The incident closes only alongside terminal node success. Keeping this
  // CAS transition and its audit row in the same transaction as the impact
  // fact prevents enqueue acceptance from masquerading as recovery and
  // eliminates a crash gap between the Value Dashboard and ownership views.
  const [linkedChild] = await tx
    .select({ recoveryItemId: recoveryItemChildren.recoveryItemId })
    .from(recoveryItemChildren)
    .where(and(
      eq(recoveryItemChildren.orgId, dlq.orgId),
      eq(recoveryItemChildren.deadLetterId, input.deadLetterId),
    ))
    .limit(1);
  const itemIdentity = linkedChild
    ? or(
        eq(recoveryItems.deadLetterId, input.deadLetterId),
        eq(recoveryItems.id, linkedChild.recoveryItemId),
      )
    : eq(recoveryItems.deadLetterId, input.deadLetterId);
  const [item] = await tx
    .select({
      id: recoveryItems.id,
      status: recoveryItems.status,
      resolutionReason: recoveryItems.resolutionReason,
    })
    .from(recoveryItems)
    .where(and(
      eq(recoveryItems.orgId, dlq.orgId),
      itemIdentity,
    ))
    .limit(1)
    .for("update");
  if (item && item.status !== "resolved") {
    const actor = input.userId ?? "system";
    const firstActionAt = dlq.replayClaimedAt ?? dlq.replayedAt ?? input.recoveredAt;
    const [resolved] = await tx
      .update(recoveryItems)
      .set({
        status: "resolved",
        resolutionReason: "sandbox_replay_succeeded",
        resolvedBy: actor,
        resolvedAt: input.recoveredAt,
        // Raw sql interpolations do not inherit Drizzle's timestamp encoder;
        // pass an ISO string and cast explicitly instead of binding a JS Date.
        firstActionAt: sql`coalesce(
          ${recoveryItems.firstActionAt},
          ${firstActionAt.toISOString()}::timestamptz
        )`,
        updatedAt: input.recoveredAt,
      })
      .where(and(
        eq(recoveryItems.orgId, dlq.orgId),
        eq(recoveryItems.id, item.id),
        eq(recoveryItems.status, item.status),
      ))
      .returning({ id: recoveryItems.id });
    if (resolved) {
      await tx.insert(auditLogs).values({
        id: crypto.randomUUID(),
        orgId: dlq.orgId,
        userId: actor,
        action: "recovery.item.resolved",
        targetType: "recovery-item",
        targetId: item.id,
        metadata: safePersistPayload({
          before: { status: item.status, resolutionReason: item.resolutionReason },
          after: { status: "resolved", resolutionReason: "sandbox_replay_succeeded" },
          resolutionReason: "sandbox_replay_succeeded",
          via: "terminal_recovery",
        }),
        createdAt: input.recoveredAt,
      });
    }
  }

  if (input.playbookId && input.validationRunId) {
    const actor = input.userId ?? "system";
    const applied = await recordRecoveryPlaybookAppliedTx(tx, {
      orgId: dlq.orgId,
      id: input.playbookId,
      validationRunId: input.validationRunId,
      actor,
      recordedAt: input.recoveredAt,
    });
    if (applied.recorded) {
      await tx.insert(auditLogs).values({
        id: crypto.randomUUID(),
        orgId: dlq.orgId,
        userId: actor,
        action: "recovery.playbook.applied",
        targetType: "recovery_playbook",
        targetId: input.playbookId,
        metadata: safePersistPayload({
          deadLetterId: input.deadLetterId,
          validationRunId: input.validationRunId,
          via: "terminal_recovery",
        }),
        createdAt: input.recoveredAt,
      });
    }
  }
  return true;
}
