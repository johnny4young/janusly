/**
 * Integration tests (real Postgres) for `updateRunStatusFromNodes` terminal
 * transitions — the run-level rollup that flips a run
 * to `succeeded`/`failed` once its nodes settle, and now appends a PERSISTED
 * `run.succeeded` / `run.failed` timeline row next to the status flip.
 *
 * The point is transaction/CAS correctness a mocked DB can't prove:
 * - the conditional `ne(status)` flip so the terminal event is appended EXACTLY
 *   once even if the rollup runs twice (concurrent node completions), and
 * - that the persisted `run_events` row actually lands (it used to be a dead
 *   catalog key — terminal status was only an ephemeral SSE frame).
 *
 * Each test uses a unique run id + org and cleans up after itself.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, runs, runNodes, runEvents } from "@janusly/db";
import { updateRunStatusFromNodes } from "../persistence";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-runstatus-${RUN_TAG}`;

async function seedRun(runId: string, nodeStatuses: string[]): Promise<void> {
  await db.insert(runs).values({
    id: runId,
    orgId: ORG,
    workflowVersionId: `${runId}-wfv`, // dangling by design (no FK)
    status: "running",
  });
  await db.insert(runNodes).values(
    nodeStatuses.map((status, i) => ({
      id: `${runId}-n${i}`,
      runId,
      nodeId: `n${i}`,
      status,
      attempts: 0,
    })),
  );
}

async function terminalEvents(runId: string, type: string): Promise<number> {
  const rows = await db
    .select({ id: runEvents.id })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, type)));
  return rows.length;
}

async function runStatus(runId: string): Promise<string | undefined> {
  const r = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
  return r[0]?.status;
}

afterAll(async () => {
  for (const suffix of ["succeed", "fail", "idempotent"]) {
    await db.delete(runEvents).where(eq(runEvents.runId, `${RUN_TAG}-${suffix}`));
    await db.delete(runNodes).where(eq(runNodes.runId, `${RUN_TAG}-${suffix}`));
  }
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

describe("updateRunStatusFromNodes terminal events (real Postgres)", () => {
  it("all nodes succeeded → run flips to succeeded + one persisted run.succeeded row", async () => {
    const runId = `${RUN_TAG}-succeed`;
    await seedRun(runId, ["succeeded", "succeeded"]);

    await expect(updateRunStatusFromNodes(runId)).resolves.toBe("succeeded");

    expect(await runStatus(runId)).toBe("succeeded");
    expect(await terminalEvents(runId, "run.succeeded")).toBe(1);
    expect(await terminalEvents(runId, "run.failed")).toBe(0);
  });

  it("a failed node → run flips to failed + one persisted run.failed row", async () => {
    const runId = `${RUN_TAG}-fail`;
    await seedRun(runId, ["succeeded", "failed"]);

    await expect(updateRunStatusFromNodes(runId)).resolves.toBe("failed");

    expect(await runStatus(runId)).toBe("failed");
    expect(await terminalEvents(runId, "run.failed")).toBe(1);
    expect(await terminalEvents(runId, "run.succeeded")).toBe(0);
  });

  it("a second rollup on an already-terminal run appends NO duplicate event", async () => {
    const runId = `${RUN_TAG}-idempotent`;
    await seedRun(runId, ["succeeded"]);

    // First rollup transitions running→succeeded and appends the row.
    await updateRunStatusFromNodes(runId);
    // A second rollup (as happens when another node completion re-triggers it)
    // early-returns on the already-terminal status — no second append.
    await updateRunStatusFromNodes(runId);

    expect(await terminalEvents(runId, "run.succeeded")).toBe(1);
  });
});
