import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the targeted-fork sandbox replay (`replayRunAsValidationFork`).
 * Pins:
 *   - Predecessor computation walks edges backwards correctly (linear,
 *     diamond, disconnected).
 *   - Predecessors are cloned with `status='succeeded'` + source stateJson.
 *   - The fork node and its publication marker commit as `queued`.
 *   - Downstream nodes stay `pending`; sibling/disconnected nodes are skipped.
 *   - The route's discriminated error paths fire on missing fork node and
 *     not-succeeded predecessor.
 *   - Only the fork node is enqueued — predecessors never queue.
 */

type FakeRunNodeRow = {
  id: string;
  runId: string;
  nodeId: string;
  status: string;
  stateJson: unknown;
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorJson: unknown;
};

const {
  appendEventMock,
  enqueueNodeMock,
  runEventsTable,
  runNodesTable,
  runsTable,
  safePersistPayloadMock,
  txInsertMock,
  selectFromMock,
  sourceRunNodes,
} = vi.hoisted(() => ({
  appendEventMock: vi.fn().mockResolvedValue(undefined),
  enqueueNodeMock: vi.fn().mockResolvedValue(undefined),
  runEventsTable: { name: "runEvents" },
  runNodesTable: { name: "runNodes" },
  runsTable: { name: "runs" },
  safePersistPayloadMock: vi.fn((payload: unknown) => payload),
  txInsertMock: vi.fn(),
  selectFromMock: vi.fn(),
  sourceRunNodes: [] as FakeRunNodeRow[],
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        selectFromMock(table);
        return {
          where: (_: unknown) => Promise.resolve(sourceRunNodes),
        };
      },
    }),
    transaction: (fn: any) =>
      fn({
        insert: (table: unknown) => ({
          values: (values: unknown) => {
            txInsertMock(table, values);
            return Promise.resolve(undefined);
          },
        }),
      }),
  },
  runs: runsTable,
  runNodes: runNodesTable,
  runEvents: runEventsTable,
}));

vi.mock("../queue", () => ({ enqueueNode: enqueueNodeMock }));
vi.mock("../persistence", () => ({
  markQueuePublicationSucceeded: vi.fn().mockResolvedValue(true),
  appendEvent: appendEventMock,
}));
vi.mock("../safe-persist", () => ({ safePersistPayload: safePersistPayloadMock }));

import { computePredecessors, computeSuccessors, replayRunAsValidationFork } from "./replay-lab";

// ────────── workflows used across tests ──────────

const linearWorkflow = {
  dslVersion: "1.0" as const,
  nodes: [
    { id: "A", type: "noop" as const, config: {} },
    { id: "B", type: "noop" as const, config: {} },
    { id: "C", type: "noop" as const, config: {} },
    { id: "D", type: "noop" as const, config: {} },
  ],
  edges: [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
    { from: "C", to: "D" },
  ],
};

const diamondWorkflow = {
  dslVersion: "1.0" as const,
  nodes: [
    { id: "root", type: "noop" as const, config: {} },
    { id: "left", type: "noop" as const, config: {} },
    { id: "right", type: "noop" as const, config: {} },
    { id: "join", type: "noop" as const, config: {} },
  ],
  edges: [
    { from: "root", to: "left" },
    { from: "root", to: "right" },
    { from: "left", to: "join" },
    { from: "right", to: "join" },
  ],
};

const isolatedWorkflow = {
  dslVersion: "1.0" as const,
  nodes: [
    { id: "alone", type: "noop" as const, config: {} },
    { id: "unrelated_a", type: "noop" as const, config: {} },
    { id: "unrelated_b", type: "noop" as const, config: {} },
  ],
  edges: [{ from: "unrelated_a", to: "unrelated_b" }],
};

beforeEach(() => {
  appendEventMock.mockClear();
  enqueueNodeMock.mockClear();
  txInsertMock.mockClear();
  selectFromMock.mockClear();
  sourceRunNodes.length = 0;
});

// ────────── computePredecessors (pure helper) ──────────

describe("computePredecessors", () => {
  it("returns the chain of upstream nodes in a linear workflow", () => {
    const preds = computePredecessors(linearWorkflow, "C");
    expect([...preds].sort()).toEqual(["A", "B"]);
  });

  it("includes both branches of a diamond pattern", () => {
    const preds = computePredecessors(diamondWorkflow, "join");
    expect([...preds].sort()).toEqual(["left", "right", "root"]);
  });

  it("returns empty for a fork node with no upstream edges", () => {
    const preds = computePredecessors(isolatedWorkflow, "alone");
    expect(preds.size).toBe(0);
  });

  it("does NOT include the fork node itself", () => {
    const preds = computePredecessors(linearWorkflow, "C");
    expect(preds.has("C")).toBe(false);
  });
});

