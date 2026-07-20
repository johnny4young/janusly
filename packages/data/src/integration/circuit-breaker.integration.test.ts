/**
 * Integration tests (real Postgres) for the recovery circuit breaker's
 * persistence. The pure decision layer is unit-tested; what only real
 * SQL can prove lives here:
 * - the streak query's JOIN through `workflow_versions` (text id, no FK),
 * - that it counts CONSECUTIVE head-of-history failures and stops at a success,
 * - that sandbox/validation replays never feed a production breaker,
 * - tenant scope, and
 * - the CAS: two workers racing the same streak produce exactly ONE pause.
 *
 * Each test uses a unique org id so rows never collide.
 */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { auditLogs, db, runs, workflows, workflowVersions } from "@janusly/db";
import {
  WORKFLOW_STATUS_PAUSED_CIRCUIT_BREAKER,
  countConsecutiveWorkflowFailures,
  getWorkflowBreakerStatus,
  resumeWorkflowCircuitBreaker,
  tripWorkflowCircuitBreaker,
} from "../circuitBreakerRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-breaker-${TAG}`;
const OTHER_ORG = `it-breaker-other-${TAG}`;

async function seedWorkflow(workflowId: string, orgId = ORG, status = "active"): Promise<void> {
  await db.insert(workflows).values({ id: workflowId, orgId, name: workflowId, status });
  await db.insert(workflowVersions).values({
    id: `${workflowId}-v1`,
    orgId,
    workflowId,
    version: 1,
    dagJson: { id: workflowId, nodes: [], edges: [] },
  });
}

/** Seed terminal runs oldest→newest; the LAST entry is the newest. */
async function seedRuns(
  workflowId: string,
  statuses: Array<{ status: string; replayMode?: string | null }>,
  orgId = ORG,
): Promise<void> {
  const base = Date.now();
  await db.insert(runs).values(statuses.map((entry, i) => ({
    id: `${workflowId}-r${i}-${TAG}`,
    orgId,
    workflowVersionId: `${workflowId}-v1`,
    status: entry.status,
    replayMode: entry.replayMode ?? null,
    createdAt: new Date(base + i * 1000),
  })));
}

/** Trip with the counters the audit row records; tests that don't care take defaults. */
function trip(args: { orgId?: string; workflowId: string; reason: string; runId?: string }) {
  return tripWorkflowCircuitBreaker({
    orgId: args.orgId ?? ORG,
    workflowId: args.workflowId,
    reason: args.reason,
    consecutiveFailures: 5,
    threshold: 5,
    ...(args.runId ? { runId: args.runId } : {}),
  });
}

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await db.delete(auditLogs).where(eq(auditLogs.orgId, org));
    await db.delete(runs).where(eq(runs.orgId, org));
    await db.delete(workflowVersions).where(eq(workflowVersions.orgId, org));
    await db.delete(workflows).where(eq(workflows.orgId, org));
  }
});

