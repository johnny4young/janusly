/**
 * Integration tests (real Postgres) for `redriveRun` — the production
 * continuation of a failed run on a target workflow version. The point is
 * the transactional seeding a mocked DB can't prove: ancestors cloned
 * `succeeded` with the SOURCE run's state, the failed node `queued` with a
 * durable publication marker, downstream `pending`, sibling branches
 * `skipped`, and the continuation run linked with trace-only lineage.
 *
 * Each test uses a unique run id + org and cleans up after itself.
 */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, runs, runNodes, runEvents } from "@janusly/db";
import type { Workflow } from "@janusly/shared";
import { redriveRun } from "../adapters/redrive";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-redrive-${RUN_TAG}`;

/** fetch → transform → notify, plus an independent `audit` root branch. */
const TARGET_WORKFLOW: Workflow = {
  id: "wf-redrive",
  name: "Redrive target",
  nodes: [
    { id: "fetch", type: "noop", config: {} },
    { id: "transform", type: "noop", config: {} },
    { id: "notify", type: "noop", config: {} },
    { id: "audit", type: "noop", config: {} },
  ],
  edges: [
    { from: "fetch", to: "transform" },
    { from: "transform", to: "notify" },
  ],
} as Workflow;

async function seedSourceRun(runId: string, nodes: Array<{ nodeId: string; status: string; stateJson?: unknown }>): Promise<void> {
  await db.insert(runs).values({
    id: runId,
    orgId: ORG,
    workflowVersionId: `${runId}-wfv`,
    status: "failed",
    inputJson: { workflow: TARGET_WORKFLOW, input: { orderId: "o-1" } },
  });
  await db.insert(runNodes).values(
    nodes.map((node, i) => ({
      id: `${runId}-n${i}`,
      runId,
      nodeId: node.nodeId,
      status: node.status,
      stateJson: node.stateJson ?? {},
      attempts: 1,
    })),
  );
}

const createdRunIds: string[] = [];

afterAll(async () => {
  for (const id of createdRunIds) {
    await db.delete(runEvents).where(eq(runEvents.runId, id));
    await db.delete(runNodes).where(eq(runNodes.runId, id));
  }
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

describe("redriveRun (real Postgres)", () => {
  it("seeds the continuation: ancestors cloned, failed node queued, downstream pending, siblings skipped", async () => {
    const sourceRunId = `${RUN_TAG}-happy`;
    createdRunIds.push(sourceRunId);
    await seedSourceRun(sourceRunId, [
      { nodeId: "fetch", status: "succeeded", stateJson: { output: { rows: 3 } } },
      { nodeId: "transform", status: "failed" },
      { nodeId: "notify", status: "pending" },
      { nodeId: "audit", status: "succeeded" },
    ]);

    const result = await redriveRun({
      orgId: ORG,
      sourceRunId,
      failedNodeId: "transform",
      workflow: TARGET_WORKFLOW,
      targetWorkflowVersionId: "wfv-target-2",
      input: { orderId: "o-1" },
      createdBy: "op-1",
      traceId: "trace-source-redrive",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdRunIds.push(result.runId);

    const runRow = (await db.select().from(runs).where(eq(runs.id, result.runId)))[0];
    expect(runRow?.status).toBe("running");
    expect(runRow?.replayMode).toBeNull();
    expect(runRow?.workflowVersionId).toBe("wfv-target-2");
    expect(runRow?.parentRunId).toBe(sourceRunId);
    expect(runRow?.parentNodeId).toBe("transform");
    expect(runRow?.parentLinkKind).toBe("replay");
    expect(runRow?.traceId).toBe("trace-source-redrive");

    const nodeRows = await db.select().from(runNodes).where(eq(runNodes.runId, result.runId));
    const byId = new Map(nodeRows.map((row) => [row.nodeId, row]));
    expect(byId.get("fetch")?.status).toBe("succeeded");
    expect((byId.get("fetch")?.stateJson as { output?: { rows?: number } })?.output?.rows).toBe(3);
    expect(byId.get("transform")?.status).toBe("queued");
    expect(byId.get("transform")?.attempts).toBe(1);
    expect(byId.get("transform")?.queuePublicationGeneration).toBe(1);
    expect(byId.get("notify")?.status).toBe("pending");
    expect(byId.get("audit")?.status).toBe("skipped");

    const eventRows = await db.select().from(runEvents).where(eq(runEvents.runId, result.runId));
    const types = eventRows.map((row) => row.type).sort();
    expect(types).toContain("run.started.redrive");
    expect(types).toContain("node.queued");
  });

  it("rejects when a predecessor did not succeed in the source run (incl. version-added predecessors)", async () => {
    const sourceRunId = `${RUN_TAG}-pred`;
    createdRunIds.push(sourceRunId);
    await seedSourceRun(sourceRunId, [
      { nodeId: "fetch", status: "failed" },
      { nodeId: "transform", status: "failed" },
    ]);

    const result = await redriveRun({
      orgId: ORG,
      sourceRunId,
      failedNodeId: "transform",
      workflow: TARGET_WORKFLOW,
      targetWorkflowVersionId: "wfv-target-2",
      input: {},
    });
    expect(result).toMatchObject({ ok: false, code: "predecessor_not_succeeded" });
  });

  it("rejects when the failed node no longer exists in the target version", async () => {
    const sourceRunId = `${RUN_TAG}-missing`;
    createdRunIds.push(sourceRunId);
    await seedSourceRun(sourceRunId, [{ nodeId: "legacy", status: "failed" }]);

    const result = await redriveRun({
      orgId: ORG,
      sourceRunId,
      failedNodeId: "legacy",
      workflow: TARGET_WORKFLOW,
      targetWorkflowVersionId: "wfv-target-2",
      input: {},
    });
    expect(result).toMatchObject({ ok: false, code: "node_not_in_version" });
  });

  it("converges concurrent retries onto one continuation run", async () => {
    const sourceRunId = `${RUN_TAG}-idempotent`;
    createdRunIds.push(sourceRunId);
    await seedSourceRun(sourceRunId, [
      { nodeId: "fetch", status: "succeeded" },
      { nodeId: "transform", status: "failed" },
    ]);

    const input = {
      orgId: ORG,
      sourceRunId,
      failedNodeId: "transform",
      workflow: TARGET_WORKFLOW,
      targetWorkflowVersionId: "wfv-target-idempotent",
      input: {},
    };
    const [first, second] = await Promise.all([redriveRun(input), redriveRun(input)]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.runId).toBe(second.runId);
    expect([first.wasCreated, second.wasCreated].sort()).toEqual([false, true]);
    createdRunIds.push(first.runId);

    const continuations = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.parentRunId, sourceRunId));
    expect(continuations).toEqual([{ id: first.runId }]);
  });
});