describe("computeSuccessors", () => {
  it("returns the downstream chain in a linear workflow", () => {
    const successors = computeSuccessors(linearWorkflow, "B");
    expect([...successors].sort()).toEqual(["C", "D"]);
  });

  it("includes both downstream branches in a diamond pattern", () => {
    const successors = computeSuccessors(diamondWorkflow, "root");
    expect([...successors].sort()).toEqual(["join", "left", "right"]);
  });

  it("returns empty for a node with no downstream edges", () => {
    const successors = computeSuccessors(isolatedWorkflow, "alone");
    expect(successors.size).toBe(0);
  });
});

// ────────── replayRunAsValidationFork ──────────

function seedSourceRun(
  sourceRunId: string,
  rows: Array<{ nodeId: string; status: string; stateJson?: unknown }>,
) {
  sourceRunNodes.length = 0;
  for (const row of rows) {
    sourceRunNodes.push({
      id: `src-${row.nodeId}`,
      runId: sourceRunId,
      nodeId: row.nodeId,
      status: row.status,
      stateJson: row.stateJson ?? { source: true, node: row.nodeId },
      attempts: 1,
      startedAt: new Date("2025-01-01T00:00:00Z"),
      finishedAt: new Date("2025-01-01T00:00:10Z"),
      errorJson: null,
    });
  }
}

