/** Real-Postgres coverage for workflow rollout assignment and outcome guards. */

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  auditLogs,
  db,
  runs,
  workflowRolloutOutcomes,
  workflowRollouts,
  workflows,
  workflowVersions,
} from "@janusly/db";

import {
  createWorkflowRollout,
  finishWorkflowRollout,
  getLatestWorkflowRollout,
  listUnrecordedWorkflowRolloutOutcomes,
  recordWorkflowRolloutOutcome,
  resolveWorkflowRolloutAssignment,
  softDeleteWorkflow,
  workflowRolloutBucket,
} from "../workflowRolloutsRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-rollout-${TAG}`;

function dag(workflowId: string, changed = false) {
  return {
    dslVersion: "1.0" as const,
    id: workflowId,
    name: "Invoice routing",
    nodes: [{ id: "work", type: "noop" as const, config: { changed } }],
    edges: [],
  };
}

async function seedWorkflow(workflowId: string) {
  const baselineVersionId = `${workflowId}-v1`;
  const canaryVersionId = `${workflowId}-v2`;
  await db.insert(workflows).values({
    id: workflowId,
    orgId: ORG,
    name: "Invoice routing",
    createdBy: "operator",
  });
  await db.insert(workflowVersions).values([
    {
      id: baselineVersionId,
      orgId: ORG,
      workflowId,
      version: 1,
      dagJson: dag(workflowId),
      createdBy: "operator",
    },
    {
      id: canaryVersionId,
      orgId: ORG,
      workflowId,
      version: 2,
      dagJson: dag(workflowId, true),
      createdBy: "operator",
    },
  ]);
  return { baselineVersionId, canaryVersionId };
}

afterAll(async () => {
  await db.delete(auditLogs).where(eq(auditLogs.orgId, ORG));
  await db.delete(workflowRolloutOutcomes).where(eq(workflowRolloutOutcomes.orgId, ORG));
  await db.delete(runs).where(eq(runs.orgId, ORG));
  await db.delete(workflowRollouts).where(eq(workflowRollouts.orgId, ORG));
  await db.delete(workflowVersions).where(eq(workflowVersions.orgId, ORG));
  await db.delete(workflows).where(eq(workflows.orgId, ORG));
});

