/**
 * Integration tests (real Postgres) for `claimReplayTransition` (fourth-wave
 * audit Q-02) — the atomic run-un-terminate + node-requeue that replaced the
 * pre-Q-02 pair of separate awaits. The whole point is the TRANSACTION: a
 * mocked DB can't prove the conditional CAS on `runs.status`, the read-back
 * guard, or the rollback-on-throw. Each test uses a unique run id + cleanup.
 */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, runs, runNodes } from "@janusly/db";
import { claimReplayTransition, ReplayNotClaimableError } from "../persistence";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-claim-${RUN_TAG}`;

async function seedRun(runId: string, runStatus: string, nodeStatus: string): Promise<void> {
  await db.insert(runs).values({
    id: runId,
    orgId: ORG,
    workflowVersionId: `${runId}-wfv`, // dangling by design (no FK) — the tx never joins versions
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

async function readState(runId: string): Promise<{ run: string | undefined; node: string | undefined; attempts: number | undefined }> {
  const r = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
  const n = await db.select({ status: runNodes.status, attempts: runNodes.attempts }).from(runNodes).where(eq(runNodes.runId, runId)).limit(1);
  return { run: r[0]?.status, node: n[0]?.status, attempts: n[0]?.attempts ?? undefined };
}

afterAll(async () => {
  await db.delete(runNodes).where(eq(runNodes.runId, `${RUN_TAG}-happy`));
  await db.delete(runNodes).where(eq(runNodes.runId, `${RUN_TAG}-cancelled`));
  await db.delete(runNodes).where(eq(runNodes.runId, `${RUN_TAG}-midretry`));
  await db.delete(runNodes).where(eq(runNodes.runId, `${RUN_TAG}-running`));
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

describe("claimReplayTransition (real Postgres)", () => {
  it("happy path: failed run + pending node → running + queued, no throw", async () => {
    const runId = `${RUN_TAG}-happy`;
    await seedRun(runId, "failed", "pending");

    await expect(claimReplayTransition(runId, "n1")).resolves.toBeUndefined();

    const state = await readState(runId);
    expect(state.run).toBe("running");
    expect(state.node).toBe("queued");
    expect(state.attempts).toBe(1);
  });

  it("run_not_replayable: a cancelled run throws and rolls back (run stays cancelled, node untouched)", async () => {
    const runId = `${RUN_TAG}-cancelled`;
    await seedRun(runId, "cancelled", "pending");

    await expect(claimReplayTransition(runId, "n1")).rejects.toMatchObject({
      name: "ReplayNotClaimableError",
      reason: "run_not_replayable",
    });

    // The failed→running flip is conditional on status='failed' (no-op here),
    // and nothing else committed — a cancelled run is never resurrected.
    const state = await readState(runId);
    expect(state.run).toBe("cancelled");
    expect(state.node).toBe("pending");
  });

  it("node_mid_retry: a queued node throws and ROLLS BACK the run flip (run stays failed)", async () => {
    const runId = `${RUN_TAG}-midretry`;
    await seedRun(runId, "failed", "queued");

    await expect(claimReplayTransition(runId, "n1")).rejects.toBeInstanceOf(ReplayNotClaimableError);

    // Critical: the run was flipped failed→running inside the tx, then the
    // node-mid-retry guard threw — the transaction MUST roll the flip back so
    // the run doesn't leak into `running` with no queued work.
    const state = await readState(runId);
    expect(state.run).toBe("failed");
    expect(state.node).toBe("queued");
  });

  it("multi-dead-letter-same-run: an already-running run claims its own node without throwing", async () => {
    const runId = `${RUN_TAG}-running`;
    await seedRun(runId, "running", "pending");

    await expect(claimReplayTransition(runId, "n1")).resolves.toBeUndefined();

    const state = await readState(runId);
    expect(state.run).toBe("running");
    expect(state.node).toBe("queued");
  });
});
