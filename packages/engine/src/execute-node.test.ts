/**
 * Regression tests for the run-input plumbing (fourth-wave audit B-01):
 * `executeNode` must merge the run's start/trigger input (persisted at
 * `runs.inputJson.input`, surfaced by `getRunMetadata`) onto the per-node
 * context as `context.input` — the contract the trigger executors and
 * `{{context.input.*}}` templates depend on. Before the fix the key was
 * never populated in production (only the sandbox seeded it), so trigger
 * payloads were silently dropped.
 *
 * `./persistence` and `./node-registry` are mocked at the module boundary;
 * template rendering and config-schema parsing run REAL so the tests prove
 * the actual scope templates resolve against.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const executorMock = vi.fn().mockResolvedValue({ status: "succeeded", output: { ok: true } });
const getRunContextMock = vi.fn();
const getRunMetadataMock = vi.fn();
const isWriteSideNodeMock = vi.fn().mockReturnValue(false);

vi.mock("./node-registry", () => ({
  nodeRegistry: {
    // No entry in NODE_CONFIG_SCHEMAS for this type, so executeNode falls
    // through to the loose post-template config — letting the tests assert
    // the RENDERED config without a schema stripping unknown keys.
    test_probe: (ctx: unknown) => executorMock(ctx),
  },
  isWriteSideNode: (...args: unknown[]) => isWriteSideNodeMock(...args),
}));

vi.mock("./persistence", () => ({
  getRunContext: (...args: unknown[]) => getRunContextMock(...args),
  getRunMetadata: (...args: unknown[]) => getRunMetadataMock(...args),
}));

import { executeNode } from "./execute-node";

const BASE_META = {
  orgId: "org-1",
  workflowVersionId: "wfv-1",
  workflowId: "wf-1",
  createdBy: null,
  replayMode: null,
};

describe("executeNode run-input plumbing (B-01)", () => {
  beforeEach(() => {
    executorMock.mockClear();
    getRunContextMock.mockReset();
    getRunMetadataMock.mockReset();
  });

  it("merges the run input as context.input so trigger executors can read it", async () => {
    getRunMetadataMock.mockResolvedValue({
      ...BASE_META,
      input: { event: { subject: "refund request", from: "a@b.co" } },
    });
    getRunContextMock.mockResolvedValue({});

    await executeNode({ runId: "run-1", node: { id: "t1", type: "test_probe", config: {} } as never });

    expect(executorMock).toHaveBeenCalledTimes(1);
    const ctx = executorMock.mock.calls[0][0] as { context: Record<string, unknown> };
    expect(ctx.context.input).toEqual({ event: { subject: "refund request", from: "a@b.co" } });
  });

  it("resolves {{context.input.*}} templates in node config against the run input", async () => {
    getRunMetadataMock.mockResolvedValue({
      ...BASE_META,
      input: { customer: { email: "ops@acme.io" } },
    });
    getRunContextMock.mockResolvedValue({});

    await executeNode({
      runId: "run-1",
      node: { id: "n1", type: "test_probe", config: { to: "{{context.input.customer.email}}" } } as never,
    });

    const ctx = executorMock.mock.calls[0][0] as { config: Record<string, unknown> };
    expect(ctx.config.to).toBe("ops@acme.io");
  });

  it("never clobbers a legacy node whose id is literally 'input'", async () => {
    getRunMetadataMock.mockResolvedValue({ ...BASE_META, input: { event: { fresh: true } } });
    getRunContextMock.mockResolvedValue({
      input: { status: "succeeded", attempts: 1, state: {}, output: { legacy: true }, error: null },
    });

    await executeNode({ runId: "run-1", node: { id: "n1", type: "test_probe", config: {} } as never });

    const ctx = executorMock.mock.calls[0][0] as { context: Record<string, any> };
    // The guarded merge keeps the node's slot — byte-for-byte legacy behaviour.
    expect(ctx.context.input.output).toEqual({ legacy: true });
    expect(ctx.context.input.event).toBeUndefined();
  });

  it("falls back to an empty object when the run carries no input block", async () => {
    getRunMetadataMock.mockResolvedValue({ ...BASE_META, input: undefined });
    getRunContextMock.mockResolvedValue({});

    await executeNode({ runId: "run-1", node: { id: "n1", type: "test_probe", config: {} } as never });

    const ctx = executorMock.mock.calls[0][0] as { context: Record<string, unknown> };
    expect(ctx.context.input).toEqual({});
  });
});

describe("executeNode timeout enforcement (Q-01)", () => {
  beforeEach(() => {
    executorMock.mockReset();
    getRunContextMock.mockReset().mockResolvedValue({});
    getRunMetadataMock.mockReset().mockResolvedValue({ ...BASE_META, input: {} });
    isWriteSideNodeMock.mockReset().mockReturnValue(false);
  });

  it("enforces config.timeoutMs at the chokepoint — a hung executor throws NODE_TIMEOUT (freeing the worker)", async () => {
    // Executor that never resolves — pre-Q-01 this blocked the worker until
    // the 5-minute reaper. Now withTimeout rejects at config.timeoutMs.
    executorMock.mockReturnValue(new Promise(() => {}));

    const err = await executeNode({
      runId: "run-1",
      node: { id: "n1", type: "test_probe", config: { timeoutMs: 40 } } as never,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("NODE_TIMEOUT");
    expect((err as Error).message).toContain("test_probe timed out after 40ms");
  });

  it("flags writeSide on a write-side node's timeout so a blind replay can be gated", async () => {
    executorMock.mockReturnValue(new Promise(() => {}));
    isWriteSideNodeMock.mockReturnValue(true);

    const err = await executeNode({
      runId: "run-1",
      node: { id: "n1", type: "test_probe", config: { timeoutMs: 40 } } as never,
    }).catch((e) => e);

    expect((err as { code?: string; writeSide?: boolean }).code).toBe("NODE_TIMEOUT");
    expect((err as { writeSide?: boolean }).writeSide).toBe(true);
  });

  it("leaves writeSide false for a read-side node's timeout", async () => {
    executorMock.mockReturnValue(new Promise(() => {}));
    isWriteSideNodeMock.mockReturnValue(false);

    const err = await executeNode({
      runId: "run-1",
      node: { id: "n1", type: "test_probe", config: { timeoutMs: 40 } } as never,
    }).catch((e) => e);

    expect((err as { writeSide?: boolean }).writeSide).toBe(false);
  });

  it("passes through unchanged when no timeout is declared (behavior-preserving)", async () => {
    executorMock.mockResolvedValue({ status: "succeeded", output: { ok: true } });

    const result = await executeNode({
      runId: "run-1",
      node: { id: "n1", type: "test_probe", config: {} } as never,
    });

    expect(result.status).toBe("succeeded");
    expect(isWriteSideNodeMock).not.toHaveBeenCalled();
  });

  it("swallows the abandoned executor's late rejection (no unhandled rejection) after the timeout won", async () => {
    // Executor rejects AFTER the node already timed out. withTimeout attaches a
    // catch so this doesn't surface as an unhandledRejection.
    let rejectLate: (e: unknown) => void = () => {};
    executorMock.mockReturnValue(new Promise((_, reject) => { rejectLate = reject; }));
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const err = await executeNode({
        runId: "run-1",
        node: { id: "n1", type: "test_probe", config: { timeoutMs: 30 } } as never,
      }).catch((e) => e);
      expect((err as { code?: string }).code).toBe("NODE_TIMEOUT");
      // Now the abandoned executor rejects late.
      rejectLate(new Error("upstream 500 (arrived after timeout)"));
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
