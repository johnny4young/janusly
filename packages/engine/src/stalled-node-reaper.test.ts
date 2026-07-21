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

/** Assemble reaper deps with an atomic persistence mock that wins by default. */
function makeDeps(overrides: Partial<StalledNodeReaperDeps> = {}): StalledNodeReaperDeps {
  return {
    findStalled: vi.fn(async () => []),
    persistFailure: vi.fn(async (input) => ({
      persisted: true,
      deadLettered: input.deadLetter !== null,
      deadLetterId: input.deadLetter ? "dlq_1" : null,
    })),
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

    expect(result).toEqual({
      scanned: 1,
      reaped: 1,
      deadLettered: 1,
      skipped: 0,
      deadLetterIds: ["dlq_1"],
    });

    expect(deps.persistFailure).toHaveBeenCalledTimes(1);
    const atomicInput = (deps.persistFailure as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(atomicInput).toMatchObject({
      runId: "run_1",
      orgId: "org_1",
      nodeId: "call_api",
      attempt: 1,
      error: { code: "worker_stalled" },
      deadLetter: {
        workflowId: "wf_1",
        node: { id: "call_api" },
      },
    });
  });

  it("skips a node whose atomic CAS lost because it already advanced", async () => {
    const deps = makeDeps({
      findStalled: vi.fn(async () => [stalledNode()]),
      persistFailure: vi.fn(async () => ({ persisted: false, deadLettered: false, deadLetterId: null })),
    });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    expect(result).toEqual({
      scanned: 1,
      reaped: 0,
      deadLettered: 0,
      skipped: 1,
      deadLetterIds: [],
    });
  });

  it("still fails + terminates the run when the snapshot can't be reconstructed (best-effort DLQ)", async () => {
    const deps = makeDeps({
      findStalled: vi.fn(async () => [stalledNode({ inputJson: null })]),
    });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    // Reaped + run terminated, but no DLQ row (no snapshot to rebuild the job).
    expect(result).toEqual({
      scanned: 1,
      reaped: 1,
      deadLettered: 0,
      skipped: 0,
      deadLetterIds: [],
    });
    expect(deps.persistFailure).toHaveBeenCalledWith(expect.objectContaining({ deadLetter: null }));
  });

  it("does not dead-letter when the node id is absent from the snapshot", async () => {
    const deps = makeDeps({
      findStalled: vi.fn(async () => [stalledNode({ nodeId: "ghost", inputJson: snapshot("call_api") })]),
    });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    expect(result.reaped).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(deps.persistFailure).toHaveBeenCalledWith(expect.objectContaining({ deadLetter: null }));
  });

  it("isolates a per-node fault so one bad row can't abort the sweep", async () => {
    const good = stalledNode({ runId: "run_good", nodeId: "call_api" });
    const bad = stalledNode({ runId: "run_bad", nodeId: "call_api" });
    const persistFailure = vi.fn(async (input: Parameters<StalledNodeReaperDeps["persistFailure"]>[0]) => {
      if (input.runId === "run_bad") throw new Error("db blip");
      return { persisted: true, deadLettered: true, deadLetterId: "dlq_good" };
    });
    const deps = makeDeps({ findStalled: vi.fn(async () => [bad, good]), persistFailure });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    // The bad row is swallowed; the good row still reaches the atomic boundary.
    expect(result.reaped).toBe(1);
    expect(result.deadLetterIds).toEqual(["dlq_good"]);
    expect(persistFailure).toHaveBeenCalledTimes(2);
  });

  it("does not count a half-reap when the atomic persistence boundary throws", async () => {
    const deps = makeDeps({
      findStalled: vi.fn(async () => [stalledNode()]),
      persistFailure: vi.fn(async () => {
        throw new Error("transaction failed");
      }),
    });

    const result = await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 500 });

    expect(result).toEqual({
      scanned: 1,
      reaped: 0,
      deadLettered: 0,
      skipped: 0,
      deadLetterIds: [],
    });
  });

  it("forwards only bounded server-authored drill provenance", async () => {
    const inputJson = {
      ...snapshot("call_api"),
      drill: {
        kind: "solution_pack_drill",
        packId: "incident-triage",
        fixtureId: "worker_interrupted",
        failureMode: "worker_stalled",
        recoveryPath: "stalled_node_reaper",
        ignored: "not forwarded",
      },
    };
    const deps = makeDeps({ findStalled: vi.fn(async () => [stalledNode({ inputJson })]) });

    await reapStalledNodes(deps, { thresholdMs: 60 * 60_000, limit: 1 });

    expect(deps.persistFailure).toHaveBeenCalledWith(expect.objectContaining({
      eventMetadata: {
        drill: {
          kind: "solution_pack_drill",
          packId: "incident-triage",
          fixtureId: "worker_interrupted",
          failureMode: "worker_stalled",
          recoveryPath: "stalled_node_reaper",
        },
      },
    }));
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
