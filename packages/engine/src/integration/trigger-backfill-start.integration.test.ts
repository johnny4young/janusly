/**
 * Real-Postgres proof that consuming a buffered-event lease and creating its
 * run are one transaction. This closes the crash window between those writes.
 */

import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, runEvents, runNodes, runs, triggerEvents } from "@janusly/db";
import { startRun, TriggerEventStartConflictError } from "../start-run";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-trigger-start-${TAG}`;
const WORKFLOW = {
  id: `wf-${TAG}`,
  name: "Trigger start",
  dslVersion: "1.0" as const,
  nodes: [],
  edges: [],
};

async function seedClaimedEvent(id: string, claimToken: string): Promise<void> {
  await db.insert(triggerEvents).values({
    id,
    orgId: ORG,
    workflowId: WORKFLOW.id,
    workflowVersionId: `${WORKFLOW.id}-v1`,
    nodeId: "inbox",
    triggerType: "email_received",
    status: "backfilling",
    payloadJson: {},
    backfillClaimToken: claimToken,
    backfillClaimedAt: new Date(),
  });
}

async function seedReceivedEvent(id: string): Promise<void> {
  await db.insert(triggerEvents).values({
    id,
    orgId: ORG,
    workflowId: WORKFLOW.id,
    workflowVersionId: `${WORKFLOW.id}-v1`,
    nodeId: "inbox",
    triggerType: "email_received",
    status: "received",
    payloadJson: {},
  });
}

afterAll(async () => {
  const orgRuns = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG));
  const runIds = orgRuns.map((row) => row.id);
  if (runIds.length > 0) {
    await db.delete(runEvents).where(inArray(runEvents.runId, runIds));
    await db.delete(runNodes).where(inArray(runNodes.runId, runIds));
  }
  await db.delete(runs).where(eq(runs.orgId, ORG));
  await db.delete(triggerEvents).where(eq(triggerEvents.orgId, ORG));
});

describe("startRun trigger-event consumption (real Postgres)", () => {
  it("attaches a received event to the run atomically", async () => {
    const eventId = `${TAG}-received`;
    await seedReceivedEvent(eventId);

    const { runId } = await startRun({
      ...WORKFLOW,
      orgId: ORG,
      versionId: `${WORKFLOW.id}-v1`,
      triggerEventStart: { id: eventId },
    });

    const [event] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, eventId));
    expect(event).toMatchObject({ status: "started", runId });
  });

  it("attaches the run and consumes the lease atomically", async () => {
    const eventId = `${TAG}-success`;
    const claimToken = `${TAG}-claim`;
    await seedClaimedEvent(eventId, claimToken);

    const { runId } = await startRun({
      ...WORKFLOW,
      orgId: ORG,
      versionId: `${WORKFLOW.id}-v1`,
      triggerEventStart: { id: eventId, claimToken },
    });

    const [event] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, eventId));
    expect(event).toMatchObject({ status: "started", runId, backfillClaimToken: null, backfillClaimedAt: null });
  });

  it("rolls the run back when the lease token no longer matches", async () => {
    const eventId = `${TAG}-stale`;
    await seedClaimedEvent(eventId, `${TAG}-actual`);
    const before = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG));

    await expect(startRun({
      ...WORKFLOW,
      orgId: ORG,
      versionId: `${WORKFLOW.id}-v1`,
      triggerEventStart: { id: eventId, claimToken: `${TAG}-stale-token` },
    })).rejects.toBeInstanceOf(TriggerEventStartConflictError);

    const after = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG));
    expect(after).toHaveLength(before.length);
    const [event] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, eventId));
    expect(event).toMatchObject({ status: "backfilling", runId: null, backfillClaimToken: `${TAG}-actual` });
  });

  it("rolls the run back when a received event was already consumed", async () => {
    const eventId = `${TAG}-consumed`;
    await seedReceivedEvent(eventId);
    await db.update(triggerEvents).set({ status: "started", runId: `${TAG}-winner` }).where(eq(triggerEvents.id, eventId));
    const before = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG));

    await expect(startRun({
      ...WORKFLOW,
      orgId: ORG,
      versionId: `${WORKFLOW.id}-v1`,
      triggerEventStart: { id: eventId },
    })).rejects.toBeInstanceOf(TriggerEventStartConflictError);

    const after = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG));
    expect(after).toHaveLength(before.length);
  });

  it("lets exactly one concurrent start consume a received event", async () => {
    const eventId = `${TAG}-concurrent`;
    await seedReceivedEvent(eventId);
    const before = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG));
    const attempt = () => startRun({
      ...WORKFLOW,
      orgId: ORG,
      versionId: `${WORKFLOW.id}-v1`,
      triggerEventStart: { id: eventId },
    });

    const results = await Promise.allSettled([attempt(), attempt()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(TriggerEventStartConflictError) });
    const after = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ORG));
    expect(after).toHaveLength(before.length + 1);
    const [event] = await db.select().from(triggerEvents).where(eq(triggerEvents.id, eventId));
    expect(event).toMatchObject({ status: "started", runId: expect.any(String) });
  });
});
