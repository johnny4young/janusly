/** Real-Postgres coverage for replay-campaign leases, counters, and cancel races. */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, replayCampaignItems, replayCampaigns } from "@janusly/db";
import {
  cancelReplayCampaign,
  claimNextReplayCampaignItem,
  claimReplayCampaignDispatch,
  completeReplayCampaignItem,
  createReplayCampaign,
  getReplayCampaign,
} from "../replayCampaignsRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-replay-campaign-${TAG}`;

afterAll(async () => {
  await db.delete(replayCampaignItems).where(eq(replayCampaignItems.orgId, ORG));
  await db.delete(replayCampaigns).where(eq(replayCampaigns.orgId, ORG));
});

describe("replay campaigns (real Postgres)", () => {
  it("rejects invalid campaign invariants before opening a transaction", async () => {
    await expect(createReplayCampaign({
      orgId: ORG,
      name: "One item is not a campaign",
      clusterSignature: "sig-invalid",
      deadLetterIds: [`${TAG}-only-one`],
      pacingMs: 1_000,
      createdBy: "operator",
    })).rejects.toThrow("replay_campaign_invalid_item_count");

    await expect(createReplayCampaign({
      orgId: ORG,
      name: "Invalid pace",
      clusterSignature: "sig-invalid",
      deadLetterIds: [`${TAG}-invalid-a`, `${TAG}-invalid-b`],
      pacingMs: 999,
      createdBy: "operator",
    })).rejects.toThrow("replay_campaign_invalid_pacing");
  });

  it("leases one dispatch and one item, then completes with exact counters", async () => {
    const startedAt = new Date("2026-07-21T12:00:00.000Z");
    const created = await createReplayCampaign({
      orgId: ORG,
      name: "Retry invoice failures",
      clusterSignature: "sig-invoice",
      deadLetterIds: [`${TAG}-dlq-a`, `${TAG}-dlq-b`],
      pacingMs: 1_000,
      createdBy: "operator",
    });
    await db.update(replayCampaigns).set({ nextDispatchAt: startedAt })
      .where(eq(replayCampaigns.id, created.campaign.id));

    const claimedCampaign = await claimReplayCampaignDispatch(created.campaign.id, startedAt);
    expect(claimedCampaign?.id).toBe(created.campaign.id);
    await expect(claimReplayCampaignDispatch(created.campaign.id, startedAt)).resolves.toBeNull();

    const first = await claimNextReplayCampaignItem(ORG, created.campaign.id, startedAt);
    expect(first?.deadLetterId).toBe(`${TAG}-dlq-a`);
    const afterFirst = await completeReplayCampaignItem({
      orgId: ORG,
      campaignId: created.campaign.id,
      itemId: first!.id,
      claimToken: first!.claimToken,
      outcome: "replayed",
      now: startedAt,
    });
    expect(afterFirst).toMatchObject({ status: "running", replayedCount: 1, failedCount: 0 });

    const nextAt = afterFirst!.nextDispatchAt;
    expect(await claimReplayCampaignDispatch(created.campaign.id, nextAt)).not.toBeNull();
    const second = await claimNextReplayCampaignItem(ORG, created.campaign.id, nextAt);
    expect(second?.deadLetterId).toBe(`${TAG}-dlq-b`);
    const completed = await completeReplayCampaignItem({
      orgId: ORG,
      campaignId: created.campaign.id,
      itemId: second!.id,
      claimToken: second!.claimToken,
      outcome: "failed",
      error: "still unavailable",
      now: nextAt,
    });
    expect(completed).toMatchObject({
      status: "completed",
      replayedCount: 1,
      failedCount: 1,
      cancelledCount: 0,
    });
    const detail = await getReplayCampaign(ORG, created.campaign.id);
    expect(detail?.items.map(item => item.status)).toEqual(["replayed", "failed"]);
    expect(detail?.items[1]?.error).toBe("still unavailable");
  });

  it("cancels pending items while allowing the already leased item to settle", async () => {
    const now = new Date();
    const created = await createReplayCampaign({
      orgId: ORG,
      name: "Abortable incident recovery",
      clusterSignature: "sig-abort",
      deadLetterIds: [`${TAG}-dlq-c`, `${TAG}-dlq-d`, `${TAG}-dlq-e`],
      pacingMs: 2_000,
      createdBy: "operator",
    });
    const leased = await claimNextReplayCampaignItem(ORG, created.campaign.id, now);
    const cancelled = await cancelReplayCampaign(ORG, created.campaign.id, "operator");
    expect(cancelled?.campaign).toMatchObject({ status: "cancelled", cancelledCount: 2 });
    expect(cancelled?.items.map(item => item.status)).toEqual(["processing", "cancelled", "cancelled"]);

    const settled = await completeReplayCampaignItem({
      orgId: ORG,
      campaignId: created.campaign.id,
      itemId: leased!.id,
      claimToken: leased!.claimToken,
      outcome: "replayed",
      now,
    });
    expect(settled).toMatchObject({ status: "cancelled", replayedCount: 1, cancelledCount: 2 });
    await expect(claimNextReplayCampaignItem(ORG, created.campaign.id, now)).resolves.toBeNull();
  });
});
