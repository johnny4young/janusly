/**
 * Real-Postgres proof for the terminal-failure transaction. A unit mock cannot
 * demonstrate rollback across run_nodes, dead_letters, runs, and run_events.
 */

import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, deadLetters, runEvents, runNodes, runs } from "@janusly/db";
import { DeadLetterQueueAdapter } from "../adapters/dead-letter-queue";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-terminal-failure-${TAG}`;
const RUN_IDS = ["committed", "rollback", "stale", "stalled-dlq", "stalled-no-dlq"].map(
  (suffix) => `${TAG}-${suffix}`,
);
const workflow = {
  dslVersion: "1.0" as const,
  id: "workflow-terminal-failure",
  nodes: [{ id: "n1", type: "noop" as const, config: {} }],
  edges: [],
};
const node = workflow.nodes[0]!;

async function seedRunning(
  runId: string,
  recoveryClaimToken: string | null = null,
  runStatus = "running",
): Promise<void> {
  await db.insert(runs).values({
    id: runId,
    orgId: ORG,
    workflowVersionId: `${runId}-version`,
    status: runStatus,
  });
  await db.insert(runNodes).values({
    id: `${runId}-node`,
    runId,
    nodeId: node.id,
    status: "running",
    attempts: 1,
    recoveryClaimToken,
  });
}

afterAll(async () => {
  for (const runId of RUN_IDS) {
    await db.delete(runEvents).where(eq(runEvents.runId, runId));
    await db.delete(runNodes).where(eq(runNodes.runId, runId));
  }
  await db.delete(deadLetters).where(eq(deadLetters.orgId, ORG));
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

describe("DeadLetterQueueAdapter.persistTerminalFailure (real Postgres)", () => {
  it("commits node failure, DLQ, node event, and run event together", async () => {
    const runId = RUN_IDS[0]!;
    await seedRunning(runId);
    const adapter = new DeadLetterQueueAdapter();

    await expect(adapter.persistTerminalFailure({
      deadLetterId: `${runId}-dlq`,
      runId,
      orgId: ORG,
      workflowId: workflow.id,
      workflow,
      node,
      attempt: 1,
      error: { message: "upstream unavailable" },
    })).resolves.toBe(true);

    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    const [runNode] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    const dlq = await db.select({ id: deadLetters.id }).from(deadLetters).where(eq(deadLetters.runId, runId));
    const events = await db
      .select({ type: runEvents.type, createdAt: runEvents.createdAt })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.createdAt), asc(runEvents.id));

    expect(run?.status).toBe("failed");
    expect(runNode?.status).toBe("failed");
    expect(dlq).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["node.failed", "run.failed"]);
    const nodeFailedAt = events[0]?.createdAt;
    const runFailedAt = events[1]?.createdAt;
    expect(nodeFailedAt).toBeInstanceOf(Date);
    expect(runFailedAt).toBeInstanceOf(Date);
    if (!nodeFailedAt || !runFailedAt) throw new Error("terminal events must carry timestamps");
    expect(runFailedAt.getTime()).toBeGreaterThan(nodeFailedAt.getTime());
  });

  it("rolls every terminal write back when the DLQ insert fails", async () => {
    const runId = RUN_IDS[1]!;
    const duplicateId = `${runId}-duplicate`;
    await seedRunning(runId);
    await db.insert(deadLetters).values({
      id: duplicateId,
      orgId: ORG,
      runId: "fixture-owner",
      nodeId: "fixture",
      workflowJson: workflow,
      nodeJson: node,
      errorJson: { message: "existing" },
    });
    const adapter = new DeadLetterQueueAdapter();

    await expect(adapter.persistTerminalFailure({
      deadLetterId: duplicateId,
      runId,
      orgId: ORG,
      workflowId: workflow.id,
      workflow,
      node,
      attempt: 1,
      error: { message: "must roll back" },
    })).rejects.toThrow();

    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    const [runNode] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
    expect(run?.status).toBe("running");
    expect(runNode?.status).toBe("running");
    expect(events).toHaveLength(0);
  });

  it("rejects a stale replay generation without writing a DLQ or rewards", async () => {
    const runId = RUN_IDS[2]!;
    await seedRunning(runId, "current-claim");
    const adapter = new DeadLetterQueueAdapter();

    await expect(adapter.persistTerminalFailure({
      runId,
      orgId: ORG,
      workflowId: workflow.id,
      workflow,
      node,
      attempt: 1,
      error: { message: "stale worker" },
      recoveryClaimToken: "old-claim",
    })).resolves.toBe(false);

    const [runNode] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    const dlq = await db.select().from(deadLetters).where(eq(deadLetters.runId, runId));
    expect(runNode?.status).toBe("running");
    expect(dlq).toHaveLength(0);
  });

  it("atomically persists the stalled-node CAS, DLQ, causal event, and run failure", async () => {
    const runId = RUN_IDS[3]!;
    await seedRunning(runId);
    const adapter = new DeadLetterQueueAdapter();

    await expect(adapter.persistStalledTerminalFailure({
      runId,
      orgId: ORG,
      nodeId: node.id,
      attempt: 1,
      error: { name: "WorkerStalledError", code: "worker_stalled", message: "worker interrupted" },
      deadLetter: {
        deadLetterId: `${runId}-dlq`,
        workflowId: workflow.id,
        workflow,
        node,
      },
      eventMetadata: { drill: { kind: "solution_pack_drill" } },
    })).resolves.toEqual({
      persisted: true,
      deadLettered: true,
      deadLetterId: `${runId}-dlq`,
    });

    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    const [runNode] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    const dlq = await db.select({ id: deadLetters.id }).from(deadLetters).where(eq(deadLetters.runId, runId));
    const events = await db
      .select({ type: runEvents.type, payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));

    expect(run?.status).toBe("failed");
    expect(runNode?.status).toBe("failed");
    expect(dlq).toEqual([{ id: `${runId}-dlq` }]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "node.failed",
        payload: expect.objectContaining({
          reason: "worker_stalled",
          drill: { kind: "solution_pack_drill" },
        }),
      }),
      expect.objectContaining({ type: "run.failed" }),
    ]));
  });

  it("atomically terminates an unreplayable stalled run without a DLQ row", async () => {
    const runId = RUN_IDS[4]!;
    await seedRunning(runId, null, "waiting");
    const adapter = new DeadLetterQueueAdapter();

    await expect(adapter.persistStalledTerminalFailure({
      runId,
      orgId: ORG,
      nodeId: node.id,
      attempt: 1,
      error: { name: "WorkerStalledError", code: "worker_stalled", message: "snapshot missing" },
      deadLetter: null,
    })).resolves.toEqual({ persisted: true, deadLettered: false, deadLetterId: null });

    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    const [runNode] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    const dlq = await db.select().from(deadLetters).where(eq(deadLetters.runId, runId));
    const events = await db.select({ type: runEvents.type }).from(runEvents).where(eq(runEvents.runId, runId));

    expect(run?.status).toBe("failed");
    expect(runNode?.status).toBe("failed");
    expect(dlq).toHaveLength(0);
    expect(events.map((event) => event.type).sort()).toEqual(["node.failed", "run.failed"]);
  });
});