describe("countConsecutiveWorkflowFailures (real Postgres)", () => {
  it("counts the failure streak at the head of history", async () => {
    const wf = `wf-streak-${TAG}`;
    await seedWorkflow(wf);
    await seedRuns(wf, [
      { status: "succeeded" },
      { status: "failed" },
      { status: "failed" },
      { status: "failed" },
    ]);

    expect(await countConsecutiveWorkflowFailures(ORG, wf, 5)).toBe(3);
  });

  it("stops at the first success — a flaky workflow among green runs is not broken", async () => {
    const wf = `wf-reset-${TAG}`;
    await seedWorkflow(wf);
    await seedRuns(wf, [
      { status: "failed" },
      { status: "failed" },
      { status: "succeeded" }, // the reset
      { status: "failed" },    // newest
    ]);

    expect(await countConsecutiveWorkflowFailures(ORG, wf, 5)).toBe(1);
  });

  it("ignores sandbox/validation replays — testing a fix must not trip production", async () => {
    const wf = `wf-sandbox-${TAG}`;
    await seedWorkflow(wf);
    await seedRuns(wf, [
      { status: "succeeded" },
      { status: "failed", replayMode: "validation" },
      { status: "failed", replayMode: "validation" },
      { status: "failed", replayMode: "validation" },
    ]);

    expect(await countConsecutiveWorkflowFailures(ORG, wf, 5)).toBe(0);
  });

  it("never counts another org's runs", async () => {
    const wf = `wf-tenant-${TAG}`;
    await seedWorkflow(wf, ORG);
    await seedWorkflow(wf.replace("wf-", "other-"), OTHER_ORG);
    await seedRuns(wf.replace("wf-", "other-"), [{ status: "failed" }, { status: "failed" }], OTHER_ORG);

    expect(await countConsecutiveWorkflowFailures(ORG, wf, 5)).toBe(0);
  });

  it("bounds the scan by the caller's limit", async () => {
    const wf = `wf-limit-${TAG}`;
    await seedWorkflow(wf);
    await seedRuns(wf, Array.from({ length: 10 }, () => ({ status: "failed" })));

    // Answering "are the last 3 all failed?" must never read more than 3 rows.
    expect(await countConsecutiveWorkflowFailures(ORG, wf, 3)).toBe(3);
    expect(await countConsecutiveWorkflowFailures(ORG, wf, 0)).toBe(0);
  });

  it("counts runs started from the authoring surface, which carry the WORKFLOW id in workflowVersionId (regression)", async () => {
    // `startRun` sets `workflowVersionId = workflow.versionId ?? workflow.id`,
    // so the UI's Run button produces runs with NO matching version row. An
    // inner join here silently never matched — i.e. the breaker would never
    // fire for the most common way runs actually start.
    const wf = `wf-adhoc-${TAG}`;
    await seedWorkflow(wf);
    const base = Date.now();
    await db.insert(runs).values([0, 1, 2].map((i) => ({
      id: `${wf}-adhoc-${i}-${TAG}`,
      orgId: ORG,
      workflowVersionId: wf, // the workflow id itself — no version row exists
      status: "failed",
      createdAt: new Date(base + i * 1000),
    })));

    expect(await countConsecutiveWorkflowFailures(ORG, wf, 5)).toBe(3);
  });

  it("returns 0 for a workflow with no terminal runs", async () => {
    const wf = `wf-empty-${TAG}`;
    await seedWorkflow(wf);
    await seedRuns(wf, [{ status: "running" }, { status: "queued" }]);

    expect(await countConsecutiveWorkflowFailures(ORG, wf, 5)).toBe(0);
  });
});

