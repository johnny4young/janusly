import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STALLED_NODE_THRESHOLD_MINUTES,
  MAX_STALLED_NODE_THRESHOLD_MINUTES,
  MIN_STALLED_NODE_THRESHOLD_MINUTES,
  reapStalledNodes,
  resolveStalledNodeThresholdMinutes,
  type StalledNodeReaperDeps,
} from "./stalled-node-reaper";
import type { StalledRunningNode } from "@janusly/data";

/** A valid workflow snapshot carrying the stalled node, the shape `startRun`
 *  persists into `runs.input_json`. */
function snapshot(nodeId: string) {
  return {
    workflow: {
      id: "wf_1",
      name: "Billing flow",
      nodes: [
        { id: "start", type: "noop", config: {} },
        { id: nodeId, type: "http", config: { url: "https://api.example.com", method: "POST" } },
      ],
      edges: [{ from: "start", to: nodeId }],
    },
    input: {},
  };
}

function stalledNode(overrides: Partial<StalledRunningNode> = {}): StalledRunningNode {
  return {
    runId: "run_1",
    nodeId: "call_api",
    orgId: "org_1",
    attempt: 1,
    startedAt: new Date("2026-06-10T09:00:00Z"),
    inputJson: snapshot("call_api"),
    ...overrides,
  };
}

/** Assemble reaper deps with vi mocks; `failNode` resolves `true` (CAS wins) by default. */
function makeDeps(overrides: Partial<StalledNodeReaperDeps> = {}): StalledNodeReaperDeps {
  return {
    findStalled: vi.fn(async () => []),
    failNode: vi.fn(async () => true),
    enqueueDeadLetter: vi.fn(async () => undefined),
    appendNodeFailedEvent: vi.fn(async () => undefined),
    rollupRunStatus: vi.fn(async () => undefined),
    now: () => new Date("2026-06-10T12:00:00Z"),
    ...overrides,
  };
}

