/**
 * Tests for the `mcp_tool` executor branch in `node-registry`.
 * Verifies the executor wires `NodeContext` into `executeMcpTool`'s
 * input shape, returns the normalised output on success, and throws
 * on failure so the run's retry / DLQ machinery applies.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./persistence")>();
  return {
    ...actual,
    appendEvent: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: vi.fn(async () => ({
    ai: {} as never,
    http: {} as never,
    email: {} as never,
    runs: {} as never,
    mcp: { writeConsent: false, clientWriteConsent: true, clientRateLimitPerMin: 60, clientCommandAllowlist: "" },
    integrations: {} as never,
    objectstore: {} as never,
  })),
  applyOrgConfigToEnv: vi.fn(),
}));

vi.mock("./mcp-tool-executor", () => ({
  executeMcpTool: vi.fn(),
  readMcpClientWritesEnabled: vi.fn(() => true),
  resolveMcpClientRateLimitPerMin: vi.fn(() => 60),
}));

import { executeMcpTool } from "./mcp-tool-executor";
import { nodeRegistry, type NodeContext } from "./node-registry";

const executeMcpToolMock = vi.mocked(executeMcpTool);

const baseCtx: Omit<NodeContext, "config"> = {
  runId: "run-1",
  nodeId: "step-1",
  orgId: "org-1",
  workflowId: null,
  context: {},
};

beforeEach(() => {
  executeMcpToolMock.mockReset();
});

describe("mcp_tool node executor", () => {
  it("returns completed + output on a successful envelope", async () => {
    executeMcpToolMock.mockResolvedValueOnce({
      ok: true,
      output: { text: "ok" },
      latencyMs: 5,
      connectionAlias: "demo",
      toolName: "do_thing",
      transport: "stdio",
      writeSide: false,
    });
    const result = await nodeRegistry.mcp_tool({
      ...baseCtx,
      config: { connectionAlias: "demo", toolName: "do_thing", input: { value: 1 } },
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ text: "ok" });
    }
    expect(executeMcpToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        connectionAlias: "demo",
        toolName: "do_thing",
        writeConsentProcess: true,
        writeConsentTenant: true,
      }),
    );
  });

  it("throws on a failed envelope so retry/DLQ applies", async () => {
    executeMcpToolMock.mockResolvedValueOnce({
      ok: false,
      error: "rate limit exceeded",
      latencyMs: 1,
      connectionAlias: "demo",
      toolName: "do_thing",
      transport: "stdio",
      writeSide: false,
    });
    await expect(
      nodeRegistry.mcp_tool({
        ...baseCtx,
        config: { connectionAlias: "demo", toolName: "do_thing" },
      }),
    ).rejects.toThrow(/rate limit exceeded/);
  });

  it("rejects when config is missing required fields", async () => {
    await expect(nodeRegistry.mcp_tool({ ...baseCtx, config: { toolName: "x" } })).rejects.toThrow(/connectionAlias/);
    await expect(nodeRegistry.mcp_tool({ ...baseCtx, config: { connectionAlias: "x" } })).rejects.toThrow(/toolName/);
  });
});