describe("tripWorkflowCircuitBreaker (real Postgres)", () => {
  it("pauses an active workflow and records the reason", async () => {
    const wf = `wf-trip-${TAG}`;
    await seedWorkflow(wf);

    expect(await trip({ workflowId: wf, reason: "5 consecutive" })).toBe(true);

    const row = (await db.select().from(workflows).where(eq(workflows.id, wf)))[0];
    expect(row?.status).toBe(WORKFLOW_STATUS_PAUSED_CIRCUIT_BREAKER);
    expect(row?.pausedReason).toBe("5 consecutive");
  });

  it("CAS: only ONE of two racing workers wins the pause", async () => {
    const wf = `wf-race-${TAG}`;
    await seedWorkflow(wf);

    // Both workers see the same streak and try to trip concurrently — the
    // loser must NOT fire a duplicate page.
    const [a, b] = await Promise.all([
      trip({ workflowId: wf, reason: "worker A" }),
      trip({ workflowId: wf, reason: "worker B" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("never clobbers a workflow paused for another reason", async () => {
    const wf = `wf-upstream-${TAG}`;
    await seedWorkflow(wf, ORG, "paused_upstream_degraded");

    expect(await trip({ workflowId: wf, reason: "breaker" })).toBe(false);
    expect(await getWorkflowBreakerStatus(ORG, wf)).toBe("paused_upstream_degraded");
  });

  it("never trips another org's workflow", async () => {
    const wf = `wf-cross-${TAG}`;
    await seedWorkflow(wf, ORG);

    expect(await trip({ orgId: OTHER_ORG, workflowId: wf, reason: "breaker" })).toBe(false);
    expect(await getWorkflowBreakerStatus(ORG, wf)).toBe("active");
  });

  it("never trips a soft-deleted workflow", async () => {
    const wf = `wf-deleted-${TAG}`;
    await seedWorkflow(wf);
    await db.update(workflows).set({ deletedAt: new Date() }).where(eq(workflows.id, wf));

    expect(await trip({ workflowId: wf, reason: "breaker" })).toBe(false);
    expect(await getWorkflowBreakerStatus(ORG, wf)).toBeNull();
  });
});

describe("resumeWorkflowCircuitBreaker (real Postgres)", () => {
  it("clears a breaker pause and its reason", async () => {
    const wf = `wf-resume-${TAG}`;
    await seedWorkflow(wf);
    await trip({ workflowId: wf, reason: "5 consecutive" });

    expect(await resumeWorkflowCircuitBreaker({ orgId: ORG, workflowId: wf, userId: "op-1" })).toBe(true);
    const row = (await db.select().from(workflows).where(eq(workflows.id, wf)))[0];
    expect(row?.status).toBe("active");
    expect(row?.pausedReason).toBeNull();
  });

  it("does NOT resume a workflow paused by upstream health", async () => {
    // The two pause sources are independent: a breaker resume must not
    // silently un-pause an outage-driven pause.
    const wf = `wf-resume-upstream-${TAG}`;
    await seedWorkflow(wf, ORG, "paused_upstream_degraded");

    expect(await resumeWorkflowCircuitBreaker({ orgId: ORG, workflowId: wf, userId: "op-1" })).toBe(false);
    expect(await getWorkflowBreakerStatus(ORG, wf)).toBe("paused_upstream_degraded");
  });
});

describe("breaker audit trail (real Postgres)", () => {
  async function auditRowsFor(workflowId: string) {
    return db
      .select({ action: auditLogs.action, userId: auditLogs.userId, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, workflowId));
  }

  it("records who paused it, with the evidence that justified the pause", async () => {
    const wf = `wf-audit-trip-${TAG}`;
    await seedWorkflow(wf);
    await tripWorkflowCircuitBreaker({
      orgId: ORG, workflowId: wf, reason: "Circuit breaker: 5 consecutive failed runs",
      consecutiveFailures: 5, threshold: 5, runId: `${wf}-run`,
    });

    const rows = await auditRowsFor(wf);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("workflow.circuit_breaker.tripped");
    expect(rows[0]?.userId).toBe("system:circuit-breaker");
    expect(rows[0]?.metadata).toMatchObject({ consecutiveFailures: 5, threshold: 5, runId: `${wf}-run` });
  });

  it("CAS loser writes NO audit row — one pause, one record", async () => {
    const wf = `wf-audit-race-${TAG}`;
    await seedWorkflow(wf);
    await Promise.all([
      trip({ workflowId: wf, reason: "worker A" }),
      trip({ workflowId: wf, reason: "worker B" }),
    ]);

    expect(await auditRowsFor(wf)).toHaveLength(1);
  });

  it("records the operator who resumed it and the reason they cleared", async () => {
    const wf = `wf-audit-resume-${TAG}`;
    await seedWorkflow(wf);
    await trip({ workflowId: wf, reason: "Circuit breaker: 5 consecutive failed runs" });
    await resumeWorkflowCircuitBreaker({ orgId: ORG, workflowId: wf, userId: "operator-jane" });

    const resumed = (await auditRowsFor(wf)).find((r) => r.action === "workflow.circuit_breaker.resumed");
    expect(resumed?.userId).toBe("operator-jane");
    // Post-update RETURNING would have recorded null here.
    expect(resumed?.metadata).toMatchObject({ clearedReason: "Circuit breaker: 5 consecutive failed runs" });
  });

  it("a refused resume writes no audit row", async () => {
    const wf = `wf-audit-noop-${TAG}`;
    await seedWorkflow(wf); // active — never tripped

    expect(await resumeWorkflowCircuitBreaker({ orgId: ORG, workflowId: wf, userId: "operator-jane" })).toBe(false);
    expect(await auditRowsFor(wf)).toHaveLength(0);
  });
});
