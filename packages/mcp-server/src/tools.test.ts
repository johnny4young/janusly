import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchTool, listTools, tools } from "./tools";

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeMockCallApi() {
  const calls: string[] = [];
  const mock = vi.fn(async (path: string, _init?: RequestInit) => {
    calls.push(path);
    return { ok: true, path };
  });
  return { mock, calls };
}

describe("MCP tool catalog", () => {
  it("exposes the read-only surface by default (no write surface)", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ai.generate_workflow",
      "ai.patch_workflow",
      "dlq.clusters",
      "dlq.list",
      "mcp.connections.list",
      "mcp.connections.tools",
      "recipes.list",
      "recovery.metrics",
      "reports.run_explain",
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
    // The gated write surface is absent by default.
    for (const write of ["workflows.save", "runs.start", "dlq.replay", "mcp.connections.create"]) {
      expect(names).not.toContain(write);
    }
  });

  it("appends the full write surface only when JANUSLY_MCP_WRITES_ENABLED=true", () => {
    const off = listTools({ JANUSLY_MCP_WRITES_ENABLED: "" });
    const on = listTools({ JANUSLY_MCP_WRITES_ENABLED: "true" });

    const writeNames = [
      "workflows.save",
      "workflows.rollback",
      "runs.start",
      "runs.resume",
      "runs.cancel",
      "dlq.replay",
      "mcp.connections.create",
      "mcp.connections.rediscover",
      "mcp.connections.set_tool",
      "mcp.connections.delete",
    ];
    for (const name of writeNames) {
      expect(off.find((t) => t.name === name)).toBeUndefined();
      expect(on.find((t) => t.name === name)).toBeDefined();
    }
    // The read surface stays present in both modes.
    expect(on.find((t) => t.name === "ai.generate_workflow")).toBeDefined();
    expect(off.find((t) => t.name === "ai.generate_workflow")).toBeDefined();
  });

  it("treats any non-'true' env value as off when computing the catalog", () => {
    for (const value of ["1", "yes", "TRUE", "on"]) {
      const list = listTools({ JANUSLY_MCP_WRITES_ENABLED: value });
      expect(list.find((t) => t.name === "workflows.save")).toBeUndefined();
    }
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

  it("workflows.save is rejected with a clear error when the env flag is off (default)", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    const { mock } = makeMockCallApi();
    const workflow = { id: "wf1", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await expect(dispatchTool(mock, "workflows.save", { workflow })).rejects.toThrow(/JANUSLY_MCP_WRITES_ENABLED/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.save POSTs to /workflows/save when env is on", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const workflow = { dslVersion: "1.0", id: "wf1", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await dispatchTool(mock, "workflows.save", { workflow });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/workflows/save");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(workflow);
  });

  it("workflows.save with dryRun: true routes to /validate instead of /workflows/save", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const workflow = { dslVersion: "1.0", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await dispatchTool(mock, "workflows.save", { workflow, dryRun: true });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/validate");
    expect(init?.method).toBe("POST");
    // Dispatcher reshapes the call result into { mode: "dry-run", validation }
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("workflows.save with env on still rejects when the workflow body is missing", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.save", {})).rejects.toThrow(/workflow.*object/);
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

  // -------- dlq.clusters --------

  it("dlq.clusters with no args hits /dlq/clusters without query params", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.clusters", {});
    expect(mock).toHaveBeenCalledWith("/dlq/clusters");
  });

  it("dlq.clusters threads windowDays when provided", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.clusters", { windowDays: 14 });
    expect(mock).toHaveBeenCalledWith("/dlq/clusters?windowDays=14");
  });

  it("dlq.clusters drops out-of-shape windowDays values (no NaN injection)", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.clusters", { windowDays: "not-a-number" as unknown as number });
    expect(mock).toHaveBeenCalledWith("/dlq/clusters");
  });

  // -------- recovery.metrics --------

  it("recovery.metrics with no args hits /recovery/metrics without query params", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "recovery.metrics", {});
    expect(mock).toHaveBeenCalledWith("/recovery/metrics");
  });

  it("recovery.metrics threads windowDays when provided", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "recovery.metrics", { windowDays: 7 });
    expect(mock).toHaveBeenCalledWith("/recovery/metrics?windowDays=7");
  });

  it("recovery.metrics drops zero/negative windowDays as no-op", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "recovery.metrics", { windowDays: 0 });
    expect(mock).toHaveBeenCalledWith("/recovery/metrics");
  });

  // -------- reports.run_explain --------

  it("reports.run_explain forces format=json so the client gets a structured envelope", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "reports.run_explain", { runId: "run-77" });
    const path = mock.mock.calls[0][0] as string;
    expect(path).toMatch(/^\/reports\/run-explain\?/);
    expect(path).toContain("runId=run-77");
    expect(path).toContain("format=json");
  });

  it("reports.run_explain URL-encodes the runId", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "reports.run_explain", { runId: "run with space" });
    const path = mock.mock.calls[0][0] as string;
    expect(path).toContain("runId=run+with+space");
  });

  it("reports.run_explain throws when runId is missing", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "reports.run_explain", {})).rejects.toThrow(/runId/);
    expect(mock).not.toHaveBeenCalled();
  });

  // -------- ai.patch_workflow --------

  it("ai.patch_workflow POSTs the deadLetterId to /ai/patch-workflow", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "ai.patch_workflow", { deadLetterId: "dlq-99" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/ai/patch-workflow");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ deadLetterId: "dlq-99" });
  });

  it("ai.patch_workflow throws when deadLetterId is missing", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "ai.patch_workflow", {})).rejects.toThrow(/deadLetterId/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("ai.patch_workflow throws when deadLetterId is an empty string (not a fallthrough to listing)", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "ai.patch_workflow", { deadLetterId: "" })).rejects.toThrow(/deadLetterId/);
    expect(mock).not.toHaveBeenCalled();
  });

  // -------- ai.generate_workflow (read-only surface) --------

  it("ai.generate_workflow POSTs the prompt to /ai/generate-workflow (no write flag needed)", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "ai.generate_workflow", { prompt: "email a receipt when a payment lands" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/ai/generate-workflow");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ prompt: "email a receipt when a payment lands" });
  });

  it("ai.generate_workflow throws on an empty prompt", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "ai.generate_workflow", { prompt: "  " })).rejects.toThrow(/prompt/);
    expect(mock).not.toHaveBeenCalled();
  });

  // -------- read-only MCP connection surface --------

  it("mcp.connections.list is a no-arg passthrough to /mcp/connections", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.list", {});
    expect(mock).toHaveBeenCalledWith("/mcp/connections");
  });

  it("mcp.connections.tools URL-encodes the alias", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.tools", { alias: "note book" });
    expect(mock).toHaveBeenCalledWith("/mcp/connections/note%20book/tools");
  });

  // -------- gated write surface: env-off rejection --------

  it("every write tool is rejected with a clear error when the env flag is off", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    const { mock } = makeMockCallApi();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["runs.start", { workflow: { dslVersion: "1.0", nodes: [], edges: [] } }],
      ["runs.resume", { runId: "r1", nodeId: "n1" }],
      ["runs.cancel", { runId: "r1" }],
      ["dlq.replay", { deadLetterId: "dlq-1" }],
      ["workflows.rollback", { workflowId: "wf1", sourceVersionId: "v1" }],
      ["mcp.connections.create", { alias: "notion", transport: "http" }],
      ["mcp.connections.rediscover", { alias: "notion" }],
      ["mcp.connections.set_tool", { alias: "notion", toolName: "pages.update" }],
      ["mcp.connections.delete", { alias: "notion" }],
    ];
    for (const [tool, args] of cases) {
      await expect(dispatchTool(mock, tool, args)).rejects.toThrow(/JANUSLY_MCP_WRITES_ENABLED/);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  // -------- gated write surface: dispatch shape when env-on --------

  it("runs.start POSTs { workflow, input } to /start", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const workflow = { dslVersion: "1.0", id: "wf1", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await dispatchTool(mock, "runs.start", { workflow, input: { amount: 42 } });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/start");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ workflow, input: { amount: 42 } });
  });

  it("runs.resume threads runId/nodeId/input/resumeToken to /resume", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.resume", { runId: "r1", nodeId: "n1", input: { ok: true }, resumeToken: "tok" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/resume");
    expect(JSON.parse(init?.body as string)).toEqual({ runId: "r1", nodeId: "n1", input: { ok: true }, resumeToken: "tok" });
  });

  it("runs.cancel POSTs { runId, reason } to /run/cancel", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.cancel", { runId: "r1", reason: "superseded" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/run/cancel");
    expect(JSON.parse(init?.body as string)).toEqual({ runId: "r1", reason: "superseded" });
  });

  it("dlq.replay accepts deadLetterId OR runId+nodeId, and rejects neither", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.replay", { deadLetterId: "dlq-1" });
    expect(JSON.parse(mock.mock.calls[0][1]?.body as string)).toEqual({ deadLetterId: "dlq-1" });
    await dispatchTool(mock, "dlq.replay", { runId: "r1", nodeId: "n1" });
    expect(JSON.parse(mock.mock.calls[1][1]?.body as string)).toEqual({ runId: "r1", nodeId: "n1" });
    await expect(dispatchTool(mock, "dlq.replay", {})).rejects.toThrow(/deadLetterId/);
  });

  it("workflows.rollback POSTs { workflowId, sourceVersionId } to /workflows/rollback", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.rollback", { workflowId: "wf1", sourceVersionId: "v2" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/workflows/rollback");
    expect(JSON.parse(init?.body as string)).toEqual({ workflowId: "wf1", sourceVersionId: "v2" });
  });

  it("mcp.connections.create POSTs the full body to /mcp/connections", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const body = { alias: "notion", transport: "http", url: "https://mcp.example/notion" };
    await dispatchTool(mock, "mcp.connections.create", body);
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/mcp/connections");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(body);
  });

  it("mcp.connections.set_tool strips alias/toolName from the body and puts them in the path", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.set_tool", { alias: "notion", toolName: "pages.update", enabled: true, writeSide: false });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/mcp/connections/notion/tools/pages.update");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ enabled: true, writeSide: false });
  });

  it("mcp.connections.delete issues a DELETE to the alias path", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.delete", { alias: "notion" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/mcp/connections/notion");
    expect(init?.method).toBe("DELETE");
  });
});
