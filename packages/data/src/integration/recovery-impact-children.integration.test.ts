/** Real-Postgres proof that a debounced child recovery closes its parent incident. */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  auditLogs,
  db,
  deadLetters,
  recoveryImpactEvents,
  recoveryImpactRollups,
  recoveryItemChildren,
  recoveryItems,
} from "@janusly/db";
import { recordRecoveryImpactTx } from "../recoveryMetricsRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-impact-child-${TAG}`;
const PARENT_DLQ = `${TAG}-parent-dlq`;
const CHILD_DLQ = `${TAG}-child-dlq`;
const ITEM = `${TAG}-item`;
const RUN = `${TAG}-run`;
const NODE = "n1";

afterAll(async () => {
  await db.delete(recoveryImpactEvents).where(eq(recoveryImpactEvents.orgId, ORG));
  await db.delete(recoveryImpactRollups).where(eq(recoveryImpactRollups.orgId, ORG));
  await db.delete(recoveryItemChildren).where(eq(recoveryItemChildren.orgId, ORG));
  await db.delete(recoveryItems).where(eq(recoveryItems.orgId, ORG));
  await db.delete(auditLogs).where(eq(auditLogs.orgId, ORG));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, ORG));
});

describe("recordRecoveryImpactTx debounced children", () => {
  it("resolves and audits the shared parent exactly once", async () => {
    const failedAt = new Date(Date.now() - 60_000);
    await db.insert(deadLetters).values([
      {
        id: PARENT_DLQ,
        orgId: ORG,
        runId: `${RUN}-parent`,
        nodeId: NODE,
        workflowJson: { id: "workflow-a", nodes: [], edges: [] },
        nodeJson: { id: NODE, type: "noop", config: {} },
        errorJson: { message: "same storm" },
        createdAt: new Date(failedAt.getTime() - 1_000),
      },
      {
        id: CHILD_DLQ,
        orgId: ORG,
        runId: RUN,
        nodeId: NODE,
        workflowJson: { id: "workflow-a", nodes: [], edges: [] },
        nodeJson: { id: NODE, type: "noop", config: {} },
        errorJson: { message: "same storm" },
        createdAt: failedAt,
      },
    ]);
    await db.insert(recoveryItems).values({
      id: ITEM,
      orgId: ORG,
      deadLetterId: PARENT_DLQ,
      workflowId: "workflow-a",
      status: "in_progress",
      slaTargetAt: new Date(Date.now() + 3_600_000),
    });
    await db.insert(recoveryItemChildren).values({
      id: `${TAG}-child-link`,
      orgId: ORG,
      recoveryItemId: ITEM,
      deadLetterId: CHILD_DLQ,
    });

    const completion = {
      deadLetterId: CHILD_DLQ,
      userId: "operator-a",
      runId: RUN,
      nodeId: NODE,
      recoveredAt: new Date(),
    };
    await expect(db.transaction((tx) => recordRecoveryImpactTx(tx, completion))).resolves.toBe(true);
    await expect(db.transaction((tx) => recordRecoveryImpactTx(tx, completion))).resolves.toBe(false);

    const [item] = await db
      .select({ status: recoveryItems.status, reason: recoveryItems.resolutionReason })
      .from(recoveryItems)
      .where(eq(recoveryItems.id, ITEM));
    const [childDeadLetter] = await db
      .select({ status: deadLetters.status, replayedAt: deadLetters.replayedAt })
      .from(deadLetters)
      .where(eq(deadLetters.id, CHILD_DLQ));
    const audits = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, ITEM));
    expect(item).toEqual({ status: "resolved", reason: "sandbox_replay_succeeded" });
    expect(childDeadLetter).toEqual({ status: "replayed", replayedAt: completion.recoveredAt });
    expect(audits).toHaveLength(1);
  });
});
