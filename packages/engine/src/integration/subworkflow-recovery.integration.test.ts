/** Real-Postgres coverage for version selection and failed-parent reattachment. */

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, runEvents, runNodes, runs, workflows, workflowVersions } from "@janusly/db";
import {
  claimDueQueuePublicationRepairs,
  claimDueParentNotifications,
  claimNodeForExecution,
  failWaitingSubworkflowNode,
  markQueuePublicationSucceeded,
  notifyCommittedRunTerminal,
  reattachFailedSubworkflowNode,
  tryClaimNodeForQueue,
  updateRunStatusFromNodes,
} from "../persistence";
import { executeNode } from "../execute-node";
import {
  computeSubworkflowDepth,
  loadWorkflowVersion,
  notifyParentOnTerminal,
} from "../subworkflow";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-subworkflow-recovery-${TAG}`;
const ACTIVE_WORKFLOW = `${TAG}-active`;
const DELETED_WORKFLOW = `${TAG}-deleted`;
const VALIDATION_CHILD_WORKFLOW = `${TAG}-validation-child`;
const dynamicRunIds: string[] = [];
const RUN_IDS = [
  `${TAG}-reopen`,
  `${TAG}-siblings`,
  `${TAG}-stale`,
  `${TAG}-failure`,
  `${TAG}-notifier-parent`,
  `${TAG}-notifier-child`,
  `${TAG}-concurrent-parent`,
  `${TAG}-concurrent-child`,
  `${TAG}-handoff-rollback`,
  `${TAG}-consumed-queue`,
  `${TAG}-large-failure`,
  `${TAG}-failed-waiting-parent`,
  `${TAG}-successful-waiting-child`,
  `${TAG}-legacy-attempt`,
  `${TAG}-snapshot-dedup`,
  `${TAG}-terminal-success-parent`,
  `${TAG}-terminal-success-child`,
  `${TAG}-terminal-failure-parent`,
  `${TAG}-terminal-failure-child`,
  `${TAG}-superseded-parent`,
  `${TAG}-superseded-child`,
  `${TAG}-terminal-siblings-parent`,
  `${TAG}-terminal-sibling-child-a`,
  `${TAG}-terminal-sibling-child-b`,
  `${TAG}-immediate-parent`,
  `${TAG}-immediate-child`,
  `${TAG}-validation-source`,
  `${TAG}-validation-fork`,
  `${TAG}-depth-ancestor`,
  `${TAG}-depth-source`,
  `${TAG}-validation-parent`,
];

function workflowDag(id: string, marker: string) {
  return {
    id,
    nodes: [{ id: marker, type: "noop" as const, config: {} }],
    edges: [],
  };
}

afterAll(async () => {
  const cleanupRunIds = [...RUN_IDS, ...dynamicRunIds];
  await db.delete(runEvents).where(inArray(runEvents.runId, cleanupRunIds));
  await db.delete(runNodes).where(inArray(runNodes.runId, cleanupRunIds));
  await db.delete(runs).where(eq(runs.orgId, ORG));
  await db.delete(workflowVersions).where(eq(workflowVersions.orgId, ORG));
  await db.delete(workflows).where(eq(workflows.orgId, ORG));
});

describe("loadWorkflowVersion (real Postgres)", () => {
  it("selects latest by default, exact when pinned, and excludes tombstones", async () => {
    await db.insert(workflows).values([
      { id: ACTIVE_WORKFLOW, orgId: ORG, name: "Active child" },
      { id: DELETED_WORKFLOW, orgId: ORG, name: "Deleted child", deletedAt: new Date() },
    ]);
    await db.insert(workflowVersions).values([
      { id: `${ACTIVE_WORKFLOW}-v1`, orgId: ORG, workflowId: ACTIVE_WORKFLOW, version: 1, dagJson: workflowDag(ACTIVE_WORKFLOW, "v1") },
      { id: `${ACTIVE_WORKFLOW}-v2`, orgId: ORG, workflowId: ACTIVE_WORKFLOW, version: 2, dagJson: workflowDag(ACTIVE_WORKFLOW, "v2") },
      { id: `${DELETED_WORKFLOW}-v1`, orgId: ORG, workflowId: DELETED_WORKFLOW, version: 1, dagJson: workflowDag(DELETED_WORKFLOW, "deleted") },
    ]);

    await expect(loadWorkflowVersion(ACTIVE_WORKFLOW, ORG)).resolves.toMatchObject({
      version: 2,
      versionId: `${ACTIVE_WORKFLOW}-v2`,
      workflow: { nodes: [{ id: "v2" }] },
    });
    await expect(loadWorkflowVersion(ACTIVE_WORKFLOW, ORG, 1)).resolves.toMatchObject({
      version: 1,
      versionId: `${ACTIVE_WORKFLOW}-v1`,
      workflow: { nodes: [{ id: "v1" }] },
    });
    await expect(loadWorkflowVersion(ACTIVE_WORKFLOW, ORG, 99)).resolves.toBeNull();
    await expect(loadWorkflowVersion(ACTIVE_WORKFLOW, `${ORG}-other`)).resolves.toBeNull();
    await expect(loadWorkflowVersion(DELETED_WORKFLOW, ORG)).resolves.toBeNull();
  });
});

describe("reattachFailedSubworkflowNode (real Postgres)", () => {
  it("repairs the exact child generation and reopens a parent with no other failures", async () => {
    const runId = RUN_IDS[0]!;
    const childRunId = `${TAG}-child-recovered`;
    await db.insert(runs).values([
      {
        id: runId,
        orgId: ORG,
        workflowVersionId: `${runId}-version`,
        status: "failed",
        parentNotificationAfter: new Date(0),
      },
      { id: childRunId, orgId: ORG, workflowVersionId: `${childRunId}-version`, status: "succeeded" },
    ]);
    await db.insert(runNodes).values([
      {
        id: `${runId}-subworkflow`,
        runId,
        nodeId: "call-child",
        status: "failed",
        errorJson: { reason: "Subworkflow failed", childRunId },
      },
      { id: `${runId}-next`, runId, nodeId: "next", status: "pending" },
    ]);

    await expect(reattachFailedSubworkflowNode(runId, "call-child", childRunId, { result: "ok" }))
      .resolves.toEqual({ completed: true, reopened: true, readyToContinue: true, remainingFailedNodes: 0 });

    const [run] = await db
      .select({ status: runs.status, parentNotificationAfter: runs.parentNotificationAfter })
      .from(runs)
      .where(eq(runs.id, runId));
    const [node] = await db
      .select({ status: runNodes.status, stateJson: runNodes.stateJson, errorJson: runNodes.errorJson })
      .from(runNodes)
      .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, "call-child")));
    const [next] = await db
      .select({ repairAfter: runNodes.queuePublicationRepairAfter })
      .from(runNodes)
      .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, "next")));
    const events = await db
      .select({ type: runEvents.type })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));
    expect(run?.status).toBe("running");
    expect(run?.parentNotificationAfter).toBeNull();
    expect(node).toMatchObject({ status: "succeeded", stateJson: { output: { result: "ok" } }, errorJson: null });
    expect(next?.repairAfter).toBeInstanceOf(Date);
    await expect(tryClaimNodeForQueue(runId, "next", 1)).resolves.toEqual({
      attempt: 1,
      recoveryClaimToken: null,
      publicationGeneration: 1,
    });
    await expect(markQueuePublicationSucceeded(runId, "next", 1, 1)).resolves.toBe(true);
    expect(events.map((event) => event.type).sort()).toEqual(["node.subworkflow.reattached", "run.reopened"]);
  });

  it("retains repaired output but keeps the parent failed while a sibling failure remains", async () => {
    const runId = RUN_IDS[1]!;
    const childRunId = `${TAG}-child-one-of-two`;
    await db.insert(runs).values([
      { id: runId, orgId: ORG, workflowVersionId: `${runId}-version`, status: "failed" },
      { id: childRunId, orgId: ORG, workflowVersionId: `${childRunId}-version`, status: "succeeded" },
    ]);
    await db.insert(runNodes).values([
      {
        id: `${runId}-subworkflow`,
        runId,
        nodeId: "call-child",
        status: "failed",
        errorJson: { childRunId },
      },
      { id: `${runId}-sibling`, runId, nodeId: "sibling", status: "failed", errorJson: { message: "still broken" } },
    ]);

    await expect(reattachFailedSubworkflowNode(runId, "call-child", childRunId, { result: "repaired" }))
      .resolves.toEqual({ completed: true, reopened: false, readyToContinue: false, remainingFailedNodes: 1 });

    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    const events = await db.select({ type: runEvents.type }).from(runEvents).where(eq(runEvents.runId, runId));
    expect(run?.status).toBe("failed");
    expect(events).toEqual([{ type: "node.subworkflow.reattached" }]);
  });

  it("rejects a stale child id without mutating the failed parent", async () => {
    const runId = RUN_IDS[2]!;
    await db.insert(runs).values({ id: runId, orgId: ORG, workflowVersionId: `${runId}-version`, status: "failed" });
    await db.insert(runNodes).values({
      id: `${runId}-subworkflow`,
      runId,
      nodeId: "call-child",
      status: "failed",
      errorJson: { childRunId: `${TAG}-current-child` },
    });

    await expect(reattachFailedSubworkflowNode(runId, "call-child", `${TAG}-stale-child`, { stale: true }))
      .resolves.toEqual({ completed: false, reopened: false, readyToContinue: false, remainingFailedNodes: 0 });

    const [node] = await db
      .select({ status: runNodes.status, errorJson: runNodes.errorJson })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    expect(node).toMatchObject({ status: "failed", errorJson: { childRunId: `${TAG}-current-child` } });
  });

  it("serializes concurrent sibling completions and reopens exactly once", async () => {
    const runId = RUN_IDS[8]!;
    const childA = `${TAG}-child-concurrent-a`;
    const childB = `${TAG}-child-concurrent-b`;
    await db.insert(runs).values([
      { id: runId, orgId: ORG, workflowVersionId: `${runId}-version`, status: "failed" },
      { id: childA, orgId: ORG, workflowVersionId: `${childA}-version`, status: "succeeded" },
      { id: childB, orgId: ORG, workflowVersionId: `${childB}-version`, status: "succeeded" },
    ]);
    await db.insert(runNodes).values([
      {
        id: `${runId}-subworkflow-a`,
        runId,
        nodeId: "call-child-a",
        status: "failed",
        errorJson: { childRunId: childA },
      },
      {
        id: `${runId}-subworkflow-b`,
        runId,
        nodeId: "call-child-b",
        status: "failed",
        errorJson: { childRunId: childB },
      },
    ]);

    const results = await Promise.all([
      reattachFailedSubworkflowNode(runId, "call-child-a", childA, { result: "a" }),
      reattachFailedSubworkflowNode(runId, "call-child-b", childB, { result: "b" }),
    ]);

    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    const nodes = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    const events = await db
      .select({ type: runEvents.type })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ completed: true, reopened: false, remainingFailedNodes: 1 }),
      expect.objectContaining({ completed: true, reopened: true, remainingFailedNodes: 0 }),
    ]));
    expect(run?.status).toBe("running");
    expect(nodes).toEqual([{ status: "succeeded" }, { status: "succeeded" }]);
    expect(events.filter(event => event.type === "run.reopened")).toHaveLength(1);
  });
});

describe("failWaitingSubworkflowNode child diagnostics (real Postgres)", () => {
  it("copies the child node id and persisted error into the parent failure", async () => {
    const runId = RUN_IDS[3]!;
    const childRunId = `${TAG}-failed-child`;
    await db.insert(runs).values([
      { id: runId, orgId: ORG, workflowVersionId: `${runId}-version`, status: "running" },
      { id: childRunId, orgId: ORG, workflowVersionId: `${childRunId}-version`, status: "failed" },
    ]);
    await db.insert(runNodes).values({
      id: `${runId}-subworkflow`,
      runId,
      nodeId: "call-child",
      status: "waiting",
      stateJson: { waiting: { kind: "subworkflow", childRunId } },
    });

    await expect(failWaitingSubworkflowNode(
      runId,
      "call-child",
      childRunId,
      "failed",
      { nodeId: "charge-card", error: { message: "Card declined", code: "card_declined" } },
    )).resolves.toBe(true);

    const [node] = await db
      .select({ errorJson: runNodes.errorJson })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    expect(node?.errorJson).toMatchObject({
      reason: "Subworkflow failed",
      message: "Card declined",
      childRunId,
      childNodeId: "charge-card",
      childError: { message: "Card declined", code: "card_declined" },
    });
  });

  it("keeps the child generation identity when a large diagnostic is truncated", async () => {
    const runId = RUN_IDS[10]!;
    const childRunId = `${TAG}-large-failed-child`;
    await db.insert(runs).values([
      { id: runId, orgId: ORG, workflowVersionId: `${runId}-version`, status: "running" },
      { id: childRunId, orgId: ORG, workflowVersionId: `${childRunId}-version`, status: "failed" },
    ]);
    await db.insert(runNodes).values({
      id: `${runId}-subworkflow`,
      runId,
      nodeId: "call-child",
      status: "waiting",
      stateJson: { waiting: { kind: "subworkflow", childRunId } },
    });

    await expect(failWaitingSubworkflowNode(
      runId,
      "call-child",
      childRunId,
      "failed",
      { nodeId: "large-child-node", error: { message: "m".repeat(100_000), details: "x".repeat(100_000) } },
    )).resolves.toBe(true);

    const [node] = await db
      .select({ errorJson: runNodes.errorJson })
      .from(runNodes)
      .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, "call-child")));
    expect(node?.errorJson).toMatchObject({
      childRunId,
      childNodeId: "large-child-node",
      childError: { __truncated: true },
    });
    expect((node?.errorJson as { message?: string } | null)?.message).toHaveLength(4_000);
  });

  it("selects the earliest failed child node when notifying the parent", async () => {
    const parentRunId = RUN_IDS[4]!;
    const childRunId = RUN_IDS[5]!;
    await db.insert(runs).values([
      { id: parentRunId, orgId: ORG, workflowVersionId: `${parentRunId}-version`, status: "running" },
      {
        id: childRunId,
        orgId: ORG,
        workflowVersionId: `${childRunId}-version`,
        status: "failed",
        parentRunId,
        parentNodeId: "call-child",
        parentLinkKind: "subworkflow",
      },
    ]);
    await db.insert(runNodes).values([
      {
        id: `${parentRunId}-subworkflow`,
        runId: parentRunId,
        nodeId: "call-child",
        status: "waiting",
        stateJson: { waiting: { kind: "subworkflow", childRunId } },
      },
      {
        id: `${childRunId}-later`,
        runId: childRunId,
        nodeId: "later-failure",
        status: "failed",
        errorJson: { message: "secondary" },
        finishedAt: new Date("2026-07-15T12:00:02.000Z"),
      },
      {
        id: `${childRunId}-root`,
        runId: childRunId,
        nodeId: "root-failure",
        status: "failed",
        errorJson: { message: "root cause" },
        finishedAt: new Date("2026-07-15T12:00:01.000Z"),
      },
    ]);

    await notifyParentOnTerminal(childRunId, "failed");

    const [parentNode] = await db
      .select({ errorJson: runNodes.errorJson })
      .from(runNodes)
      .where(and(eq(runNodes.runId, parentRunId), eq(runNodes.nodeId, "call-child")));
    const [parentRun] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, parentRunId));
    expect(parentNode?.errorJson).toMatchObject({
      message: "root cause",
      childNodeId: "root-failure",
      childError: { message: "root cause" },
    });
    expect(parentRun?.status).toBe("failed");
  });

  it("reattaches after a sibling replay has already put the parent back in running", async () => {
    const parentRunId = RUN_IDS[6]!;
    const childRunId = RUN_IDS[7]!;
    const parentWorkflow = {
      id: `${TAG}-concurrent-parent-workflow`,
      nodes: [{ id: "call-child", type: "subworkflow" as const, config: { workflowId: ACTIVE_WORKFLOW } }],
      edges: [],
    };
    await db.insert(runs).values([
      {
        id: parentRunId,
        orgId: ORG,
        workflowVersionId: `${parentRunId}-version`,
        status: "running",
        inputJson: { workflow: parentWorkflow },
      },
      {
        id: childRunId,
        orgId: ORG,
        workflowVersionId: `${childRunId}-version`,
        status: "succeeded",
        outputJson: { result: "recovered" },
        parentRunId,
        parentNodeId: "call-child",
        parentLinkKind: "subworkflow",
      },
    ]);
    await db.insert(runNodes).values({
      id: `${parentRunId}-subworkflow`,
      runId: parentRunId,
      nodeId: "call-child",
      status: "failed",
      errorJson: { childRunId },
    });

    await notifyParentOnTerminal(childRunId, "succeeded");

    const [parent] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, parentRunId));
    const [node] = await db
      .select({ status: runNodes.status, stateJson: runNodes.stateJson })
      .from(runNodes)
      .where(and(eq(runNodes.runId, parentRunId), eq(runNodes.nodeId, "call-child")));
    expect(parent?.status).toBe("succeeded");
    expect(node).toMatchObject({ status: "succeeded", stateJson: { output: { result: "recovered" } } });
  });

  it("retains a late child success while the parent stays failed on a sibling", async () => {
    const parentRunId = RUN_IDS[11]!;
    const childRunId = RUN_IDS[12]!;
    await db.insert(runs).values([
      { id: parentRunId, orgId: ORG, workflowVersionId: `${parentRunId}-version`, status: "failed" },
      {
        id: childRunId,
        orgId: ORG,
        workflowVersionId: `${childRunId}-version`,
        status: "succeeded",
        outputJson: { result: "late-success" },
        parentRunId,
        parentNodeId: "call-child",
        parentLinkKind: "subworkflow",
      },
    ]);
    await db.insert(runNodes).values([
      {
        id: `${parentRunId}-subworkflow`,
        runId: parentRunId,
        nodeId: "call-child",
        status: "waiting",
        stateJson: { waiting: { kind: "subworkflow", childRunId } },
      },
      { id: `${parentRunId}-sibling`, runId: parentRunId, nodeId: "sibling", status: "failed" },
    ]);

    await notifyParentOnTerminal(childRunId, "succeeded");

    const [parent] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, parentRunId));
    const [node] = await db
      .select({ status: runNodes.status, stateJson: runNodes.stateJson })
      .from(runNodes)
      .where(and(eq(runNodes.runId, parentRunId), eq(runNodes.nodeId, "call-child")));
    expect(parent?.status).toBe("failed");
    expect(node).toMatchObject({ status: "succeeded", stateJson: { output: { result: "late-success" } } });
  });
});

describe("failed-run queue consumption (real Postgres)", () => {
  it("restores only the exact recovery generation and exposes it to the durable repair sweep", async () => {
    const runId = RUN_IDS[9]!;
    await db.insert(runs).values({ id: runId, orgId: ORG, workflowVersionId: `${runId}-version`, status: "failed" });
    await db.insert(runNodes).values({
      id: `${runId}-consumed`,
      runId,
      nodeId: "consumed",
      status: "queued",
      attempts: 1,
      recoveryClaimToken: "current-generation",
      queuePublicationGeneration: 7,
    });

    await expect(claimNodeForExecution(runId, "consumed", 1, "current-generation", 6))
      .resolves.toBe("run_failed");
    let [node] = await db
      .select({ status: runNodes.status, repairAfter: runNodes.queuePublicationRepairAfter })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    expect(node).toMatchObject({ status: "queued", repairAfter: null });

    await expect(claimNodeForExecution(runId, "consumed", 1, "current-generation", 7))
      .resolves.toBe("run_failed");
    [node] = await db
      .select({ status: runNodes.status, repairAfter: runNodes.queuePublicationRepairAfter })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    expect(node?.status).toBe("pending");
    expect(node?.repairAfter).toBeInstanceOf(Date);

    await db.update(runs).set({ status: "running" }).where(eq(runs.id, runId));
    const due = await claimDueQueuePublicationRepairs(new Date(Date.now() + 1_000), 10, 60_000);
    expect(due.filter((repair) => repair.runId === runId)).toEqual([expect.objectContaining({
      runId,
      nodeId: "consumed",
      status: "pending",
      attempt: 1,
      recoveryClaimToken: "current-generation",
      publicationGeneration: 7,
    })]);

    await expect(tryClaimNodeForQueue(runId, "consumed", 1)).resolves.toEqual({
      attempt: 1,
      recoveryClaimToken: "current-generation",
      publicationGeneration: 8,
    });
  });

  it("rejects a stale legacy generation-zero job from an older retry attempt", async () => {
    const runId = RUN_IDS[13]!;
    await db.insert(runs).values({
      id: runId,
      orgId: ORG,
      workflowVersionId: `${runId}-version`,
      status: "running",
    });
    await db.insert(runNodes).values({
      id: `${runId}-queued`,
      runId,
      nodeId: "legacy",
      status: "queued",
      attempts: 2,
      queuePublicationGeneration: 0,
    });

    await expect(claimNodeForExecution(runId, "legacy", 1, undefined, 0))
      .resolves.toBe("not_claimed");
    const [node] = await db
      .select({ status: runNodes.status, attempts: runNodes.attempts })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    expect(node).toMatchObject({ status: "queued", attempts: 2 });
  });

  it("claims compact pending identities without materializing workflow snapshots", async () => {
    const runId = RUN_IDS[14]!;
    const workflow = {
      dslVersion: "1.0",
      nodes: [
        { id: "root", type: "noop", config: {} },
        { id: "next", type: "noop", config: {} },
      ],
      edges: [{ from: "root", to: "next" }],
    };
    await db.insert(runs).values({
      id: runId,
      orgId: ORG,
      workflowVersionId: `${runId}-version`,
      status: "running",
      inputJson: { workflow },
    });
    await db.insert(runNodes).values([
      {
        id: `${runId}-root`,
        runId,
        nodeId: "root",
        status: "pending",
        queuePublicationRepairAfter: new Date(0),
      },
      {
        id: `${runId}-next`,
        runId,
        nodeId: "next",
        status: "pending",
        queuePublicationRepairAfter: new Date(0),
      },
    ]);

    const repairs = (await claimDueQueuePublicationRepairs(new Date(), 500, 60_000))
      .filter((repair) => repair.runId === runId);
    expect(repairs).toHaveLength(2);
    expect(repairs.every((repair) => !("workflow" in repair))).toBe(true);
  });
});

describe("durable terminal child handoff (real Postgres)", () => {
  it("inherits validation mode across executable child links without inheriting replay depth", async () => {
    const ancestorRunId = RUN_IDS[28]!;
    const sourceRunId = RUN_IDS[29]!;
    const validationParentRunId = RUN_IDS[30]!;
    const childWorkflow = {
      dslVersion: "1.0" as const,
      id: VALIDATION_CHILD_WORKFLOW,
      nodes: [{
        id: "write",
        type: "http" as const,
        config: {
          url: "https://write-should-not-run.invalid",
          method: "POST",
          body: "must stay inside the sandbox",
        },
      }],
      edges: [],
    };
    const parentWorkflow = {
      dslVersion: "1.0" as const,
      nodes: [{
        id: "call-child",
        type: "subworkflow" as const,
        config: { workflowId: VALIDATION_CHILD_WORKFLOW },
      }],
      edges: [],
    };

    await db.insert(workflows).values({
      id: VALIDATION_CHILD_WORKFLOW,
      orgId: ORG,
      name: "Validation child",
    });
    await db.insert(workflowVersions).values({
      id: `${VALIDATION_CHILD_WORKFLOW}-v1`,
      orgId: ORG,
      workflowId: VALIDATION_CHILD_WORKFLOW,
      version: 1,
      dagJson: childWorkflow,
    });
    await db.insert(runs).values([
      {
        id: ancestorRunId,
        orgId: ORG,
        workflowVersionId: `${ancestorRunId}-version`,
        status: "failed",
      },
      {
        id: sourceRunId,
        orgId: ORG,
        workflowVersionId: `${sourceRunId}-version`,
        status: "failed",
        parentRunId: ancestorRunId,
        parentNodeId: "source-child",
        parentLinkKind: "subworkflow",
      },
      {
        id: validationParentRunId,
        orgId: ORG,
        workflowVersionId: `${validationParentRunId}-version`,
        status: "running",
        replayMode: "validation",
        inputJson: { workflow: parentWorkflow, input: {} },
        parentRunId: sourceRunId,
        parentNodeId: "trace-source-node",
        parentLinkKind: "replay",
      },
    ]);
    await db.insert(runNodes).values({
      id: `${validationParentRunId}-call-child`,
      runId: validationParentRunId,
      nodeId: "call-child",
      status: "running",
    });

    await expect(computeSubworkflowDepth(sourceRunId)).resolves.toBe(1);
    await expect(computeSubworkflowDepth(validationParentRunId)).resolves.toBe(0);
    await expect(executeNode({
      runId: validationParentRunId,
      node: parentWorkflow.nodes[0]!,
    })).resolves.toMatchObject({ status: "waiting", checkpointPersisted: true });

    const [child] = await db
      .select({
        id: runs.id,
        replayMode: runs.replayMode,
        parentLinkKind: runs.parentLinkKind,
      })
      .from(runs)
      .where(and(
        eq(runs.parentRunId, validationParentRunId),
        eq(runs.parentLinkKind, "subworkflow"),
      ))
      .limit(1);
    expect(child).toMatchObject({
      replayMode: "validation",
      parentLinkKind: "subworkflow",
    });
    if (!child) throw new Error("Expected validation subworkflow child");
    dynamicRunIds.push(child.id);
    await expect(computeSubworkflowDepth(child.id)).resolves.toBe(1);

    const childResult = await executeNode({ runId: child.id, node: childWorkflow.nodes[0]! });
    expect(childResult).toMatchObject({
      status: "succeeded",
      output: { statusCode: 0, ok: true, body: null, dryRun: true },
    });
    if (childResult.status !== "succeeded") throw new Error("Expected dry-run child success");
    await db.update(runNodes)
      .set({
        status: "succeeded",
        stateJson: { output: childResult.output },
        finishedAt: new Date(),
      })
      .where(and(eq(runNodes.runId, child.id), eq(runNodes.nodeId, "write")));

    await expect(updateRunStatusFromNodes(child.id)).resolves.toBe("succeeded");

    const [terminalChild] = await db
      .select({ status: runs.status, parentNotificationAfter: runs.parentNotificationAfter })
      .from(runs)
      .where(eq(runs.id, child.id));
    const [terminalParent] = await db
      .select({ status: runs.status, parentNotificationAfter: runs.parentNotificationAfter })
      .from(runs)
      .where(eq(runs.id, validationParentRunId));
    const [parentNode] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(and(eq(runNodes.runId, validationParentRunId), eq(runNodes.nodeId, "call-child")));
    expect(terminalChild).toEqual({ status: "succeeded", parentNotificationAfter: null });
    expect(terminalParent).toEqual({ status: "succeeded", parentNotificationAfter: null });
    expect(parentNode?.status).toBe("succeeded");
  });

  it("blocks sibling replay reopening until a delayed terminal failure handoff settles", async () => {
    const parentRunId = RUN_IDS[21]!;
    const childA = RUN_IDS[22]!;
    const childB = RUN_IDS[23]!;
    await db.insert(runs).values([
      {
        id: parentRunId,
        orgId: ORG,
        workflowVersionId: `${parentRunId}-version`,
        status: "failed",
      },
      {
        id: childA,
        orgId: ORG,
        workflowVersionId: `${childA}-version`,
        status: "succeeded",
        outputJson: { result: "repaired" },
        parentRunId,
        parentNodeId: "call-child-a",
        parentLinkKind: "subworkflow",
      },
      {
        id: childB,
        orgId: ORG,
        workflowVersionId: `${childB}-version`,
        status: "failed",
        parentRunId,
        parentNodeId: "call-child-b",
        parentLinkKind: "subworkflow",
      },
    ]);
    await db.insert(runNodes).values([
      {
        id: `${parentRunId}-call-child-a`,
        runId: parentRunId,
        nodeId: "call-child-a",
        status: "failed",
        errorJson: { reason: "Subworkflow failed", childRunId: childA },
      },
      {
        id: `${parentRunId}-call-child-b`,
        runId: parentRunId,
        nodeId: "call-child-b",
        status: "waiting",
        stateJson: { waiting: { kind: "subworkflow", childRunId: childB } },
      },
    ]);

    await expect(reattachFailedSubworkflowNode(
      parentRunId,
      "call-child-a",
      childA,
      { result: "repaired" },
    )).resolves.toEqual({
      completed: true,
      reopened: false,
      readyToContinue: false,
      remainingFailedNodes: 1,
    });

    let [parent] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, parentRunId));
    let [delayedSibling] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(and(eq(runNodes.runId, parentRunId), eq(runNodes.nodeId, "call-child-b")));
    expect(parent?.status).toBe("failed");
    expect(delayedSibling?.status).toBe("waiting");

    await expect(notifyParentOnTerminal(childB, "failed")).resolves.toBe(true);

    [parent] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, parentRunId));
    [delayedSibling] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(and(eq(runNodes.runId, parentRunId), eq(runNodes.nodeId, "call-child-b")));
    expect(parent?.status).toBe("failed");
    expect(delayedSibling?.status).toBe("failed");
  });

  it("acknowledges the exact immediate terminal marker without a repair sweep", async () => {
    const parentRunId = RUN_IDS[24]!;
    const childRunId = RUN_IDS[25]!;
    const parentWorkflow = {
      dslVersion: "1.0" as const,
      nodes: [{ id: "call-child", type: "subworkflow" as const, config: { workflowId: ACTIVE_WORKFLOW } }],
      edges: [],
    };
    await db.insert(runs).values([
      {
        id: parentRunId,
        orgId: ORG,
        workflowVersionId: `${parentRunId}-version`,
        status: "running",
        inputJson: { workflow: parentWorkflow },
      },
      {
        id: childRunId,
        orgId: ORG,
        workflowVersionId: `${childRunId}-version`,
        status: "running",
        outputJson: { result: "immediate" },
        parentRunId,
        parentNodeId: "call-child",
        parentLinkKind: "subworkflow",
      },
    ]);
    await db.insert(runNodes).values([
      {
        id: `${parentRunId}-call-child`,
        runId: parentRunId,
        nodeId: "call-child",
        status: "waiting",
        stateJson: { waiting: { kind: "subworkflow", childRunId } },
      },
      {
        id: `${childRunId}-root`,
        runId: childRunId,
        nodeId: "root",
        status: "succeeded",
        stateJson: { output: { result: "immediate" } },
      },
    ]);

    await expect(updateRunStatusFromNodes(childRunId)).resolves.toBe("succeeded");

    const [child] = await db
      .select({ status: runs.status, parentNotificationAfter: runs.parentNotificationAfter })
      .from(runs)
      .where(eq(runs.id, childRunId));
    const [parent] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, parentRunId));
    const [parentNode] = await db
      .select({ status: runNodes.status, stateJson: runNodes.stateJson })
      .from(runNodes)
      .where(and(eq(runNodes.runId, parentRunId), eq(runNodes.nodeId, "call-child")));
    expect(child).toEqual({ status: "succeeded", parentNotificationAfter: null });
    expect(parent?.status).toBe("succeeded");
    expect(parentNode).toMatchObject({
      status: "succeeded",
      stateJson: {
        output: {},
        subworkflow: { childRunId },
      },
    });
  });

  it("keeps validation-fork lineage out of the subworkflow terminal outbox", async () => {
    const sourceRunId = RUN_IDS[26]!;
    const forkRunId = RUN_IDS[27]!;
    await db.insert(runs).values([
      {
        id: sourceRunId,
        orgId: ORG,
        workflowVersionId: `${sourceRunId}-version`,
        status: "running",
      },
      {
        id: forkRunId,
        orgId: ORG,
        workflowVersionId: `${forkRunId}-version`,
        status: "running",
        replayMode: "validation",
        parentRunId: sourceRunId,
        parentNodeId: "trace-source-node",
        parentLinkKind: "replay",
      },
    ]);
    await db.insert(runNodes).values({
      id: `${forkRunId}-root`,
      runId: forkRunId,
      nodeId: "root",
      status: "succeeded",
    });

    await expect(updateRunStatusFromNodes(forkRunId)).resolves.toBe("succeeded");

    const [fork] = await db
      .select({ status: runs.status, parentNotificationAfter: runs.parentNotificationAfter })
      .from(runs)
      .where(eq(runs.id, forkRunId));
    const [source] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, sourceRunId));
    expect(fork).toEqual({ status: "succeeded", parentNotificationAfter: null });
    expect(source?.status).toBe("running");

    // Legacy/stale rows remain excluded from claims even if they carry a marker.
    await db.update(runs)
      .set({ parentNotificationAfter: new Date(0) })
      .where(eq(runs.id, forkRunId));
    const claimed = await claimDueParentNotifications(new Date(), 500, 60_000);
    expect(claimed.some(notification => notification.runId === forkRunId)).toBe(false);
  });

  it("leases a crashed legacy success handoff, repairs readiness, and acknowledges the marker", async () => {
    const parentRunId = RUN_IDS[15]!;
    const childRunId = RUN_IDS[16]!;
    const parentWorkflow = {
      dslVersion: "1.0" as const,
      nodes: [
        { id: "call-child", type: "subworkflow" as const, config: { workflowId: ACTIVE_WORKFLOW } },
        { id: "next", type: "noop" as const, config: {} },
      ],
      edges: [{ from: "call-child", to: "next" }],
    };
    await db.insert(runs).values([
      {
        id: parentRunId,
        orgId: ORG,
        workflowVersionId: `${parentRunId}-version`,
        status: "running",
        inputJson: { workflow: parentWorkflow },
      },
      {
        id: childRunId,
        orgId: ORG,
        workflowVersionId: `${childRunId}-version`,
        status: "succeeded",
        outputJson: { result: "durable" },
        parentRunId,
        parentNodeId: "call-child",
        parentNotificationAfter: new Date(0),
      },
    ]);
    await db.insert(runNodes).values([
      {
        id: `${parentRunId}-call-child`,
        runId: parentRunId,
        nodeId: "call-child",
        status: "succeeded",
        stateJson: {
          output: { result: "durable" },
          subworkflow: { childRunId },
        },
      },
      { id: `${parentRunId}-next`, runId: parentRunId, nodeId: "next", status: "pending" },
    ]);

    const due = (await claimDueParentNotifications(new Date(), 10, 60_000))
      .filter(notification => notification.runId === childRunId);
    expect(due).toEqual([expect.objectContaining({
      runId: childRunId,
      status: "succeeded",
      leaseUntil: expect.any(Date),
    })]);
    const leasedAgain = (await claimDueParentNotifications(new Date(), 10, 60_000))
      .filter(notification => notification.runId === childRunId);
    expect(leasedAgain).toEqual([]);

    await expect(notifyCommittedRunTerminal(childRunId, "succeeded", due[0]!.leaseUntil)).resolves.toBe(true);

    const [child] = await db
      .select({ parentNotificationAfter: runs.parentNotificationAfter })
      .from(runs)
      .where(eq(runs.id, childRunId));
    const [next] = await db
      .select({ status: runNodes.status, repairAfter: runNodes.queuePublicationRepairAfter })
      .from(runNodes)
      .where(and(eq(runNodes.runId, parentRunId), eq(runNodes.nodeId, "next")));
    expect(child?.parentNotificationAfter).toBeNull();
    expect(next).toMatchObject({ status: "queued", repairAfter: null });
  });

  it("repairs a crash after parent-node failure but before the parent run rollup", async () => {
    const parentRunId = RUN_IDS[17]!;
    const childRunId = RUN_IDS[18]!;
    await db.insert(runs).values([
      {
        id: parentRunId,
        orgId: ORG,
        workflowVersionId: `${parentRunId}-version`,
        status: "running",
      },
      {
        id: childRunId,
        orgId: ORG,
        workflowVersionId: `${childRunId}-version`,
        status: "failed",
        parentRunId,
        parentNodeId: "call-child",
        parentLinkKind: "subworkflow",
        parentNotificationAfter: new Date(0),
      },
    ]);
    await db.insert(runNodes).values({
      id: `${parentRunId}-call-child`,
      runId: parentRunId,
      nodeId: "call-child",
      status: "failed",
      errorJson: { reason: "Subworkflow failed", childRunId },
    });

    const due = (await claimDueParentNotifications(new Date(), 10, 60_000))
      .filter(notification => notification.runId === childRunId);
    expect(due).toEqual([expect.objectContaining({
      runId: childRunId,
      status: "failed",
      leaseUntil: expect.any(Date),
    })]);
    await expect(notifyCommittedRunTerminal(childRunId, "failed", due[0]!.leaseUntil)).resolves.toBe(true);

    const [parent] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, parentRunId));
    const [child] = await db
      .select({ parentNotificationAfter: runs.parentNotificationAfter })
      .from(runs)
      .where(eq(runs.id, childRunId));
    expect(parent?.status).toBe("failed");
    expect(child?.parentNotificationAfter).toBeNull();
  });

  it("does not deliver a leased terminal status after recovery reopened the child", async () => {
    const parentRunId = RUN_IDS[19]!;
    const childRunId = RUN_IDS[20]!;
    await db.insert(runs).values([
      {
        id: parentRunId,
        orgId: ORG,
        workflowVersionId: `${parentRunId}-version`,
        status: "running",
      },
      {
        id: childRunId,
        orgId: ORG,
        workflowVersionId: `${childRunId}-version`,
        status: "running",
        parentRunId,
        parentNodeId: "call-child",
        parentLinkKind: "subworkflow",
      },
    ]);
    await db.insert(runNodes).values({
      id: `${parentRunId}-call-child`,
      runId: parentRunId,
      nodeId: "call-child",
      status: "waiting",
      stateJson: { waiting: { kind: "subworkflow", childRunId } },
    });

    await expect(notifyParentOnTerminal(childRunId, "failed")).resolves.toBe(false);

    const [parent] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, parentRunId));
    const [node] = await db
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(and(eq(runNodes.runId, parentRunId), eq(runNodes.nodeId, "call-child")));
    expect(parent?.status).toBe("running");
    expect(node?.status).toBe("waiting");
  });
});
