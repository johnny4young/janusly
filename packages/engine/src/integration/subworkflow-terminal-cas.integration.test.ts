/** Real-Postgres proof that only the currently awaited child can complete a parent node. */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  db,
  deadLetters,
  recoveryImpactEvents,
  recoveryImpactRollups,
  runEvents,
  runNodes,
  runs,
} from "@janusly/db";
import { completeWaitingSubworkflowNode } from "../persistence";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-subworkflow-cas-${TAG}`;
const RUN = `${TAG}-parent`;
const NODE = "call-child";
const CURRENT_CHILD = `${TAG}-child-current`;
const STALE_CHILD = `${TAG}-child-stale`;
const DLQ = `${TAG}-dlq`;

afterAll(async () => {
  await db.delete(runEvents).where(eq(runEvents.runId, RUN));
  await db.delete(runNodes).where(eq(runNodes.runId, RUN));
  await db.delete(recoveryImpactEvents).where(eq(recoveryImpactEvents.orgId, ORG));
  await db.delete(recoveryImpactRollups).where(eq(recoveryImpactRollups.orgId, ORG));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, ORG));
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

describe("completeWaitingSubworkflowNode child generation CAS", () => {
  it("rejects a stale child and credits only the current child", async () => {
    await db.insert(runs).values({
      id: RUN,
      orgId: ORG,
      workflowVersionId: `${RUN}-version`,
      status: "running",
    });
    await db.insert(deadLetters).values({
      id: DLQ,
      orgId: ORG,
      runId: RUN,
      nodeId: NODE,
      workflowJson: { id: "workflow-a", nodes: [], edges: [] },
      nodeJson: { id: NODE, type: "subworkflow", config: {} },
      errorJson: { message: "old child failed" },
      createdAt: new Date(Date.now() - 30_000),
    });
    await db.insert(runNodes).values({
      id: `${RUN}-node`,
      runId: RUN,
      nodeId: NODE,
      status: "waiting",
      stateJson: { waiting: { kind: "subworkflow", childRunId: CURRENT_CHILD } },
      recoveryDeadLetterId: DLQ,
      recoveryRequestedBy: "operator-a",
      recoveryClaimToken: "current-claim",
    });

    await expect(completeWaitingSubworkflowNode(RUN, NODE, STALE_CHILD, { stale: true }))
      .resolves.toBe(false);
    const [stillWaiting] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(eq(runNodes.runId, RUN));
    expect(stillWaiting?.status).toBe("waiting");

    await expect(completeWaitingSubworkflowNode(RUN, NODE, CURRENT_CHILD, { ok: true }))
      .resolves.toBe(true);
    const impacts = await db
      .select({ deadLetterId: recoveryImpactEvents.deadLetterId })
      .from(recoveryImpactEvents)
      .where(eq(recoveryImpactEvents.orgId, ORG));
    const events = await db
      .select({ type: runEvents.type })
      .from(runEvents)
      .where(eq(runEvents.runId, RUN));
    expect(impacts).toEqual([{ deadLetterId: DLQ }]);
    expect(events).toEqual([{ type: "node.subworkflow.completed" }]);
  });
});
