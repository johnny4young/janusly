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

vi.mock("./node-registry", () => ({
  nodeRegistry: {
    // No entry in NODE_CONFIG_SCHEMAS for this type, so executeNode falls
    // through to the loose post-template config — letting the tests assert
    // the RENDERED config without a schema stripping unknown keys.
    test_probe: (ctx: unknown) => executorMock(ctx),
  },
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
