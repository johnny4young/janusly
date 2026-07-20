/** Real-Postgres proof for first-action latency and seven-day fix recurrence. */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  db,
  deadLetters,
  recoveryImpactEvents,
  recoveryItemChildren,
  recoveryItems,
  runs,
} from "@janusly/db";
import {
  acknowledgeRecoveryItem,
  setInProgressRecoveryItem,
} from "../recoveryItemsRepo";
import {
  queryRecoveryRecurrence,
  queryTimeToFirstAction,
} from "../recoveryMetricsRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ACTION_ORG = `it-effectiveness-action-${TAG}`;
const METRICS_ORG = `it-effectiveness-metrics-${TAG}`;
const OTHER_ORG = `it-effectiveness-other-${TAG}`;
const NODE = "step-1";
const WORKFLOW = { id: "workflow-a", nodes: [], edges: [] };
const NODE_JSON = { id: NODE, type: "http", config: {} };

async function cleanupOrg(orgId: string): Promise<void> {
  await db.delete(recoveryImpactEvents).where(eq(recoveryImpactEvents.orgId, orgId));
  await db.delete(recoveryItemChildren).where(eq(recoveryItemChildren.orgId, orgId));
  await db.delete(recoveryItems).where(eq(recoveryItems.orgId, orgId));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, orgId));
  await db.delete(runs).where(eq(runs.orgId, orgId));
}

afterAll(async () => {
  await cleanupOrg(ACTION_ORG);
  await cleanupOrg(METRICS_ORG);
  await cleanupOrg(OTHER_ORG);
});

function dlqValue(input: {
  id: string;
  orgId?: string;
  runId?: string;
  createdAt: Date;
  replayClaimedAt?: Date;
}) {
  return {
    id: input.id,
    orgId: input.orgId ?? METRICS_ORG,
    runId: input.runId ?? `${input.id}-run`,
    nodeId: NODE,
    workflowJson: WORKFLOW,
    nodeJson: NODE_JSON,
    errorJson: { message: input.id },
    createdAt: input.createdAt,
    replayClaimedAt: input.replayClaimedAt,
  };
}