describe("workflow rollouts (real Postgres)", () => {
  it("creates one active rollout and resolves stable baseline/canary assignments", async () => {
    const workflowId = `wf-assign-${TAG}`;
    const versions = await seedWorkflow(workflowId);
    const created = await createWorkflowRollout({
      orgId: ORG,
      workflowId,
      ...versions,
      trafficPercent: 25,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 80,
      createdBy: "operator",
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") throw new Error("rollout was not created");

    await expect(createWorkflowRollout({
      orgId: ORG,
      workflowId,
      ...versions,
      trafficPercent: 25,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 80,
      createdBy: "operator",
    })).resolves.toMatchObject({ kind: "active_exists" });

    const canaryKey = Array.from({ length: 1_000 }, (_, index) => `canary-${index}`)
      .find((key) => workflowRolloutBucket(created.rollout.id, key) < 25);
    const baselineKey = Array.from({ length: 1_000 }, (_, index) => `baseline-${index}`)
      .find((key) => workflowRolloutBucket(created.rollout.id, key) >= 25);
    expect(canaryKey).toBeDefined();
    expect(baselineKey).toBeDefined();

    const canary = await resolveWorkflowRolloutAssignment({ orgId: ORG, workflowId, assignmentKey: canaryKey! });
    const baseline = await resolveWorkflowRolloutAssignment({ orgId: ORG, workflowId, assignmentKey: baselineKey! });
    expect(canary).toMatchObject({ variant: "canary", versionId: versions.canaryVersionId, version: 2 });
    expect(baseline).toMatchObject({ variant: "baseline", versionId: versions.baselineVersionId, version: 1 });
  });

  it("records each run once and atomically returns traffic after an unhealthy minimum sample", async () => {
    const workflowId = `wf-guardrail-${TAG}`;
    const versions = await seedWorkflow(workflowId);
    const created = await createWorkflowRollout({
      orgId: ORG,
      workflowId,
      ...versions,
      trafficPercent: 50,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 80,
      createdBy: "operator",
    });
    if (created.kind !== "created") throw new Error("rollout was not created");

    const runIds = Array.from({ length: 5 }, (_, index) => `${workflowId}-run-${index}`);
    const mismatchedRunId = `${workflowId}-mismatched`;
    await db.insert(runs).values([...runIds.map((id, index) => ({
      id,
      orgId: ORG,
      workflowVersionId: versions.canaryVersionId,
      workflowRolloutId: created.rollout.id,
      workflowRolloutVariant: "canary" as const,
      status: "failed",
      createdAt: new Date(Date.now() + index),
    })), {
      id: mismatchedRunId,
      orgId: ORG,
      workflowVersionId: versions.canaryVersionId,
      workflowRolloutId: created.rollout.id,
      workflowRolloutVariant: "canary" as const,
      status: "succeeded",
    }]);

    await expect(recordWorkflowRolloutOutcome(mismatchedRunId, "failed"))
      .resolves.toMatchObject({ kind: "ignored" });

    for (const runId of runIds.slice(0, 4)) {
      await expect(recordWorkflowRolloutOutcome(runId, "failed"))
        .resolves.toMatchObject({ kind: "recorded", autoRolledBack: false });
    }
    await expect(recordWorkflowRolloutOutcome(runIds[4]!, "failed"))
      .resolves.toMatchObject({ kind: "recorded", autoRolledBack: true });
    await expect(recordWorkflowRolloutOutcome(runIds[4]!, "failed"))
      .resolves.toMatchObject({ kind: "ignored" });

    const rollout = await getLatestWorkflowRollout(ORG, workflowId);
    expect(rollout).toMatchObject({
      status: "rolled_back",
      canarySucceeded: 0,
      canaryFailed: 5,
      rolledBackReason: "canary_success_rate_breach",
    });
    const receipts = await db.select().from(workflowRolloutOutcomes)
      .where(eq(workflowRolloutOutcomes.rolloutId, created.rollout.id));
    expect(receipts).toHaveLength(5);
    expect(receipts.map(receipt => receipt.runId)).not.toContain(mismatchedRunId);
    const evidence = await db.select().from(auditLogs).where(and(
      eq(auditLogs.orgId, ORG),
      eq(auditLogs.action, "workflow.rollout.auto_rolled_back"),
      eq(auditLogs.targetId, created.rollout.id),
    ));
    expect(evidence).toHaveLength(1);
  });

  it("lists only unrecorded terminal production outcomes for active rollouts", async () => {
    const workflowId = `wf-repair-${TAG}`;
    const versions = await seedWorkflow(workflowId);
    const created = await createWorkflowRollout({
      orgId: ORG,
      workflowId,
      ...versions,
      trafficPercent: 20,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 80,
      createdBy: "operator",
    });
    if (created.kind !== "created") throw new Error("rollout was not created");

    await db.insert(runs).values([
      {
        id: `${workflowId}-due`,
        orgId: ORG,
        workflowVersionId: versions.baselineVersionId,
        workflowRolloutId: created.rollout.id,
        workflowRolloutVariant: "baseline",
        status: "succeeded",
      },
      {
        id: `${workflowId}-validation`,
        orgId: ORG,
        workflowVersionId: versions.baselineVersionId,
        workflowRolloutId: created.rollout.id,
        workflowRolloutVariant: "baseline",
        status: "failed",
        replayMode: "validation",
      },
      {
        id: `${workflowId}-running`,
        orgId: ORG,
        workflowVersionId: versions.canaryVersionId,
        workflowRolloutId: created.rollout.id,
        workflowRolloutVariant: "canary",
        status: "running",
      },
    ]);

    const candidates = await listUnrecordedWorkflowRolloutOutcomes(500);
    expect(candidates).toContainEqual({ runId: `${workflowId}-due`, status: "succeeded" });
    expect(candidates.map((candidate) => candidate.runId)).not.toContain(`${workflowId}-validation`);
    expect(candidates.map((candidate) => candidate.runId)).not.toContain(`${workflowId}-running`);

    await recordWorkflowRolloutOutcome(`${workflowId}-due`, "succeeded");
    expect((await listUnrecordedWorkflowRolloutOutcomes(500)).map((candidate) => candidate.runId))
      .not.toContain(`${workflowId}-due`);

    await finishWorkflowRollout({
      orgId: ORG,
      workflowId,
      rolloutId: created.rollout.id,
      decision: "promote",
    });
    expect((await listUnrecordedWorkflowRolloutOutcomes(500)).map((candidate) => candidate.runId))
      .not.toContain(`${workflowId}-validation`);
  });

  it("soft-deletes the parent and cancels its active rollout atomically", async () => {
    const workflowId = `wf-delete-${TAG}`;
    const versions = await seedWorkflow(workflowId);
    const created = await createWorkflowRollout({
      orgId: ORG,
      workflowId,
      ...versions,
      trafficPercent: 20,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 80,
      createdBy: "operator",
    });
    if (created.kind !== "created") throw new Error("rollout was not created");

    await expect(softDeleteWorkflow(ORG, workflowId)).resolves.toBe(true);
    await expect(softDeleteWorkflow(ORG, workflowId)).resolves.toBe(false);

    const [parent] = await db.select({ deletedAt: workflows.deletedAt })
      .from(workflows)
      .where(and(eq(workflows.orgId, ORG), eq(workflows.id, workflowId)));
    const [rollout] = await db.select().from(workflowRollouts)
      .where(eq(workflowRollouts.id, created.rollout.id));
    expect(parent?.deletedAt).toBeInstanceOf(Date);
    expect(rollout).toMatchObject({
      status: "cancelled",
      rolledBackReason: "workflow_deleted",
    });
    expect(rollout?.endedAt).toBeInstanceOf(Date);
  });

  it("prefers a newly active rollout over same-tick deployment history", async () => {
    const workflowId = `wf-restart-${TAG}`;
    const versions = await seedWorkflow(workflowId);
    const first = await createWorkflowRollout({
      orgId: ORG,
      workflowId,
      ...versions,
      trafficPercent: 10,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 80,
      createdBy: "operator",
    });
    if (first.kind !== "created") throw new Error("first rollout was not created");
    await finishWorkflowRollout({
      orgId: ORG,
      workflowId,
      rolloutId: first.rollout.id,
      decision: "rollback",
    });
    const second = await createWorkflowRollout({
      orgId: ORG,
      workflowId,
      ...versions,
      trafficPercent: 30,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 90,
      createdBy: "operator",
    });
    if (second.kind !== "created") throw new Error("second rollout was not created");

    await expect(getLatestWorkflowRollout(ORG, workflowId)).resolves.toMatchObject({
      id: second.rollout.id,
      status: "active",
      trafficPercent: 30,
    });
  });
});
