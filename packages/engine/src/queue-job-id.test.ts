import { describe, expect, it } from "vitest";
import { buildExecuteNodeJobId } from "./queue-job-id";

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
