/** Real-Postgres proof for bounded, tenant-scoped recovery validation evidence. */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  db,
  deadLetters,
  recoveryImpactEvents,
  recoveryItems,
  runs,
} from "@janusly/db";
import { queryRecoveryValidation } from "../recoveryValidationRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-recovery-validation-${TAG}`;
const OTHER_ORG = `it-recovery-validation-other-${TAG}`;
const NOW = new Date("2026-07-21T12:00:00.000Z");
const NODE = "recover-step";

async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(recoveryImpactEvents).where(eq(recoveryImpactEvents.orgId, orgId));
  await db.delete(recoveryItems).where(eq(recoveryItems.orgId, orgId));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, orgId));
  await db.delete(runs).where(eq(runs.orgId, orgId));
}

afterAll(async () => {
  await cleanupOrg(ORG);
  await cleanupOrg(OTHER_ORG);
});

function drillRun(args: {
  id: string;
  orgId?: string;
  createdAt: Date;
  failureMode: string;
  recoveryPath?: "direct_failure" | "stalled_node_reaper";
}) {
  return {
    id: args.id,
    orgId: args.orgId ?? ORG,
    workflowVersionId: `${args.id}-workflow`,
    status: "failed",
    inputJson: {
      drill: {
        kind: "solution_pack_drill",
        packId: "incident-triage",
        fixtureId: `${args.id}-fixture`,
        failureMode: args.failureMode,
        recoveryPath: args.recoveryPath ?? "direct_failure",
      },
    },
    createdAt: args.createdAt,
  } as const;
}

function deadLetter(args: {
  id: string;
  runId: string;
  orgId?: string;
  createdAt: Date;
  status?: "open" | "resolved" | "replayed";
}) {
  return {
    id: args.id,
    orgId: args.orgId ?? ORG,
    runId: args.runId,
    nodeId: NODE,
    workflowJson: { id: "drill-workflow", nodes: [], edges: [] },
    nodeJson: { id: NODE, type: "http", config: {} },
    errorJson: { message: "Controlled validation failure" },
    status: args.status ?? "open",
    createdAt: args.createdAt,
  } as const;
}

describe("queryRecoveryValidation", () => {
  it("composes recovered, accepted-loss, and missing-evidence drills without tenant leakage", async () => {
    const recoveredStartedAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1_000);
    const acceptedStartedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1_000);
    const missingStartedAt = new Date(NOW.getTime() - 60 * 60 * 1_000);
    const oldStartedAt = new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1_000);

    await db.insert(runs).values([
      drillRun({ id: `${TAG}-recovered`, createdAt: recoveredStartedAt, failureMode: "upstream_unavailable" }),
      drillRun({
        id: `${TAG}-accepted`,
        createdAt: acceptedStartedAt,
        failureMode: "worker_stalled",
        recoveryPath: "stalled_node_reaper",
      }),
      drillRun({ id: `${TAG}-missing`, createdAt: missingStartedAt, failureMode: "contract_drift" }),
      drillRun({ id: `${TAG}-old`, createdAt: oldStartedAt, failureMode: "credential_expired" }),
      drillRun({
        id: `${TAG}-other`,
        orgId: OTHER_ORG,
        createdAt: missingStartedAt,
        failureMode: "rate_limited",
      }),
    ]);

    const recoveredDlq = `${TAG}-recovered-dlq`;
    const acceptedDlq = `${TAG}-accepted-dlq`;
    await db.insert(deadLetters).values([
      deadLetter({
        id: recoveredDlq,
        runId: `${TAG}-recovered`,
        createdAt: recoveredStartedAt,
        status: "replayed",
      }),
      deadLetter({
        id: acceptedDlq,
        runId: `${TAG}-accepted`,
        createdAt: acceptedStartedAt,
        status: "resolved",
      }),
      deadLetter({
        id: `${TAG}-old-dlq`,
        runId: `${TAG}-old`,
        createdAt: oldStartedAt,
      }),
      deadLetter({
        id: `${TAG}-other-dlq`,
        runId: `${TAG}-other`,
        orgId: OTHER_ORG,
        createdAt: missingStartedAt,
      }),
    ]);

    await db.insert(recoveryImpactEvents).values({
      deadLetterId: recoveredDlq,
      orgId: ORG,
      runId: `${TAG}-recovered`,
      nodeId: NODE,
      userId: "system:auto-healing",
      recoveredAt: new Date(recoveredStartedAt.getTime() + 90_000),
      downtimeEndedMs: 90_000,
    });
    await db.insert(recoveryItems).values({
      id: `${TAG}-accepted-item`,
      orgId: ORG,
      deadLetterId: acceptedDlq,
      workflowId: "drill-workflow",
      status: "resolved",
      slaTargetAt: new Date(acceptedStartedAt.getTime() + 60 * 60 * 1_000),
      resolutionReason: "accepted_loss",
      resolvedBy: "operator-a",
      resolvedAt: new Date(acceptedStartedAt.getTime() + 180_000),
      firstOccurredAt: acceptedStartedAt,
      lastOccurredAt: acceptedStartedAt,
      createdAt: acceptedStartedAt,
    });

    const report = await queryRecoveryValidation(ORG, 30, NOW);

    expect(report.totals).toMatchObject({
      drills: 3,
      completed: 2,
      recovered: 1,
      acceptedLoss: 1,
      missingEvidence: 1,
      completionRatePercent: 66.7,
      recoveryRatePercent: 50,
    });
    expect(report.resolution).toEqual({
      operator: 1,
      automated: 1,
      unknown: 0,
      operatorInterventionRatePercent: 50,
    });
    expect(report.timing).toEqual({
      medianElapsedMs: 90_000,
      p90ElapsedMs: 90_000,
      averageElapsedMs: 90_000,
      p95ElapsedMs: 90_000,
      sampleSize: 1,
    });
    expect(report.samples.map((sample) => sample.runId)).toEqual([
      `${TAG}-missing`,
      `${TAG}-accepted`,
      `${TAG}-recovered`,
    ]);
    expect(report.samples).not.toContainEqual(expect.objectContaining({ runId: `${TAG}-old` }));
    expect(report.samples).not.toContainEqual(expect.objectContaining({ runId: `${TAG}-other` }));
    expect(report.samples.find((sample) => sample.runId.endsWith("-recovered"))).toMatchObject({
      resolutionMode: "automated",
      outcome: { status: "recovered", evidence: "terminal_impact" },
    });
    expect(report.samples.find((sample) => sample.runId.endsWith("-accepted"))).toMatchObject({
      resolutionMode: "operator",
      outcome: { status: "accepted_loss", evidence: "explicit_resolution" },
    });
  });
});