describe("replayRunAsValidationFork — happy path", () => {
  it("clones predecessors as succeeded and seeds the fork node with override", async () => {
    seedSourceRun("src-1", [
      { nodeId: "A", status: "succeeded", stateJson: { output: "from A" } },
      { nodeId: "B", status: "succeeded", stateJson: { output: "from B" } },
    ]);

    const result = await replayRunAsValidationFork({
      orgId: "org-1",
      sourceRunId: "src-1",
      workflow: linearWorkflow,
      forkNodeId: "C",
      inputOverride: { tweaked: true },
      createdBy: "user-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.predecessorCount).toBe(2);

    // Verify the runs insert.
    const runsInsert = txInsertMock.mock.calls.find(([table]) => table === runsTable);
    expect(runsInsert).toBeDefined();
    expect(runsInsert![1]).toMatchObject({
      orgId: "org-1",
      status: "running",
      replayMode: "validation",
      parentRunId: "src-1",
      parentNodeId: "C",
      createdBy: "user-1",
    });

    // Verify the run_nodes insert: 4 rows (A, B, C, D), preds=succeeded,
    // C=queued atomically, D=downstream pending.
    const nodesInsert = txInsertMock.mock.calls.find(([table]) => table === runNodesTable);
    expect(nodesInsert).toBeDefined();
    const nodeRows = nodesInsert![1] as Array<{ nodeId: string; status: string; stateJson: unknown }>;
    const byId = new Map(nodeRows.map((r) => [r.nodeId, r] as const));
    expect(byId.get("A")?.status).toBe("succeeded");
    expect(byId.get("A")?.stateJson).toMatchObject({ output: "from A" });
    expect(byId.get("B")?.status).toBe("succeeded");
    expect(byId.get("C")).toMatchObject({
      status: "queued",
      attempts: 1,
      queuePublicationRepairAfter: expect.any(Date),
      queuePublicationGeneration: 1,
    });
    expect(byId.get("C")?.stateJson).toMatchObject({ input: { tweaked: true } });
    expect(byId.get("D")?.status).toBe("pending");

    // Verify the run.started.replay-lab-fork event was written.
    const eventsInsert = txInsertMock.mock.calls.find(([table]) => table === runEventsTable);
    expect(eventsInsert).toBeDefined();
    expect(eventsInsert![1]).toMatchObject({
      type: "run.started.replay-lab-fork",
      payload: expect.objectContaining({
        sourceRunId: "src-1",
        forkNodeId: "C",
        predecessorCount: 2,
        hasOverride: true,
      }),
    });

    // Only the fork node was queued — predecessors never queue.
    expect(enqueueNodeMock).toHaveBeenCalledTimes(1);
  });

  it("seeds the fork node with empty state when no override is supplied", async () => {
    seedSourceRun("src-1", [
      { nodeId: "A", status: "succeeded" },
      { nodeId: "B", status: "succeeded" },
    ]);

    const result = await replayRunAsValidationFork({
      orgId: "org-1",
      sourceRunId: "src-1",
      workflow: linearWorkflow,
      forkNodeId: "C",
      // no inputOverride
      createdBy: "user-1",
    });

    expect(result.ok).toBe(true);

    const nodesInsert = txInsertMock.mock.calls.find(([table]) => table === runNodesTable);
    const nodeRows = nodesInsert![1] as Array<{ nodeId: string; stateJson: unknown }>;
    const cRow = nodeRows.find((r) => r.nodeId === "C");
    // safePersistPayload mock just passes through, so {} is the seed.
    expect(cRow?.stateJson).toEqual({});
  });

  it("handles diamond predecessors — each ancestor cloned once", async () => {
    seedSourceRun("src-2", [
      { nodeId: "root", status: "succeeded" },
      { nodeId: "left", status: "succeeded" },
      { nodeId: "right", status: "succeeded" },
    ]);

    const result = await replayRunAsValidationFork({
      orgId: "org-1",
      sourceRunId: "src-2",
      workflow: diamondWorkflow,
      forkNodeId: "join",
      createdBy: "user-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.predecessorCount).toBe(3);

    const nodesInsert = txInsertMock.mock.calls.find(([table]) => table === runNodesTable);
    const nodeRows = nodesInsert![1] as Array<{ nodeId: string; status: string }>;
    expect(nodeRows.filter((r) => r.nodeId === "root")).toHaveLength(1);
    expect(nodeRows.filter((r) => r.nodeId === "left")).toHaveLength(1);
    expect(nodeRows.filter((r) => r.nodeId === "right")).toHaveLength(1);
    expect(nodeRows.find((r) => r.nodeId === "root")?.status).toBe("succeeded");
    expect(nodeRows.find((r) => r.nodeId === "join")?.status).toBe("queued");
  });

  it("works on a disconnected fork node — no predecessors cloned", async () => {
    // No source rows needed because no preds.
    seedSourceRun("src-3", []);

    const result = await replayRunAsValidationFork({
      orgId: "org-1",
      sourceRunId: "src-3",
      workflow: isolatedWorkflow,
      forkNodeId: "alone",
      inputOverride: { foo: "bar" },
      createdBy: "user-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.predecessorCount).toBe(0);

    // The other two nodes are still in the workflow but are outside the
    // fork path, so they are skipped and never queued by the runtime cascade.
    const nodesInsert = txInsertMock.mock.calls.find(([table]) => table === runNodesTable);
    const nodeRows = nodesInsert![1] as Array<{ nodeId: string; status: string }>;
    expect(nodeRows.find((r) => r.nodeId === "unrelated_a")?.status).toBe("skipped");
    expect(nodeRows.find((r) => r.nodeId === "unrelated_b")?.status).toBe("skipped");
    expect(nodeRows.find((r) => r.nodeId === "alone")?.status).toBe("queued");
  });
});

// ────────── error paths ──────────

describe("replayRunAsValidationFork — error paths", () => {
  it("returns fork_node_not_found when the node id is not in the workflow", async () => {
    const result = await replayRunAsValidationFork({
      orgId: "org-1",
      sourceRunId: "src-1",
      workflow: linearWorkflow,
      forkNodeId: "ghost",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.code).toBe("fork_node_not_found");
    // No DB writes should happen on validation failure.
    expect(txInsertMock).not.toHaveBeenCalled();
  });

  it("returns predecessor_not_succeeded when a predecessor failed in the source run", async () => {
    seedSourceRun("src-1", [
      { nodeId: "A", status: "succeeded" },
      { nodeId: "B", status: "failed" }, // B is required for C but failed
    ]);

    const result = await replayRunAsValidationFork({
      orgId: "org-1",
      sourceRunId: "src-1",
      workflow: linearWorkflow,
      forkNodeId: "C",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.code).toBe("predecessor_not_succeeded");
    expect(result.message).toContain("B");
    // Critical: no run / nodes / events written when validation fails.
    expect(txInsertMock).not.toHaveBeenCalled();
  });

  it("returns predecessor_not_succeeded when a predecessor is missing entirely from the source run", async () => {
    // Source run only has A; B is missing (the engine never created the row).
    seedSourceRun("src-1", [{ nodeId: "A", status: "succeeded" }]);

    const result = await replayRunAsValidationFork({
      orgId: "org-1",
      sourceRunId: "src-1",
      workflow: linearWorkflow,
      forkNodeId: "C",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.code).toBe("predecessor_not_succeeded");
  });
});
