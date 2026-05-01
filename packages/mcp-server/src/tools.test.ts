import { describe, expect, it, vi } from "vitest";
import { dispatchTool, tools } from "./tools";

function makeMockCallApi() {
  const calls: string[] = [];
  const mock = vi.fn(async (path: string) => {
    calls.push(path);
    return { ok: true, path };
  });
  return { mock, calls };
}

describe("MCP tool catalog", () => {
  it("exposes the five read-only tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "recipes.list",
      "runs.get",
      "tools.list",
      "workflows.get",
      "workflows.list",
    ]);
  });

  it("declares JSON Schema input shapes (not Zod) on every tool", () => {
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect((tool.inputSchema as { type?: string }).type).toBe("object");
    }
  });
});

describe("dispatchTool", () => {
  it("workflows.list with no args hits /workflows", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.list", {});
    expect(mock).toHaveBeenCalledWith("/workflows");
  });

  it("workflows.list threads the limit query param when provided", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.list", { limit: 50 });
    expect(mock).toHaveBeenCalledWith("/workflows?limit=50");
  });

  it("workflows.get URL-encodes the workflowId", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.get", { workflowId: "wf with space" });
    expect(mock).toHaveBeenCalledWith("/workflows/latest?workflowId=wf%20with%20space");
  });

  it("workflows.get throws when workflowId is missing", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.get", {})).rejects.toThrow(/workflowId/);
  });

  it("recipes.list and tools.list are no-arg passthroughs", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "recipes.list", {});
    await dispatchTool(mock, "tools.list", {});
    expect(mock).toHaveBeenNthCalledWith(1, "/templates");
    expect(mock).toHaveBeenNthCalledWith(2, "/tools");
  });

  it("runs.get builds a URLSearchParams query with eventsLimit + cursor", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.get", {
      runId: "run-42",
      eventsLimit: 50,
      eventsCursor: "2024-01-01T00:00:00.000Z|evt-x",
    });
    const path = mock.mock.calls[0][0];
    expect(path).toMatch(/^\/run\?/);
    expect(path).toContain("runId=run-42");
    expect(path).toContain("eventsLimit=50");
    expect(path).toContain(
      "eventsCursor=2024-01-01T00%3A00%3A00.000Z%7Cevt-x",
    );
  });

  it("runs.get throws when runId is missing", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "runs.get", {})).rejects.toThrow(/runId/);
  });

  it("rejects unknown tools by name", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "totally.fake", {})).rejects.toThrow(/Unknown MCP tool/);
  });

  it("wraps the API response in the MCP text content-block format", async () => {
    const { mock } = makeMockCallApi();
    const result = await dispatchTool(mock, "workflows.list", {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain('"path"');
  });
});
