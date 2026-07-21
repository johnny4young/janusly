import { describe, expect, it, vi } from "vitest";

import type {
  ClaimedReplayCampaignItem,
  ReplayCampaign,
} from "@janusly/data";

import { processReplayCampaignStep } from "./replay-campaign";

const now = new Date("2026-07-21T12:00:00.000Z");

function campaign(overrides: Partial<ReplayCampaign> = {}): ReplayCampaign {
  return {
    id: "campaign-1",
    orgId: "org-1",
    name: "Retry payments",
    clusterSignature: "sig-1",
    filterJson: {},
    pacingMs: 5_000,
    status: "running",
    totalCount: 2,
    replayedCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    createdBy: "user-1",
    cancelledBy: null,
    nextDispatchAt: now,
    startedAt: now,
    completedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function item(overrides: Partial<ClaimedReplayCampaignItem> = {}): ClaimedReplayCampaignItem {
  return {
    id: "item-1",
    orgId: "org-1",
    campaignId: "campaign-1",
    deadLetterId: "dlq-1",
    position: 0,
    status: "processing",
    attemptCount: 1,
    claimToken: "claim-1",
    claimedAt: now,
    error: null,
    completedAt: null,
    createdAt: now,
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  const updated = campaign({
    replayedCount: 1,
    nextDispatchAt: new Date(now.getTime() + 5_000),
  });
  return {
    claimDispatch: vi.fn().mockResolvedValue(campaign()),
    claimItem: vi.fn().mockResolvedValue(item()),
    replayItem: vi.fn().mockResolvedValue(undefined),
    settleItem: vi.fn().mockResolvedValue(updated),
    completeIfExhausted: vi.fn().mockResolvedValue(null),
    deferDispatch: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("replay campaign worker", () => {
  it("replays one item and schedules exactly one paced successor", async () => {
    const subject = deps();

    await expect(processReplayCampaignStep("campaign-1", subject, now)).resolves.toBe("replayed");

    expect(subject.replayItem).toHaveBeenCalledTimes(1);
    expect(subject.settleItem).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "campaign-1",
      itemId: "item-1",
      claimToken: "claim-1",
      outcome: "replayed",
    }));
    expect(subject.schedule).toHaveBeenCalledWith(
      "campaign-1",
      new Date(now.getTime() + 5_000),
    );
  });

  it("turns a replay error into a per-item failure without aborting the campaign", async () => {
    const subject = deps({ replayItem: vi.fn().mockRejectedValue(new Error("not replayable")) });

    await expect(processReplayCampaignStep("campaign-1", subject, now)).resolves.toBe("failed");

    expect(subject.settleItem).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      error: "not replayable",
    }));
    expect(subject.schedule).toHaveBeenCalledTimes(1);
  });

  it("preserves the durable pacing clock when successor publication fails", async () => {
    const subject = deps({ schedule: vi.fn().mockRejectedValue(new Error("redis unavailable")) });

    await expect(processReplayCampaignStep("campaign-1", subject, now))
      .rejects.toThrow("redis unavailable");

    expect(subject.settleItem).toHaveBeenCalledTimes(1);
    expect(subject.deferDispatch).not.toHaveBeenCalled();
  });

  it("does nothing when a duplicate job loses the dispatch lease", async () => {
    const subject = deps({ claimDispatch: vi.fn().mockResolvedValue(null) });

    await expect(processReplayCampaignStep("campaign-1", subject, now)).resolves.toBe("skipped");

    expect(subject.claimItem).not.toHaveBeenCalled();
    expect(subject.replayItem).not.toHaveBeenCalled();
  });

  it("marks an exhausted campaign complete and emits one completion audit", async () => {
    const completed = campaign({ status: "completed", replayedCount: 2, completedAt: now });
    const subject = deps({
      claimItem: vi.fn().mockResolvedValue(null),
      completeIfExhausted: vi.fn().mockResolvedValue(completed),
    });

    await expect(processReplayCampaignStep("campaign-1", subject, now)).resolves.toBe("completed");

    expect(subject.schedule).not.toHaveBeenCalled();
    expect(subject.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "recovery.campaign.completed",
      targetId: "campaign-1",
    }));
  });
});
