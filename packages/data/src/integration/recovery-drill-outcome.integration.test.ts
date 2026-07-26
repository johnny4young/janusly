/** Real-Postgres proof for measured drill outcome precedence and recurrence. */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  auditLogs,
  db,
  deadLetters,
  recoveryImpactEvents,
  recoveryItems,
  runs,
} from "@janusly/db";
import { queryRecoveryDrillOutcome } from "../recoveryDrillOutcomeRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-drill-outcome-${TAG}`;
const OTHER_ORG = `it-drill-outcome-other-${TAG}`;
const ROOT_RUN = `${TAG}-root-run`;
const ROOT_DLQ = `${TAG}-root-dlq`;
const ROOT_ITEM = `${TAG}-root-item`;
const NODE = "recover-step";
const SIGNATURE = "http_error:drill-outcome";
const STARTED = new Date("2026-07-01T10:00:00.000Z");

async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(recoveryImpactEvents).where(eq(recoveryImpactEvents.orgId, orgId));
  await db.delete(recoveryItems).where(eq(recoveryItems.orgId, orgId));
  await db.delete(auditLogs).where(eq(auditLogs.orgId, orgId));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, orgId));
  await db.delete(runs).where(eq(runs.orgId, orgId));
}

afterAll(async () => {
  await cleanupOrg(ORG);
  await cleanupOrg(OTHER_ORG);
});

function runValue(id: string, orgId: string, createdAt: Date, replayMode?: "validation") {
  return {
    id,
    orgId,
    workflowVersionId: `${id}-workflow`,
    status: "failed",
    replayMode: replayMode ?? null,
    createdAt,
  } as const;
}

function deadLetterValue(id: string, runId: string, orgId: string, createdAt: Date) {
  return {
    id,
    orgId,
    runId,
    nodeId: NODE,
    workflowJson: { id: "drill-workflow", nodes: [], edges: [] },
    nodeJson: { id: NODE, type: "http", config: {} },
    errorJson: { message: "HTTP 503 during drill" },
    status: "open",
    createdAt,
  } as const;
}

