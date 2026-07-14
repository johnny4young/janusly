/**
 * Real-Postgres coverage for atomic DLQ replay claims and generation-bound
 * execution completion. Mocked storage cannot prove row-lock serialization or
 * that a stale worker is unable to credit a newer replay claim.
 */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { queryOperatorRecoveryCount, queryRecoveryLedger } from "@janusly/data";
import {
  db,
  deadLetters,
  recoveryImpactEvents,
  recoveryImpactRollups,
  runEvents,
  runs,
  runNodes,
} from "@janusly/db";
import {
  claimReplayTransition,
  failStalledRunningNode,
  markExecutingNodeFailed,
  markNodeRunning,
  markNodeSucceededWithEvent,
  ReplayNotClaimableError,
} from "../persistence";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-claim-${RUN_TAG}`;
const SEEDED_RUN_IDS = [
  "happy",
  "cancelled",
  "midretry",
  "running-node",
  "running",
  "concurrent",
  "recovery-failed",
  "recovery-succeeded",
  "stale-generation",
].map((suffix) => `${RUN_TAG}-${suffix}`);

async function seedRun(runId: string, runStatus: string, nodeStatus: string): Promise<void> {
  await db.insert(runs).values({
    id: runId,
    orgId: ORG,
    workflowVersionId: `${runId}-wfv`,
    status: runStatus,
  });
  await db.insert(runNodes).values({
    id: `${runId}-n`,
    runId,
    nodeId: "n1",
    status: nodeStatus,
    attempts: 0,
  });
}

async function seedDlq(runId: string, suffix: string, downtimeMs: number): Promise<string> {
  const id = `${runId}-${suffix}`;
  await db.insert(deadLetters).values({
    id,
    orgId: ORG,
    runId,
    nodeId: "n1",
    status: "open",
    createdAt: new Date(Date.now() - downtimeMs),
    workflowJson: { id: "workflow-a", nodes: [], edges: [] },
    nodeJson: { id: "n1", type: "noop", config: {} },
    errorJson: { message: "fixture failure" },
  });
  return id;
}

async function readState(runId: string): Promise<{
  run: string | undefined;
  node: string | undefined;
  attempts: number | undefined;
  recoveryClaimToken: string | null | undefined;
}> {
  const r = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
  const n = await db
    .select({
      status: runNodes.status,
      attempts: runNodes.attempts,
      recoveryClaimToken: runNodes.recoveryClaimToken,
    })
    .from(runNodes)
    .where(eq(runNodes.runId, runId))
    .limit(1);
  return {
    run: r[0]?.status,
    node: n[0]?.status,
    attempts: n[0]?.attempts ?? undefined,
    recoveryClaimToken: n[0]?.recoveryClaimToken,
  };
}

afterAll(async () => {
  for (const runId of SEEDED_RUN_IDS) {
    await db.delete(runEvents).where(eq(runEvents.runId, runId));
    await db.delete(runNodes).where(eq(runNodes.runId, runId));
  }
  await db.delete(recoveryImpactEvents).where(eq(recoveryImpactEvents.orgId, ORG));
  await db.delete(recoveryImpactRollups).where(eq(recoveryImpactRollups.orgId, ORG));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, ORG));
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

describe("claimReplayTransition (real Postgres)", () => {
  it("claims a failed node with an opaque replay generation", async () => {
    const runId = `${RUN_TAG}-happy`;
    await seedRun(runId, "failed", "failed");

    const token = await claimReplayTransition(runId, "n1");

    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const state = await readState(runId);
    expect(state).toMatchObject({ run: "running", node: "queued", attempts: 1 });
    expect(state.recoveryClaimToken).toBe(token);
  });

  it("rejects a cancelled run and rolls back without touching the node", async () => {
    const runId = `${RUN_TAG}-cancelled`;
    await seedRun(runId, "cancelled", "failed");

    await expect(claimReplayTransition(runId, "n1")).rejects.toMatchObject({
      name: "ReplayNotClaimableError",
      reason: "run_not_replayable",
    });

    expect(await readState(runId)).toMatchObject({ run: "cancelled", node: "failed" });
  });

  it("rejects queued and running nodes and rolls back the run flip", async () => {
    const queuedRunId = `${RUN_TAG}-midretry`;
    const runningRunId = `${RUN_TAG}-running-node`;
    await seedRun(queuedRunId, "failed", "queued");
    await seedRun(runningRunId, "failed", "running");

    await expect(claimReplayTransition(queuedRunId, "n1")).rejects.toBeInstanceOf(ReplayNotClaimableError);
    await expect(claimReplayTransition(runningRunId, "n1")).rejects.toBeInstanceOf(ReplayNotClaimableError);

    expect(await readState(queuedRunId)).toMatchObject({ run: "failed", node: "queued" });
    expect(await readState(runningRunId)).toMatchObject({ run: "failed", node: "running" });
  });

  it("allows a failed sibling node on an already-running multi-DLQ run", async () => {
    const runId = `${RUN_TAG}-running`;
    await seedRun(runId, "running", "failed");

    await expect(claimReplayTransition(runId, "n1")).resolves.toMatch(/^[0-9a-f-]{36}$/);
    expect(await readState(runId)).toMatchObject({ run: "running", node: "queued" });
  });

  it("serializes concurrent claims so exactly one generation wins", async () => {
    const runId = `${RUN_TAG}-concurrent`;
    await seedRun(runId, "failed", "failed");

    const results = await Promise.allSettled([
      claimReplayTransition(runId, "n1"),
      claimReplayTransition(runId, "n1"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled");
    expect((await readState(runId)).recoveryClaimToken).toBe(winner?.value);
  });

  it("records impact only after generation-matched terminal success", async () => {
    const baseline = await queryRecoveryLedger(ORG);
    const failedRunId = `${RUN_TAG}-recovery-failed`;
    const successRunId = `${RUN_TAG}-recovery-succeeded`;
    await seedRun(failedRunId, "failed", "failed");
    await seedRun(successRunId, "failed", "failed");
    const failedDlqId = await seedDlq(failedRunId, "dlq", 60_000);
    const successDlqId = await seedDlq(successRunId, "dlq", 120_000);

    const failedToken = await claimReplayTransition(failedRunId, "n1", {
      deadLetterId: failedDlqId,
      recoveryActorId: "operator-a",
    });
    expect(await markNodeRunning(failedRunId, "n1", 1, failedToken)).toBe(true);
    expect(await markExecutingNodeFailed(failedRunId, "n1", { message: "failed again" }, failedToken)).toBe(true);
    await expect(queryRecoveryLedger(ORG)).resolves.toMatchObject({ totalRecovered: baseline.totalRecovered });

    const successToken = await claimReplayTransition(successRunId, "n1", {
      deadLetterId: successDlqId,
      recoveryActorId: "operator-a",
    });
    const [claimedDlq] = await db
      .select({
        replayClaimToken: deadLetters.replayClaimToken,
        replayClaimedAt: deadLetters.replayClaimedAt,
        replayedAt: deadLetters.replayedAt,
      })
      .from(deadLetters)
      .where(eq(deadLetters.id, successDlqId));
    expect(claimedDlq).toMatchObject({ replayClaimToken: successToken, replayedAt: null });
    expect(claimedDlq?.replayClaimedAt).toBeInstanceOf(Date);
    expect(await markNodeRunning(successRunId, "n1", 1, successToken)).toBe(true);
    expect(await markNodeSucceededWithEvent(successRunId, "n1", { ok: true }, 1, successToken)).toBe(true);
    await expect(queryRecoveryLedger(ORG)).resolves.toMatchObject({ totalRecovered: baseline.totalRecovered + 1 });
    await expect(queryOperatorRecoveryCount(ORG, "operator-a", new Date(Date.now() - 86_400_000)))
      .resolves.toBe(1);

    expect(await markNodeSucceededWithEvent(successRunId, "n1", { ok: true }, 1, successToken)).toBe(false);
    await expect(queryRecoveryLedger(ORG)).resolves.toMatchObject({ totalRecovered: baseline.totalRecovered + 1 });
  });

  it("rejects a stale worker after the reaper and a newer replay generation", async () => {
    const baseline = await queryRecoveryLedger(ORG);
    const runId = `${RUN_TAG}-stale-generation`;
    await seedRun(runId, "failed", "failed");
    const oldDlqId = await seedDlq(runId, "old-dlq", 180_000);
    const newDlqId = await seedDlq(runId, "new-dlq", 240_000);

    const oldToken = await claimReplayTransition(runId, "n1", {
      deadLetterId: oldDlqId,
      recoveryActorId: "operator-old",
    });
    expect(await markNodeRunning(runId, "n1", 1, oldToken)).toBe(true);
    expect(await failStalledRunningNode(runId, "n1", { message: "stalled" })).toBe(true);

    const newToken = await claimReplayTransition(runId, "n1", {
      deadLetterId: newDlqId,
      recoveryActorId: "operator-new",
    });
    expect(await markNodeRunning(runId, "n1", 1, newToken)).toBe(true);

    expect(await markNodeSucceededWithEvent(runId, "n1", { stale: true }, 1, oldToken)).toBe(false);
    await expect(queryRecoveryLedger(ORG)).resolves.toMatchObject({ totalRecovered: baseline.totalRecovered });
    await expect(queryOperatorRecoveryCount(ORG, "operator-old", new Date(Date.now() - 86_400_000)))
      .resolves.toBe(0);

    expect(await markNodeSucceededWithEvent(runId, "n1", { ok: true }, 1, newToken)).toBe(true);
    await expect(queryRecoveryLedger(ORG)).resolves.toMatchObject({ totalRecovered: baseline.totalRecovered + 1 });
    await expect(queryOperatorRecoveryCount(ORG, "operator-new", new Date(Date.now() - 86_400_000)))
      .resolves.toBe(1);
  });
});
