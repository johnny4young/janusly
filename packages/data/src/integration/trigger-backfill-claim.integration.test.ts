/**
 * Real-Postgres coverage for buffered-event leasing. The claim is a single
 * `FOR UPDATE SKIP LOCKED` statement, so mocked builders cannot prove its
 * no-overlap and expired-lease behavior.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, triggerEvents } from "@janusly/db";
import {
  claimBufferedTriggerEvents,
  countBufferedTriggerEvents,
  releaseTriggerEventBackfillClaim,
  retireTriggerEventBackfillClaim,
} from "../triggerEventsRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-trigger-claim-${TAG}`;

async function seedBufferedEvents(workflowId: string): Promise<void> {
  const base = Date.now() - 60_000;
  await db.insert(triggerEvents).values([0, 1, 2].map((index) => ({
    id: `${workflowId}-event-${index}`,
    orgId: ORG,
    workflowId,
    workflowVersionId: `${workflowId}-v1`,
    nodeId: "inbox",
    triggerType: "email_received",
    status: "buffered",
    payloadJson: { index },
    createdAt: new Date(base + index * 1000),
  })));
}

afterAll(async () => {
  await db.delete(triggerEvents).where(eq(triggerEvents.orgId, ORG));
});

describe("buffered trigger claims (real Postgres)", () => {
  it("leases oldest-first pages without overlap and can release a failed item", async () => {
    const workflowId = `wf-page-${TAG}`;
    await seedBufferedEvents(workflowId);

    const first = await claimBufferedTriggerEvents(ORG, workflowId, 2);
    const second = await claimBufferedTriggerEvents(ORG, workflowId, 2);

    expect(first.map((row) => row.id)).toEqual([`${workflowId}-event-0`, `${workflowId}-event-1`]);
    expect(second.map((row) => row.id)).toEqual([`${workflowId}-event-2`]);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(3);

    expect(await releaseTriggerEventBackfillClaim(ORG, first[0]!.id, first[0]!.claimToken)).toBe(true);
    const reclaimed = await claimBufferedTriggerEvents(ORG, workflowId, 1);
    expect(reclaimed[0]?.id).toBe(first[0]!.id);
  });

  it("surfaces and reclaims an expired lease", async () => {
    const workflowId = `wf-expired-${TAG}`;
    await seedBufferedEvents(workflowId);
    const [claimed] = await claimBufferedTriggerEvents(ORG, workflowId, 1);
    const id = claimed!.id;
    await db
      .update(triggerEvents)
      .set({ backfillClaimedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(and(eq(triggerEvents.orgId, ORG), eq(triggerEvents.id, id)));

    expect(await countBufferedTriggerEvents(ORG, workflowId)).toBe(3);
    const reclaimed = await claimBufferedTriggerEvents(ORG, workflowId, 1);
    expect(reclaimed[0]?.id).toBe(id);
  });

  it("prevents an expired claimant from retiring a newer lease", async () => {
    const workflowId = `wf-stale-retire-${TAG}`;
    await seedBufferedEvents(workflowId);
    const [expiredClaim] = await claimBufferedTriggerEvents(ORG, workflowId, 1);
    await db
      .update(triggerEvents)
      .set({ backfillClaimedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(and(eq(triggerEvents.orgId, ORG), eq(triggerEvents.id, expiredClaim!.id)));
    const [currentClaim] = await claimBufferedTriggerEvents(ORG, workflowId, 1);

    await expect(retireTriggerEventBackfillClaim(
      ORG,
      expiredClaim!.id,
      expiredClaim!.claimToken,
      "failed",
      "stale_worker",
    )).resolves.toBe(false);
    const [event] = await db
      .select()
      .from(triggerEvents)
      .where(and(eq(triggerEvents.orgId, ORG), eq(triggerEvents.id, expiredClaim!.id)));
    expect(event).toMatchObject({
      status: "backfilling",
      backfillClaimToken: currentClaim!.claimToken,
      skippedReason: null,
    });
  });
});