describe("reapStalledNodes", () => {
  it("computes olderThan as now − thresholdMs and passes the limit through", async () => {
    const findStalled = vi.fn(async () => []);
    const deps = makeDeps({ findStalled, now: () => new Date("2026-06-10T12:00:00Z") });

    await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    expect(findStalled).toHaveBeenCalledWith({
      // 12:00 − 60 min = 11:00.
      olderThan: new Date("2026-06-10T11:00:00Z"),
      limit: 500,
    });
  });

  it("fails the node, dead-letters it, emits a node.failed event, and rolls the run up", async () => {
    const deps = makeDeps({ findStalled: vi.fn(async () => [stalledNode()]) });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    expect(result).toEqual({ scanned: 1, reaped: 1, deadLettered: 1, skipped: 0 });

    // CAS fail with the stable worker_stalled code.
    expect(deps.failNode).toHaveBeenCalledTimes(1);
    const [runId, nodeId, error] = (deps.failNode as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(runId).toBe("run_1");
    expect(nodeId).toBe("call_api");
    expect(error.code).toBe("worker_stalled");

    // DLQ row reconstructed from the snapshot — workflow + the matching node.
    expect(deps.enqueueDeadLetter).toHaveBeenCalledTimes(1);
    const dlqArg = (deps.enqueueDeadLetter as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(dlqArg.orgId).toBe("org_1");
    expect(dlqArg.workflowId).toBe("wf_1");
    expect(dlqArg.node.id).toBe("call_api");
    expect(dlqArg.error.code).toBe("worker_stalled");

    // Timeline event + terminal rollup.
    expect(deps.appendNodeFailedEvent).toHaveBeenCalledWith(
      "run_1",
      "call_api",
      expect.objectContaining({ reason: "worker_stalled", attempt: 1 }),
    );
    expect(deps.rollupRunStatus).toHaveBeenCalledWith("run_1");
  });

  it("skips a node whose CAS lost (it already advanced) — no DLQ, event, or rollup", async () => {
    const deps = makeDeps({
      findStalled: vi.fn(async () => [stalledNode()]),
      failNode: vi.fn(async () => false), // lost the claim
    });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    expect(result).toEqual({ scanned: 1, reaped: 0, deadLettered: 0, skipped: 1 });
    expect(deps.enqueueDeadLetter).not.toHaveBeenCalled();
    expect(deps.appendNodeFailedEvent).not.toHaveBeenCalled();
    expect(deps.rollupRunStatus).not.toHaveBeenCalled();
  });

  it("still fails + terminates the run when the snapshot can't be reconstructed (best-effort DLQ)", async () => {
    const deps = makeDeps({
      findStalled: vi.fn(async () => [stalledNode({ inputJson: null })]),
    });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    // Reaped + run terminated, but no DLQ row (no snapshot to rebuild the job).
    expect(result).toEqual({ scanned: 1, reaped: 1, deadLettered: 0, skipped: 0 });
    expect(deps.enqueueDeadLetter).not.toHaveBeenCalled();
    expect(deps.appendNodeFailedEvent).toHaveBeenCalledTimes(1);
    expect(deps.rollupRunStatus).toHaveBeenCalledWith("run_1");
  });

  it("does not dead-letter when the node id is absent from the snapshot", async () => {
    const deps = makeDeps({
      findStalled: vi.fn(async () => [stalledNode({ nodeId: "ghost", inputJson: snapshot("call_api") })]),
    });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    expect(result.reaped).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(deps.enqueueDeadLetter).not.toHaveBeenCalled();
    expect(deps.rollupRunStatus).toHaveBeenCalledWith("run_1");
  });

  it("isolates a per-node fault so one bad row can't abort the sweep", async () => {
    const good = stalledNode({ runId: "run_good", nodeId: "call_api" });
    const bad = stalledNode({ runId: "run_bad", nodeId: "call_api" });
    const failNode = vi.fn(async (runId: string) => {
      if (runId === "run_bad") throw new Error("db blip");
      return true;
    });
    const deps = makeDeps({ findStalled: vi.fn(async () => [bad, good]), failNode });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    // The bad row is swallowed; the good row is still reaped + terminated.
    expect(result.reaped).toBe(1);
    expect(deps.rollupRunStatus).toHaveBeenCalledWith("run_good");
    expect(deps.rollupRunStatus).not.toHaveBeenCalledWith("run_bad");
  });

  it("still fails the node + rolls up even when the DLQ write throws (DLQ is best-effort)", async () => {
    const deps = makeDeps({
      findStalled: vi.fn(async () => [stalledNode()]),
      enqueueDeadLetter: vi.fn(async () => {
        throw new Error("dlq insert failed");
      }),
    });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    expect(result.reaped).toBe(1);
    expect(result.deadLettered).toBe(0); // throw means it wasn't counted
    expect(deps.appendNodeFailedEvent).toHaveBeenCalledTimes(1);
    expect(deps.rollupRunStatus).toHaveBeenCalledWith("run_1");
  });
});

describe("resolveStalledNodeThresholdMinutes", () => {
  it("returns the default when unset", () => {
    expect(resolveStalledNodeThresholdMinutes({})).toBe(DEFAULT_STALLED_NODE_THRESHOLD_MINUTES);
  });

  it("accepts an in-range integer", () => {
    expect(resolveStalledNodeThresholdMinutes({ JANUSLY_STALLED_NODE_THRESHOLD_MINUTES: "120" })).toBe(120);
  });

  it("clamps a below-floor value to the default", () => {
    expect(
      resolveStalledNodeThresholdMinutes({
        JANUSLY_STALLED_NODE_THRESHOLD_MINUTES: String(MIN_STALLED_NODE_THRESHOLD_MINUTES - 1),
      }),
    ).toBe(DEFAULT_STALLED_NODE_THRESHOLD_MINUTES);
  });

  it("clamps an above-ceiling value to the default", () => {
    expect(
      resolveStalledNodeThresholdMinutes({
        JANUSLY_STALLED_NODE_THRESHOLD_MINUTES: String(MAX_STALLED_NODE_THRESHOLD_MINUTES + 1),
      }),
    ).toBe(DEFAULT_STALLED_NODE_THRESHOLD_MINUTES);
  });

  it("falls back to the default on a non-integer", () => {
    expect(resolveStalledNodeThresholdMinutes({ JANUSLY_STALLED_NODE_THRESHOLD_MINUTES: "abc" })).toBe(
      DEFAULT_STALLED_NODE_THRESHOLD_MINUTES,
    );
  });
});
