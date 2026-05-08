import { describe, expect, it, vi } from "vitest";
import { dispatchTool, tools } from "./tools";

function makeMockCallApi() {
  const calls: string[] = [];
  const mock = vi.fn(async (path: string, _init?: RequestInit) => {
    calls.push(path);
    return { ok: true, path };
  });
  return { mock, calls };
}

describe("MCP tool catalog", () => {
  it("exposes the eleven tools (9 read-only, 2 pre-flight POST, 0 writes)", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "dlq.list",
      "recipes.list",
      "runs.get",
      "runs.list",
      "tools.list",
      "workflows.get",
      "workflows.health",
      "workflows.list",
      "workflows.readiness",
      "workflows.validate",
      "workflows.versions",
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

  it("workflows.save is disabled and never calls the API", async () => {
    const { mock } = makeMockCallApi();
    const workflow = { id: "wf1", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await expect(dispatchTool(mock, "workflows.save", { workflow })).rejects.toThrow(/disabled.*consent policy/i);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.validate POSTs the workflow body to /validate", async () => {
    const { mock } = makeMockCallApi();
    const workflow = { nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await dispatchTool(mock, "workflows.validate", { workflow });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/validate");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(workflow);
  });

  it("workflows.validate throws when workflow is missing or not a plain object", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.validate", {})).rejects.toThrow(/workflow.*object/);
    await expect(dispatchTool(mock, "workflows.validate", { workflow: 42 })).rejects.toThrow(/workflow.*object/);
    expect(mock).not.toHaveBeenCalled();
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

  it("workflows.versions URL-encodes the workflowId", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.versions", { workflowId: "wf with space" });
    expect(mock).toHaveBeenCalledWith("/workflows/versions?workflowId=wf%20with%20space");
  });

  it("workflows.versions throws when workflowId is missing", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.versions", {})).rejects.toThrow(/workflowId/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.health URL-encodes the workflowId", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.health", { workflowId: "wf-1" });
    expect(mock).toHaveBeenCalledWith("/workflows/health?workflowId=wf-1");
  });

  it("workflows.health throws when workflowId is missing", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.health", {})).rejects.toThrow(/workflowId/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.readiness POSTs the workflow body to /workflows/readiness", async () => {
    const { mock } = makeMockCallApi();
    const workflow = { dslVersion: "1.0", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await dispatchTool(mock, "workflows.readiness", { workflow });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/workflows/readiness");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(workflow);
  });

  it("workflows.readiness throws when workflow is missing or not a plain object", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.readiness", {})).rejects.toThrow(/workflow.*object/);
    await expect(dispatchTool(mock, "workflows.readiness", { workflow: 42 })).rejects.toThrow(/workflow.*object/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("runs.list with no args hits /runs without query params", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.list", {});
    expect(mock).toHaveBeenCalledWith("/runs");
  });

  it("runs.list threads workflowId + limit when provided", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.list", { workflowId: "wf-1", limit: 50 });
    const path = mock.mock.calls[0][0] as string;
    expect(path).toMatch(/^\/runs\?/);
    expect(path).toContain("workflowId=wf-1");
    expect(path).toContain("limit=50");
  });

  it("runs.list drops out-of-shape limit values", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.list", { limit: "not-a-number" as unknown as number });
    expect(mock).toHaveBeenCalledWith("/runs");
  });

  it("dlq.list with no args hits /dlq without query params", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.list", {});
    expect(mock).toHaveBeenCalledWith("/dlq");
  });

  it("dlq.list threads status + limit when provided", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.list", { status: "open", limit: 25 });
    const path = mock.mock.calls[0][0] as string;
    expect(path).toMatch(/^\/dlq\?/);
    expect(path).toContain("status=open");
    expect(path).toContain("limit=25");
  });

  it("dlq.list rejects invalid status before broadening to the full DLQ list", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "dlq.list", { status: "pending" })).rejects.toThrow(/status/);
    expect(mock).not.toHaveBeenCalled();
  });
});