describe("queryRecoveryDrillOutcome", () => {
  it("derives accepted loss, terminal recovery, and production recurrence without tenant leakage", async () => {
    await db.insert(runs).values(runValue(ROOT_RUN, ORG, STARTED));
    await db.insert(deadLetters).values(deadLetterValue(ROOT_DLQ, ROOT_RUN, ORG, STARTED));
    await db.insert(recoveryItems).values({
      id: ROOT_ITEM,
      orgId: ORG,
      deadLetterId: ROOT_DLQ,
      workflowId: "drill-workflow",
      status: "open",
      slaTargetAt: new Date(STARTED.getTime() + 60 * 60 * 1_000),
      errorSignature: SIGNATURE,
      firstOccurredAt: STARTED,
      lastOccurredAt: STARTED,
      createdAt: STARTED,
    });

    await expect(queryRecoveryDrillOutcome(
      ORG,
      ROOT_DLQ,
      new Date(STARTED.getTime() + 30_000),
    )).resolves.toMatchObject({
      status: "awaiting_action",
      attemptCount: 1,
      latestDeadLetterId: ROOT_DLQ,
      evidence: null,
    });
    await expect(queryRecoveryDrillOutcome(OTHER_ORG, ROOT_DLQ)).resolves.toBeNull();

    const replayStartedAt = new Date(STARTED.getTime() + 60_000);
    await db.update(deadLetters)
      .set({ status: "replayed", replayClaimedAt: replayStartedAt })
      .where(eq(deadLetters.id, ROOT_DLQ));
    await expect(queryRecoveryDrillOutcome(ORG, ROOT_DLQ)).resolves.toMatchObject({
      status: "replay_in_progress",
      completedAt: null,
      evidence: null,
    });

    // Simulate a deployment where recovery-item auto-creation was disabled:
    // the append-only DLQ resolution audit remains the accepted-loss clock.
    const acceptedAt = new Date(STARTED.getTime() + 120_000);
    await db.update(deadLetters).set({ status: "resolved" }).where(eq(deadLetters.id, ROOT_DLQ));
    await db.insert(auditLogs).values({
      id: `${TAG}-resolved-audit`,
      orgId: ORG,
      userId: "operator-a",
      action: "dlq.resolved",
      targetType: "dlq",
      targetId: ROOT_DLQ,
      createdAt: acceptedAt,
    });
    await expect(queryRecoveryDrillOutcome(ORG, ROOT_DLQ)).resolves.toMatchObject({
      status: "accepted_loss",
      completedAt: acceptedAt.toISOString(),
      elapsedMs: 120_000,
      evidence: "explicit_resolution",
      recurrence: { status: "not_applicable" },
    });

    // A late, generation-matched terminal success is stronger than the prior
    // dismissal and becomes the measured outcome.
    const recoveredAt = new Date(STARTED.getTime() + 180_000);
    await db.insert(recoveryImpactEvents).values({
      deadLetterId: ROOT_DLQ,
      orgId: ORG,
      runId: ROOT_RUN,
      nodeId: NODE,
      userId: "operator-a",
      recoveredAt,
      downtimeEndedMs: 180_000,
    });
    await expect(queryRecoveryDrillOutcome(
      ORG,
      ROOT_DLQ,
      new Date(recoveredAt.getTime() + 24 * 60 * 60 * 1_000),
    )).resolves.toMatchObject({
      status: "recovered",
      completedAt: recoveredAt.toISOString(),
      elapsedMs: 180_000,
      evidence: "terminal_impact",
      recurrence: { status: "monitoring", recurredAt: null },
    });

    const sandboxAt = new Date(recoveredAt.getTime() + 24 * 60 * 60 * 1_000);
    const sandboxRun = `${TAG}-sandbox-run`;
    const sandboxDlq = `${TAG}-sandbox-dlq`;
    await db.insert(runs).values(runValue(sandboxRun, ORG, sandboxAt, "validation"));
    await db.insert(deadLetters).values(deadLetterValue(sandboxDlq, sandboxRun, ORG, sandboxAt));
    await db.insert(recoveryItems).values({
      id: `${TAG}-sandbox-item`,
      orgId: ORG,
      deadLetterId: sandboxDlq,
      workflowId: "drill-workflow",
      slaTargetAt: new Date(sandboxAt.getTime() + 60 * 60 * 1_000),
      errorSignature: SIGNATURE,
      firstOccurredAt: sandboxAt,
      lastOccurredAt: sandboxAt,
      createdAt: sandboxAt,
    });
    await expect(queryRecoveryDrillOutcome(
      ORG,
      ROOT_DLQ,
      new Date(sandboxAt.getTime() + 1_000),
    )).resolves.toMatchObject({ recurrence: { status: "monitoring", recurredAt: null } });

    const recurredAt = new Date(recoveredAt.getTime() + 2 * 24 * 60 * 60 * 1_000);
    const recurrenceRun = `${TAG}-recurrence-run`;
    const recurrenceDlq = `${TAG}-recurrence-dlq`;
    await db.insert(runs).values(runValue(recurrenceRun, ORG, recurredAt));
    await db.insert(deadLetters).values(deadLetterValue(recurrenceDlq, recurrenceRun, ORG, recurredAt));
    await db.insert(recoveryItems).values({
      id: `${TAG}-recurrence-item`,
      orgId: ORG,
      deadLetterId: recurrenceDlq,
      workflowId: "drill-workflow",
      slaTargetAt: new Date(recurredAt.getTime() + 60 * 60 * 1_000),
      errorSignature: SIGNATURE,
      firstOccurredAt: recurredAt,
      lastOccurredAt: recurredAt,
      createdAt: recurredAt,
    });
    await expect(queryRecoveryDrillOutcome(ORG, ROOT_DLQ)).resolves.toMatchObject({
      status: "recovered",
      recurrence: {
        status: "recurred",
        recurredAt: recurredAt.toISOString(),
      },
    });
  });
});
