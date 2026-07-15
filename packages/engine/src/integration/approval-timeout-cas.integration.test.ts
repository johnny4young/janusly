/** Real-Postgres proof that delayed approval policies claim one deadline generation exactly once. */

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, runEvents, runNodes, runs } from "@janusly/db";
import {
  claimDueWaitingCheckpoints,
  escalateWaitingApprovalNode,
  failWaitingApprovalNode,
} from "../persistence";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-approval-timeout-${TAG}`;
const RUN = `${TAG}-run`;
const RACE_RUN = `${TAG}-race-run`;
const DUE_RUN = `${TAG}-due-run`;
const TERMINAL_RUN = `${TAG}-terminal-run`;
const BULK_RUN = `${TAG}-bulk-run`;
const RUN_IDS = [RUN, RACE_RUN, DUE_RUN, TERMINAL_RUN, BULK_RUN];
const CURRENT_DEADLINE = "2026-07-14T12:00:00.000Z";
const STALE_DEADLINE = "2026-07-14T11:00:00.000Z";

afterAll(async () => {
  await db.delete(runEvents).where(inArray(runEvents.runId, RUN_IDS));
  await db.delete(runNodes).where(inArray(runNodes.runId, RUN_IDS));
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

describe("approval deadline generation CAS", () => {
  it("rejects stale jobs, applies escalation once, and keeps auto-reject terminal", async () => {
    await db.insert(runs).values({
      id: RUN,
      orgId: ORG,
      workflowVersionId: `${RUN}-version`,
      status: "running",
    });
    await db.insert(runNodes).values([
      {
        id: `${RUN}-escalate`,
        runId: RUN,
        nodeId: "approval-escalate",
        status: "waiting",
        stateJson: {
          waiting: {
            kind: "approval",
            assignee: "tier-1",
            deadlineAt: CURRENT_DEADLINE,
            onTimeout: "escalate",
            escalateTo: "tier-2",
          },
        },
      },
      {
        id: `${RUN}-reject`,
        runId: RUN,
        nodeId: "approval-reject",
        status: "waiting",
        stateJson: {
          waiting: {
            kind: "approval",
            deadlineAt: CURRENT_DEADLINE,
            onTimeout: "auto_reject",
          },
        },
      },
      {
        id: `${RUN}-terminal-parent`,
        runId: RUN,
        nodeId: "approval-after-terminal",
        status: "waiting",
        stateJson: {
          waiting: {
            kind: "approval",
            deadlineAt: CURRENT_DEADLINE,
            onTimeout: "fail",
          },
        },
      },
    ]);

    await expect(escalateWaitingApprovalNode(RUN, "approval-escalate", STALE_DEADLINE, "wrong"))
      .resolves.toBe(false);
    await expect(escalateWaitingApprovalNode(RUN, "approval-escalate", CURRENT_DEADLINE, "tier-2"))
      .resolves.toBe(true);
    await expect(escalateWaitingApprovalNode(RUN, "approval-escalate", CURRENT_DEADLINE, "tier-2"))
      .resolves.toBe(false);
    await expect(failWaitingApprovalNode(RUN, "approval-reject", CURRENT_DEADLINE, "auto_reject"))
      .resolves.toBe(true);
    await expect(failWaitingApprovalNode(RUN, "approval-reject", CURRENT_DEADLINE, "auto_reject"))
      .resolves.toBe(false);
    await expect(escalateWaitingApprovalNode(RUN, "approval-after-terminal", CURRENT_DEADLINE, "tier-2"))
      .resolves.toBe(false);
    await expect(failWaitingApprovalNode(RUN, "approval-after-terminal", CURRENT_DEADLINE, "fail"))
      .resolves.toBe(false);

    const [escalated] = await db
      .select({ status: runNodes.status, stateJson: runNodes.stateJson })
      .from(runNodes)
      .where(and(eq(runNodes.runId, RUN), eq(runNodes.nodeId, "approval-escalate")));
    expect(escalated?.status).toBe("waiting");
    expect(escalated?.stateJson).toMatchObject({
      waiting: {
        assignee: "tier-2",
        escalatedFrom: "tier-1",
        timeoutState: "escalated",
      },
    });

    const [rejected] = await db
      .select({ status: runNodes.status, errorJson: runNodes.errorJson })
      .from(runNodes)
      .where(and(eq(runNodes.runId, RUN), eq(runNodes.nodeId, "approval-reject")));
    expect(rejected).toMatchObject({
      status: "failed",
      errorJson: { code: "approval_auto_rejected", onTimeout: "auto_reject" },
    });

    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, RUN));
    expect(run?.status).toBe("failed");
    const [guarded] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(and(eq(runNodes.runId, RUN), eq(runNodes.nodeId, "approval-after-terminal")));
    expect(guarded?.status).toBe("waiting");

    const events = await db
      .select({ type: runEvents.type })
      .from(runEvents)
      .where(eq(runEvents.runId, RUN));
    expect(events.map(event => event.type).sort()).toEqual([
      "approval.auto_rejected",
      "approval.escalated",
      "run.failed",
    ]);
  });

  it("serializes concurrent escalation and terminal timeout claims", async () => {
    await db.insert(runs).values({
      id: RACE_RUN,
      orgId: ORG,
      workflowVersionId: `${RACE_RUN}-version`,
      status: "running",
    });
    await db.insert(runNodes).values({
      id: `${RACE_RUN}-gate`,
      runId: RACE_RUN,
      nodeId: "gate",
      status: "waiting",
      stateJson: {
        waiting: {
          kind: "approval",
          assignee: "tier-1",
          deadlineAt: CURRENT_DEADLINE,
          onTimeout: "escalate",
          escalateTo: "tier-2",
        },
      },
    });

    const [escalated, failed] = await Promise.all([
      escalateWaitingApprovalNode(RACE_RUN, "gate", CURRENT_DEADLINE, "tier-2"),
      failWaitingApprovalNode(RACE_RUN, "gate", CURRENT_DEADLINE, "fail"),
    ]);
    expect([escalated, failed].filter(Boolean)).toHaveLength(1);

    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, RACE_RUN));
    const [node] = await db
      .select({ status: runNodes.status, stateJson: runNodes.stateJson })
      .from(runNodes)
      .where(and(eq(runNodes.runId, RACE_RUN), eq(runNodes.nodeId, "gate")));
    const events = await db
      .select({ type: runEvents.type })
      .from(runEvents)
      .where(eq(runEvents.runId, RACE_RUN));

    if (escalated) {
      expect(run?.status).toBe("running");
      expect(node).toMatchObject({ status: "waiting", stateJson: { waiting: { timeoutState: "escalated" } } });
      expect(events.map(event => event.type)).toEqual(["approval.escalated"]);
    } else {
      expect(run?.status).toBe("failed");
      expect(node?.status).toBe("failed");
      expect(events.map(event => event.type).sort()).toEqual(["approval.timed_out", "run.failed"]);
    }
  });

  it("finds only overdue checkpoints on active runs for durable repair", async () => {
    await db.insert(runs).values([
      { id: DUE_RUN, orgId: ORG, workflowVersionId: `${DUE_RUN}-version`, status: "running" },
      { id: TERMINAL_RUN, orgId: ORG, workflowVersionId: `${TERMINAL_RUN}-version`, status: "cancelled" },
    ]);
    await db.insert(runNodes).values([
      waitingRow(DUE_RUN, "approval-due", { kind: "approval", deadlineAt: CURRENT_DEADLINE }),
      waitingRow(DUE_RUN, "timer-due", { kind: "timer", wakeAt: CURRENT_DEADLINE }),
      waitingRow(DUE_RUN, "approval-future", { kind: "approval", deadlineAt: "2026-07-14T13:00:00.000Z" }),
      waitingRow(DUE_RUN, "approval-escalated", {
        kind: "approval",
        deadlineAt: CURRENT_DEADLINE,
        timeoutState: "escalated",
      }),
      waitingRow(TERMINAL_RUN, "approval-cancelled", { kind: "approval", deadlineAt: CURRENT_DEADLINE }),
    ]);

    const due = (await claimDueWaitingCheckpoints(new Date("2026-07-14T12:01:00.000Z")))
      .filter(checkpoint => checkpoint.runId === DUE_RUN || checkpoint.runId === TERMINAL_RUN)
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    expect(due).toEqual([
      { runId: DUE_RUN, nodeId: "approval-due", kind: "approval", targetAt: CURRENT_DEADLINE },
      { runId: DUE_RUN, nodeId: "timer-due", kind: "timer", targetAt: CURRENT_DEADLINE },
    ]);
    const indexes = await db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'run_nodes'`,
    );
    expect(Array.from(indexes).map(row => row.indexname)).toContain("run_nodes_waiting_target_idx");
  });

  it("leases a blocked 500-row batch so later overdue checkpoints still progress", async () => {
    const overdueAt = "1999-12-31T23:59:00.000Z";
    const sweepAt = new Date("2000-01-01T00:00:00.000Z");
    await db.insert(runs).values({
      id: BULK_RUN,
      orgId: ORG,
      workflowVersionId: `${BULK_RUN}-version`,
      status: "running",
    });
    await db.insert(runNodes).values(Array.from({ length: 501 }, (_, index) => {
      const nodeId = `blocked-${String(index).padStart(4, "0")}`;
      return waitingRow(BULK_RUN, nodeId, { kind: "timer", wakeAt: overdueAt });
    }));

    const firstClaim = (await claimDueWaitingCheckpoints(sweepAt, 500))
      .filter(checkpoint => checkpoint.runId === BULK_RUN);
    expect(firstClaim).toHaveLength(500);

    // Leave the first batch waiting, as if every Redis delivery failed. Its
    // durable lease must still let the unclaimed tail advance immediately.
    const secondClaim = (await claimDueWaitingCheckpoints(sweepAt, 500))
      .filter(checkpoint => checkpoint.runId === BULK_RUN);
    expect(secondClaim).toEqual([{
      runId: BULK_RUN,
      nodeId: "blocked-0500",
      kind: "timer",
      targetAt: overdueAt,
    }]);

    const leased = await db
      .select({ status: runNodes.status, repairAfter: runNodes.waitingRepairAfter })
      .from(runNodes)
      .where(eq(runNodes.runId, BULK_RUN));
    expect(leased).toHaveLength(501);
    expect(leased.every(row => row.status === "waiting" && row.repairAfter?.getTime() === sweepAt.getTime() + 120_000))
      .toBe(true);
  });
});

function waitingRow(runId: string, nodeId: string, waiting: Record<string, unknown>) {
  return {
    id: `${runId}-${nodeId}`,
    runId,
    nodeId,
    status: "waiting" as const,
    stateJson: { waiting },
  };
}
