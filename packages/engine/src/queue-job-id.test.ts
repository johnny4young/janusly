import { describe, expect, it } from "vitest";
import { buildExecuteNodeJobId, buildReplayCampaignJobId } from "./queue-job-id";

describe("buildExecuteNodeJobId", () => {
  it("is stable for one exact generation and contains no reserved separator", () => {
    const input = {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 2,
      recoveryClaimToken: "claim-1",
      publicationGeneration: 3,
    };
    expect(buildExecuteNodeJobId(input)).toBe(buildExecuteNodeJobId(input));
    expect(buildExecuteNodeJobId(input)).toMatch(/^workflow-node-[0-9a-f]{64}$/);
    expect(buildExecuteNodeJobId(input)).not.toContain(":");
  });

  it("changes across attempts, recovery claims, and physical publications", () => {
    const base = { runId: "run-1", nodeId: "node-1" };
    const ids = new Set([
      buildExecuteNodeJobId({ ...base, attempt: 1 }),
      buildExecuteNodeJobId({ ...base, attempt: 2 }),
      buildExecuteNodeJobId({ ...base, attempt: 1, recoveryClaimToken: "claim-1" }),
      buildExecuteNodeJobId({ ...base, attempt: 1, recoveryClaimToken: "claim-2" }),
      buildExecuteNodeJobId({ ...base, attempt: 1, publicationGeneration: 1 }),
      buildExecuteNodeJobId({ ...base, attempt: 1, publicationGeneration: 2 }),
    ]);
    expect(ids.size).toBe(6);
  });
});

describe("buildReplayCampaignJobId", () => {
  it("deduplicates one due clock without BullMQ's reserved separator", () => {
    const dueAt = new Date("2026-07-21T12:00:05.000Z");
    const id = buildReplayCampaignJobId("campaign-1", dueAt);

    expect(id).toBe(buildReplayCampaignJobId("campaign-1", dueAt));
    expect(id).toMatch(/^replay-campaign-[0-9a-f]{64}$/);
    expect(id).not.toContain(":");
    expect(id).not.toBe(buildReplayCampaignJobId("campaign-1", new Date(dueAt.getTime() + 1)));
  });
});
