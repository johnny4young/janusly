/**
 * Real-Postgres proof that the controlled interruption drill crosses the same
 * threshold query and atomic reaper boundary as production without touching an
 * unrelated stale run.
 */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, deadLetters, runEvents, runNodes, runs } from "@janusly/db";

import { runStalledNodeDrill } from "../adapters/stalled-node-drill";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-stalled-drill-${TAG}`;
const UNRELATED_RUN = `${TAG}-unrelated`;
const workflow = {
  dslVersion: "1.0" as const,
  id: "incident-triage",
  name: "Incident triage",
  nodes: [
    { id: "trigger", type: "webhook" as const, config: {} },
    { id: "page_oncall", type: "tool" as const, config: { tool: "slack.post", input: {} } },
  ],
  edges: [{ from: "trigger", to: "page_oncall" }],
};

afterAll(async () => {
  const orgRuns = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG));
  for (const run of orgRuns) {
    await db.delete(runEvents).where(eq(runEvents.runId, run.id));
    await db.delete(runNodes).where(eq(runNodes.runId, run.id));
  }
  await db.delete(deadLetters).where(eq(deadLetters.orgId, ORG));
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

describe("runStalledNodeDrill (real Postgres)", () => {
  it("reaps only the scoped drill run and returns measured threshold evidence", async () => {
    const oldStartedAt = new Date(Date.now() - 2 * 60 * 60_000);
    await db.insert(runs).values({
      id: UNRELATED_RUN,
      orgId: ORG,
      workflowVersionId: `${UNRELATED_RUN}-version`,
      status: "running",
      inputJson: { workflow, input: {} },
      createdAt: oldStartedAt,
    });
    await db.insert(runNodes).values({
      id: `${UNRELATED_RUN}-node`,
      runId: UNRELATED_RUN,
      nodeId: "page_oncall",
      status: "running",
      attempts: 1,
      startedAt: oldStartedAt,
    });

    const result = await runStalledNodeDrill({
      orgId: ORG,
      createdBy: "operator-1",
      workflow,
      failedNodeId: "page_oncall",
      source: {
        kind: "solution_pack_drill",
        packId: "incident-triage",
        fixtureId: "worker_interrupted_during_page",
        failureMode: "worker_stalled",
        recoveryPath: "stalled_node_reaper",
      },
      env: { JANUSLY_STALLED_NODE_THRESHOLD_MINUTES: "15" },
    });

    expect(result).toMatchObject({
      runId: expect.any(String),
      deadLetterId: expect.any(String),
      evidence: {
        recoveryPath: "stalled_node_reaper",
        thresholdMinutes: 15,
        simulatedStallMs: 15 * 60_000 + 1_000,
        reaperRuntimeMs: expect.any(Number),
        scanned: 1,
        reaped: 1,
        deadLettered: 1,
      },
    });

    const [run] = await db
      .select({ status: runs.status, inputJson: runs.inputJson })
      .from(runs)
      .where(eq(runs.id, result.runId));
    const [node] = await db
      .select({ status: runNodes.status, errorJson: runNodes.errorJson })
      .from(runNodes)
      .where(eq(runNodes.runId, result.runId));
    const [letter] = await db
      .select({ id: deadLetters.id, status: deadLetters.status })
      .from(deadLetters)
      .where(eq(deadLetters.runId, result.runId));
    const events = await db
      .select({ type: runEvents.type, payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, result.runId));
    const [unrelated] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(eq(runNodes.runId, UNRELATED_RUN));
    const unrelatedLetters = await db
      .select({ id: deadLetters.id })
      .from(deadLetters)
      .where(eq(deadLetters.runId, UNRELATED_RUN));

    expect(run?.status).toBe("failed");
    expect(run?.inputJson).toMatchObject({
      drill: {
        kind: "solution_pack_drill",
        recoveryPath: "stalled_node_reaper",
        thresholdMinutes: 15,
      },
    });
    expect(node).toMatchObject({
      status: "failed",
      errorJson: { code: "worker_stalled" },
    });
    expect(letter).toEqual({ id: result.deadLetterId, status: "open" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.started" }),
      expect.objectContaining({
        type: "node.failed",
        payload: expect.objectContaining({
          reason: "worker_stalled",
          drill: expect.objectContaining({ fixtureId: "worker_interrupted_during_page" }),
        }),
      }),
      expect.objectContaining({ type: "run.failed" }),
    ]));
    expect(unrelated?.status).toBe("running");
    expect(unrelatedLetters).toHaveLength(0);
  });
});
