/** Real-Postgres proof for tenant-scoped technical autonomy facts. */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  autoHealingRuns,
  db,
  deadLetters,
  recoveryImpactEvents,
} from "@janusly/db";
import {
  listAutoHealingAutonomyContexts,
  queryVerifiedAutoHealingRecoveries,
} from "../autoHealingAutonomyRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-autonomy-${TAG}`;
const OTHER_ORG = `it-autonomy-other-${TAG}`;
const SIGNATURE = "http:timeout:billing";

function deadLetter(id: string, orgId = ORG) {
  return {
    id,
    orgId,
    runId: `run-${id}`,
    nodeId: "charge",
    workflowJson: {
      id: "billing",
      nodes: [{ id: "charge", type: "noop", config: {} }],
      edges: [],
    },
    nodeJson: { id: "charge", type: "noop", config: {} },
    errorJson: { code: "provider_timeout" },
  };
}

afterAll(async () => {
  await db.delete(recoveryImpactEvents).where(eq(recoveryImpactEvents.orgId, ORG));
  await db.delete(recoveryImpactEvents).where(eq(recoveryImpactEvents.orgId, OTHER_ORG));
  await db.delete(autoHealingRuns).where(eq(autoHealingRuns.orgId, ORG));
  await db.delete(autoHealingRuns).where(eq(autoHealingRuns.orgId, OTHER_ORG));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, ORG));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, OTHER_ORG));
});

describe("technical auto-healing autonomy facts (real Postgres)", () => {
  it("keeps context tenant-scoped and counts distinct terminal impact facts", async () => {
    const priorA = `dlq-a-${TAG}`;
    const priorB = `dlq-b-${TAG}`;
    const pending = `dlq-pending-${TAG}`;
    const other = `dlq-other-${TAG}`;
    await db.insert(deadLetters).values([
      deadLetter(priorA),
      deadLetter(priorB),
      deadLetter(pending),
      deadLetter(other, OTHER_ORG),
    ]);
    await db.insert(autoHealingRuns).values([
      {
        id: `heal-a-1-${TAG}`,
        orgId: ORG,
        deadLetterId: priorA,
        signature: SIGNATURE,
        status: "applied",
        loopAttemptCount: 1,
      },
      {
        id: `heal-a-duplicate-${TAG}`,
        orgId: ORG,
        deadLetterId: priorA,
        signature: SIGNATURE,
        status: "applied",
        loopAttemptCount: 1,
      },
      {
        id: `heal-b-${TAG}`,
        orgId: ORG,
        deadLetterId: priorB,
        signature: SIGNATURE,
        status: "applied",
        loopAttemptCount: 1,
      },
      {
        id: `heal-pending-${TAG}`,
        orgId: ORG,
        deadLetterId: pending,
        signature: SIGNATURE,
        status: "validated",
        loopAttemptCount: 1,
      },
      {
        id: `heal-other-${TAG}`,
        orgId: OTHER_ORG,
        deadLetterId: other,
        signature: SIGNATURE,
        status: "applied",
        loopAttemptCount: 1,
      },
    ]);
    await db.insert(recoveryImpactEvents).values([
      {
        deadLetterId: priorA,
        orgId: ORG,
        runId: `run-${priorA}`,
        nodeId: "charge",
        recoveredAt: new Date(),
        downtimeEndedMs: 1_000,
      },
      {
        deadLetterId: priorB,
        orgId: ORG,
        runId: `run-${priorB}`,
        nodeId: "charge",
        recoveredAt: new Date(),
        downtimeEndedMs: 1_500,
      },
      {
        deadLetterId: pending,
        orgId: ORG,
        runId: `run-${pending}`,
        nodeId: "charge",
        recoveredAt: new Date(),
        downtimeEndedMs: 2_000,
      },
      {
        deadLetterId: other,
        orgId: OTHER_ORG,
        runId: `run-${other}`,
        nodeId: "charge",
        recoveredAt: new Date(),
        downtimeEndedMs: 2_500,
      },
    ]);

    await expect(
      listAutoHealingAutonomyContexts(ORG, [pending, other]),
    ).resolves.toEqual([
      expect.objectContaining({
        deadLetterId: pending,
        nodeId: "charge",
      }),
    ]);
    await expect(
      queryVerifiedAutoHealingRecoveries(ORG, [SIGNATURE]),
    ).resolves.toEqual([{ signature: SIGNATURE, count: 2 }]);
  });
});