describe("recovery effectiveness signals", () => {
  it("sets the first action once across later lifecycle transitions", async () => {
    const createdAt = new Date(Date.now() - 60_000);
    const dlqId = `${TAG}-action-dlq`;
    const itemId = `${TAG}-action-item`;
    await db.insert(deadLetters).values(dlqValue({ id: dlqId, orgId: ACTION_ORG, createdAt }));
    await db.insert(recoveryItems).values({
      id: itemId,
      orgId: ACTION_ORG,
      deadLetterId: dlqId,
      workflowId: "workflow-a",
      status: "open",
      slaTargetAt: new Date(Date.now() + 3_600_000),
      createdAt,
      firstOccurredAt: createdAt,
      lastOccurredAt: createdAt,
    });

    const acknowledged = await acknowledgeRecoveryItem(ACTION_ORG, itemId, { owner: "operator-a" });
    expect(acknowledged?.after.firstActionAt).toBeInstanceOf(Date);
    const firstActionAt = acknowledged!.after.firstActionAt!.getTime();

    await new Promise((resolve) => setTimeout(resolve, 10));
    const inProgress = await setInProgressRecoveryItem(ACTION_ORG, itemId, { owner: "operator-b" });
    expect(inProgress?.after.firstActionAt?.getTime()).toBe(firstActionAt);
  });

  it("computes item and no-item first-action samples without cross-tenant leakage", async () => {
    const createdAt = new Date(Date.now() - 3_600_000);
    const itemDlq = `${TAG}-metric-item-dlq`;
    const noItemDlq = `${TAG}-metric-no-item-dlq`;
    const itemFirstActionAt = new Date(createdAt.getTime() + 60_000);
    const noItemFirstActionAt = new Date(createdAt.getTime() + 180_000);
    await db.insert(deadLetters).values([
      dlqValue({ id: itemDlq, createdAt }),
      dlqValue({ id: noItemDlq, createdAt, replayClaimedAt: noItemFirstActionAt }),
      dlqValue({
        id: `${TAG}-other-no-item-dlq`,
        orgId: OTHER_ORG,
        createdAt,
        replayClaimedAt: new Date(createdAt.getTime() + 3_600_000),
      }),
    ]);
    await db.insert(recoveryItems).values([
      {
        id: `${TAG}-metric-item`,
        orgId: METRICS_ORG,
        deadLetterId: itemDlq,
        workflowId: "workflow-a",
        slaTargetAt: new Date(createdAt.getTime() + 7_200_000),
        firstActionAt: itemFirstActionAt,
        createdAt,
        firstOccurredAt: createdAt,
        lastOccurredAt: createdAt,
      },
      {
        id: `${TAG}-other-item`,
        orgId: OTHER_ORG,
        deadLetterId: `${TAG}-other-no-item-dlq`,
        workflowId: "workflow-a",
        slaTargetAt: new Date(createdAt.getTime() + 7_200_000),
        firstActionAt: new Date(createdAt.getTime() + 3_600_000),
        createdAt,
        firstOccurredAt: createdAt,
        lastOccurredAt: createdAt,
      },
    ]);

    await expect(queryTimeToFirstAction(METRICS_ORG, new Date(createdAt.getTime() - 1))).resolves.toEqual({
      avgSeconds: 120,
      p95Seconds: 180,
      sampleSize: 2,
    });
  });

  it("counts new-item and reopened-item recurrences once and excludes sandbox runs", async () => {
    const recoveredAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const baseline = [
      { key: "child", signature: "network_timeout:child" },
      { key: "new", signature: "http_error:new" },
      { key: "held", signature: "parse_error:held" },
    ];
    const runValues: Array<typeof runs.$inferInsert> = [];
    const dlqValues: Array<typeof deadLetters.$inferInsert> = [];
    const itemValues: Array<typeof recoveryItems.$inferInsert> = [];
    const impactValues: Array<typeof recoveryImpactEvents.$inferInsert> = [];

    for (const entry of baseline) {
      const runId = `${TAG}-${entry.key}-base-run`;
      const dlqId = `${TAG}-${entry.key}-base-dlq`;
      runValues.push({ id: runId, orgId: METRICS_ORG, workflowVersionId: "workflow-a-v1", status: "succeeded", createdAt: recoveredAt });
      dlqValues.push(dlqValue({ id: dlqId, runId, createdAt: new Date(recoveredAt.getTime() - 60_000) }));
      itemValues.push({
        id: `${TAG}-${entry.key}-item`,
        orgId: METRICS_ORG,
        deadLetterId: dlqId,
        workflowId: "workflow-a",
        status: "resolved",
        slaTargetAt: recoveredAt,
        resolvedAt: recoveredAt,
        errorSignature: entry.signature,
        createdAt: new Date(recoveredAt.getTime() - 60_000),
        firstOccurredAt: new Date(recoveredAt.getTime() - 60_000),
        lastOccurredAt: new Date(recoveredAt.getTime() - 60_000),
      });
      impactValues.push({
        deadLetterId: dlqId,
        orgId: METRICS_ORG,
        runId,
        nodeId: NODE,
        recoveredAt,
        downtimeEndedMs: 60_000,
      });
    }

    const childOccurredAt = new Date(recoveredAt.getTime() + 24 * 60 * 60 * 1000);
    const childRun = `${TAG}-child-later-run`;
    const childDlq = `${TAG}-child-later-dlq`;
    runValues.push({ id: childRun, orgId: METRICS_ORG, workflowVersionId: "workflow-a-v1", status: "failed", createdAt: childOccurredAt });
    dlqValues.push(dlqValue({ id: childDlq, runId: childRun, createdAt: childOccurredAt }));

    const newOccurredAt = new Date(recoveredAt.getTime() + 2 * 24 * 60 * 60 * 1000);
    const newRun = `${TAG}-new-later-run`;
    const newDlq = `${TAG}-new-later-dlq`;
    runValues.push({ id: newRun, orgId: METRICS_ORG, workflowVersionId: "workflow-a-v1", status: "failed", createdAt: newOccurredAt });
    dlqValues.push(dlqValue({ id: newDlq, runId: newRun, createdAt: newOccurredAt }));
    itemValues.push({
      id: `${TAG}-new-later-item`,
      orgId: METRICS_ORG,
      deadLetterId: newDlq,
      workflowId: "workflow-a",
      slaTargetAt: new Date(newOccurredAt.getTime() + 3_600_000),
      errorSignature: "http_error:new",
      createdAt: newOccurredAt,
      firstOccurredAt: newOccurredAt,
      lastOccurredAt: newOccurredAt,
    });

    const sandboxOccurredAt = new Date(recoveredAt.getTime() + 3 * 24 * 60 * 60 * 1000);
    const sandboxRun = `${TAG}-held-sandbox-run`;
    const sandboxDlq = `${TAG}-held-sandbox-dlq`;
    runValues.push({ id: sandboxRun, orgId: METRICS_ORG, workflowVersionId: "workflow-a-v1", status: "failed", replayMode: "validation", createdAt: sandboxOccurredAt });
    dlqValues.push(dlqValue({ id: sandboxDlq, runId: sandboxRun, createdAt: sandboxOccurredAt }));

    await db.insert(runs).values(runValues);
    await db.insert(deadLetters).values(dlqValues);
    await db.insert(recoveryItems).values(itemValues);
    await db.insert(recoveryImpactEvents).values(impactValues);
    await db.insert(recoveryItemChildren).values([
      {
        id: `${TAG}-child-link`,
        orgId: METRICS_ORG,
        recoveryItemId: `${TAG}-child-item`,
        deadLetterId: childDlq,
        occurredAt: childOccurredAt,
      },
      {
        id: `${TAG}-held-sandbox-link`,
        orgId: METRICS_ORG,
        recoveryItemId: `${TAG}-held-item`,
        deadLetterId: sandboxDlq,
        occurredAt: sandboxOccurredAt,
      },
    ]);

    const result = await queryRecoveryRecurrence(
      METRICS_ORG,
      new Date(recoveredAt.getTime() - 1),
    );
    expect(result).toMatchObject({ resolved: 3, recurred: 2 });
    expect(result.recurredSignatures.sort()).toEqual([
      "http_error:new",
      "network_timeout:child",
    ]);
  });
});
