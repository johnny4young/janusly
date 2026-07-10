/**
 * Tool-node tenant-config wiring. Tool nodes must receive the same cached
 * org snapshot as agent tool calls so new tools cannot silently use process
 * defaults instead of per-tenant settings.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  executeTool: vi.fn(),
  getOrgConfigSnapshot: vi.fn(),
}));

vi.mock("./persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./persistence")>();
  return { ...actual, appendEvent: mocks.appendEvent };
});

vi.mock("./tool-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-registry")>();
  return { ...actual, executeTool: mocks.executeTool };
});

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  applyOrgConfigToEnv: vi.fn(),
  getOrgConfigSnapshot: mocks.getOrgConfigSnapshot,
}));

vi.mock("./memory", () => ({
  getRunMemory: vi.fn().mockResolvedValue([]),
  summarizeMemory: vi.fn(() => []),
}));

vi.mock("./agent-memory", () => ({
  recallAgentEpisodes: vi.fn().mockResolvedValue({ block: "", count: 0 }),
  recordAgentEpisode: vi.fn().mockResolvedValue(undefined),
}));

import { nodeRegistry, type NodeContext } from "./node-registry";

const orgConfig = {
  email: { provider: "resend", from: "ops@example.com", rateLimitPerMin: 41 },
  integrations: {
    slack: { rateLimitPerMin: 42 },
    github: { rateLimitPerMin: 43 },
    webhook: { rateLimitPerMin: 44 },
    pdf: { rateLimitPerMin: 45 },
    db: { rateLimitPerMin: 46 },
  },
  objectstore: { provider: "local" },
};

const baseCtx: Omit<NodeContext, "config"> = {
  runId: "run-1",
  nodeId: "tool-node",
  orgId: "org-1",
  workflowId: "workflow-1",
  context: {},
};

describe("tool node tenant config", () => {
  beforeEach(() => {
    mocks.appendEvent.mockReset();
    mocks.appendEvent.mockResolvedValue(undefined);
    mocks.executeTool.mockReset();
    mocks.executeTool.mockResolvedValue({ ok: true });
    mocks.getOrgConfigSnapshot.mockReset();
    mocks.getOrgConfigSnapshot.mockResolvedValue(orgConfig);
  });

  it("loads and forwards the cached snapshot for a newly registered tenant-aware tool", async () => {
    const input = { template: "# Recovery summary" };

    const result = await nodeRegistry.tool({
      ...baseCtx,
      config: { tool: "pdf.generate", input },
    });

    expect(result).toEqual({ status: "completed", output: { tool: "pdf.generate", result: { ok: true } } });
    expect(mocks.getOrgConfigSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.getOrgConfigSnapshot).toHaveBeenCalledWith("org-1");
    expect(mocks.executeTool).toHaveBeenCalledWith(
      "pdf.generate",
      input,
      {},
      expect.objectContaining({
        orgId: "org-1",
        runId: "run-1",
        nodeId: "tool-node",
        workflowId: "workflow-1",
        email: orgConfig.email,
        integrations: orgConfig.integrations,
        objectstore: orgConfig.objectstore,
      }),
    );
  });
});
