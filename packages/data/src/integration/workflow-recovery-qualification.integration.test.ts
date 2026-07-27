/** Real-Postgres coverage for immutable outcome qualification receipts. */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  db,
  workflowRecoveryQualifications,
  workflowRollouts,
  workflows,
  workflowVersions,
} from "@janusly/db";
import { RECOVERY_QUALIFICATION_DATASET_VERSION } from "@janusly/shared";

import {
  findWorkflowRecoveryQualification,
  recordWorkflowRecoveryQualification,
  resolveWorkflowRecoveryQualificationVersions,
} from "../workflowRecoveryQualificationsRepo";
import { createWorkflowRollout } from "../workflowRolloutsRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-recovery-qualification-${TAG}`;
const OTHER_ORG = `${ORG}-other`;

function contract() {
  return {
    version: "2" as const,
    failure: {
      technical: {
        terminalNodeFailure: true as const,
        stalledNode: true,
      },
      semantic: {
        mode: "deterministic" as const,
        detectors: [
          {
            id: "completed-outcome",
            sourceNodeId: "outcome",
            kind: "expression" as const,
            passWhen:
              'context.outcome.output.status === "completed"',
            action: "quarantine" as const,
            message: "Outcome must complete",
          },
        ],
        evaluationFixtures: [
          {
            id: "completed",
            sourceNodeId: "outcome",
            output: { status: "completed" },
            expected: "pass" as const,
          },
          {
            id: "incomplete",
            sourceNodeId: "outcome",
            output: { status: "incomplete" },
            expected: "violation" as const,
          },
        ],
      },
    },
    evidence: {
      required: [
        "failure_snapshot" as const,
        "audit_trail" as const,
        "terminal_outcome" as const,
      ],
    },
    effects: [],
    repairs: { allowed: ["retry" as const] },
    validation: { minimumEvidenceLevel: "static" as const },
    approval: {
      productionMutation: "required" as const,
      permission: "recovery.write" as const,
    },
    autonomyLevel: 0 as const,
    verification: {
      kind: "generation_bound_terminal_success" as const,
    },
    recurrence: { windowDays: 7 },
  };
}

function dag(workflowId: string, changed = false) {
  return {
    dslVersion: "1.0" as const,
    id: workflowId,
    name: "Qualified workflow",
    nodes: [
      {
        id: "outcome",
        type: "noop" as const,
        config: { changed },
      },
    ],
    edges: [],
    recovery: { contract: contract() },
  };
}

async function seedWorkflow(workflowId: string) {
  const baselineVersionId = `${workflowId}-v1`;
  const candidateVersionId = `${workflowId}-v2`;
  await db.insert(workflows).values({
    id: workflowId,
    orgId: ORG,
    name: "Qualified workflow",
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
      id: candidateVersionId,
      orgId: ORG,
      workflowId,
      version: 2,
      dagJson: dag(workflowId, true),
      createdBy: "operator",
    },
  ]);
  return { baselineVersionId, candidateVersionId };
}

afterAll(async () => {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db
      .delete(workflowRollouts)
      .where(eq(workflowRollouts.orgId, orgId));
    await db
      .delete(workflowRecoveryQualifications)
      .where(eq(workflowRecoveryQualifications.orgId, orgId));
    await db
      .delete(workflowVersions)
      .where(eq(workflowVersions.orgId, orgId));
    await db.delete(workflows).where(eq(workflows.orgId, orgId));
  }
});
describe("workflow recovery qualification (real Postgres)", () => {
  it("resolves only the active tenant's exact latest version pair", async () => {
    const workflowId = `resolve-${TAG}`;
    const versions = await seedWorkflow(workflowId);

    await expect(
      resolveWorkflowRecoveryQualificationVersions({
        orgId: ORG,
        workflowId,
        ...versions,
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      baseline: { id: versions.baselineVersionId, version: 1 },
      candidate: { id: versions.candidateVersionId, version: 2 },
    });
    await expect(
      resolveWorkflowRecoveryQualificationVersions({
        orgId: OTHER_ORG,
        workflowId,
        ...versions,
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("converges repeated deterministic evidence and hides it cross-tenant", async () => {
    const workflowId = `receipt-${TAG}`;
    const versions = await seedWorkflow(workflowId);
    const input = {
      orgId: ORG,
      workflowId,
      ...versions,
      datasetVersion: RECOVERY_QUALIFICATION_DATASET_VERSION,
      datasetDigest: "digest-1",
      mode: "compare" as const,
      status: "passed" as const,
      summaryJson: {
        status: "passed",
        secretToken: "sk-live-do-not-store",
      },
      createdBy: "operator",
    };

    const first = await recordWorkflowRecoveryQualification(input);
    const second = await recordWorkflowRecoveryQualification(input);
    expect(second.id).toBe(first.id);
    expect(second.summaryJson).toMatchObject({
      status: "passed",
      secretToken: "[redacted]",
    });
    await expect(
      findWorkflowRecoveryQualification({
        orgId: OTHER_ORG,
        workflowId,
        baselineVersionId: versions.baselineVersionId,
        candidateVersionId: versions.candidateVersionId,
        datasetVersion: RECOVERY_QUALIFICATION_DATASET_VERSION,
      }),
    ).resolves.toBeNull();
  });

  it("blocks canary creation until the current evaluator has a passed receipt", async () => {
    const workflowId = `gate-${TAG}`;
    const versions = await seedWorkflow(workflowId);
    const rolloutInput = {
      orgId: ORG,
      workflowId,
      baselineVersionId: versions.baselineVersionId,
      canaryVersionId: versions.candidateVersionId,
      trafficPercent: 10,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 90,
      createdBy: "operator",
    };

    await expect(createWorkflowRollout(rolloutInput)).resolves.toEqual({
      kind: "recovery_qualification_required",
    });
    await recordWorkflowRecoveryQualification({
      orgId: ORG,
      workflowId,
      ...versions,
      datasetVersion: "semantic-outcomes-obsolete",
      datasetDigest: "old-digest",
      mode: "compare",
      status: "passed",
      summaryJson: { status: "passed" },
      createdBy: "operator",
    });
    await expect(createWorkflowRollout(rolloutInput)).resolves.toEqual({
      kind: "recovery_qualification_required",
    });
    await recordWorkflowRecoveryQualification({
      orgId: ORG,
      workflowId,
      ...versions,
      datasetVersion: RECOVERY_QUALIFICATION_DATASET_VERSION,
      datasetDigest: "current-digest",
      mode: "compare",
      status: "passed",
      summaryJson: { status: "passed" },
      createdBy: "operator",
    });
    await expect(createWorkflowRollout(rolloutInput)).resolves.toMatchObject({
      kind: "created",
      rollout: {
        baselineVersionId: versions.baselineVersionId,
        canaryVersionId: versions.candidateVersionId,
      },
    });
  });
});
