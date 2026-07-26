import { afterEach, describe, expect, it, vi } from "vitest";
import { JanuslyApiError, JanuslyProtocolError } from "./api-client";
import {
  dispatchTool,
  listTools,
  toolErrorResult,
  tools,
} from "./tools";

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
  it("exposes the always-visible inspection and AI surface by default", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ai.generate_workflow",
      "ai.patch_workflow",
      "dlq.clusters",
      "dlq.list",
      "mcp.connections.list",
      "mcp.connections.tools",
      "memory.consent_status",
      "recipes.list",
      "recovery.ledger",
      "recovery.metrics",
      "recovery.my_wins",
      "reports.run_explain",
      "runs.get",
      "runs.list",
      "runs.status",
      "runs.usage",
      "tools.list",
      "workflows.get",
      "workflows.health",
      "workflows.list",
      "workflows.readiness",
      "workflows.schedule_preview",
      "workflows.validate",
      "workflows.versions",
    ]);
    // The gated write surface is absent by default.
    for (const write of [
      "workflows.save",
      "workflows.resume",
      "runs.start",
      "runs.redrive",
      "dlq.replay",
      "mcp.connections.create",
    ]) {
      expect(names).not.toContain(write);
    }
  });

  it("appends the full write surface only when JANUSLY_MCP_WRITES_ENABLED=true", () => {
    const off = listTools({ JANUSLY_MCP_WRITES_ENABLED: "" });
    const on = listTools({ JANUSLY_MCP_WRITES_ENABLED: "true" });

    const writeNames = [
      "workflows.save",
      "workflows.rollback",
      "workflows.resume",
      "runs.start",
      "runs.resume",
      "runs.redrive",
      "runs.cancel",
      "dlq.replay",
      "mcp.connections.create",
      "mcp.connections.update",
      "mcp.connections.rediscover",
      "mcp.connections.set_tool",
      "mcp.connections.delete",
    ];
    for (const name of writeNames) {
      expect(off.find((t) => t.name === name)).toBeUndefined();
      expect(on.find((t) => t.name === name)).toBeDefined();
    }
    // The always-visible surface stays present in both modes.
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
    const sideEffecting = new Set([
      "ai.generate_workflow",
      "ai.patch_workflow",
      "reports.run_explain",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect((tool.inputSchema as { type?: string }).type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema).toEqual({
        type: "object",
        required: ["result"],
        properties: {
          result: {
            description:
              "Normalized Janusly operation data. Stable API transport envelopes are removed before this value is returned.",
          },
        },
        additionalProperties: false,
      });
      expect(tool.annotations).toMatchObject({
        readOnlyHint: !sideEffecting.has(tool.name),
        destructiveHint: false,
      });
    }
    for (const name of sideEffecting) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
      });
    }
  });

  it("advertises explicit risk annotations on the gated write surface", () => {
    const byName = new Map(
      listTools({ JANUSLY_MCP_WRITES_ENABLED: "true" })
        .map((tool) => [tool.name, tool]),
    );

    expect(byName.get("runs.start")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(byName.get("runs.cancel")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.get("runs.redrive")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get("workflows.resume")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(byName.get("mcp.connections.update")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get("mcp.connections.delete")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });

  it("describes integer-only pagination and window arguments truthfully", () => {
    const byName = new Map(
      listTools({ JANUSLY_MCP_WRITES_ENABLED: "true" })
        .map((tool) => [tool.name, tool]),
    );
    const integerFields: Array<[string, string]> = [
      ["workflows.list", "limit"],
      ["runs.get", "eventsLimit"],
      ["runs.list", "limit"],
      ["runs.status", "eventsLimit"],
      ["dlq.list", "limit"],
      ["dlq.clusters", "windowDays"],
      ["recovery.metrics", "windowDays"],
      ["recovery.my_wins", "days"],
    ];
    for (const [toolName, field] of integerFields) {
      const properties = byName.get(toolName)?.inputSchema.properties as
        | Record<string, { type?: string }>
        | undefined;
      expect(properties?.[field]?.type, `${toolName}.${field}`).toBe("integer");
    }
  });
});

describe("dispatchTool", () => {
  it("preserves stable API diagnostics in a structured MCP error result", () => {
    const result = toolErrorResult(new JanuslyApiError(
      "Tenant consent is disabled",
      403,
      "mcp_tenant_disabled",
      "req-denied",
      "/v1/start",
      { action: "runs.start" },
    ));
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        result: {
          ok: false,
          error: {
            message: "Tenant consent is disabled",
            code: "mcp_tenant_disabled",
            status: 403,
            requestId: "req-denied",
            params: { action: "runs.start" },
          },
        },
      },
    });
  });

  it("distinguishes an upstream stable-contract violation", () => {
    const result = toolErrorResult(
      new JanuslyProtocolError("Janusly API returned an invalid v1 success envelope"),
    );
    expect(result.structuredContent).toMatchObject({
      result: {
        ok: false,
        error: { code: "janusly_protocol_error" },
      },
    });
  });

  it("workflows.list with no args hits the stable API", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.list", {});
    expect(mock).toHaveBeenCalledWith("/v1/workflows");
  });

  it("workflows.list threads bounded filters and repeatable tags", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.list", {
      limit: 50,
      tag: ["billing", "urgent"],
      folder: "operations",
      q: "refund",
      before: "2026-07-01T00:00:00.000Z|wf-10",
    });
    const path = mock.mock.calls[0][0] as string;
    expect(path).toContain("limit=50");
    expect(path).toContain("tag=billing&tag=urgent");
    expect(path).toContain("folder=operations");
    expect(path).toContain("q=refund");
    expect(path).toContain("before=2026-07-01T00%3A00%3A00.000Z%7Cwf-10");
  });

  it("workflows.list rejects invalid filters instead of silently broadening the query", async () => {
    const { mock } = makeMockCallApi();
    await expect(
      dispatchTool(mock, "workflows.list", { limit: 201 }),
    ).rejects.toThrow(/between 1 and 200/);
    await expect(
      dispatchTool(mock, "workflows.list", { tag: "billing" }),
    ).rejects.toThrow(/array/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.get URL-encodes the workflowId", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.get", { workflowId: "wf with space" });
    expect(mock).toHaveBeenCalledWith("/v1/workflows/latest?workflowId=wf%20with%20space");
  });

  it("workflows.get throws when workflowId is missing", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.get", {})).rejects.toThrow(/workflowId/);
  });

  it("recipes.list and tools.list are no-arg passthroughs", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "recipes.list", {});
    await dispatchTool(mock, "tools.list", {});
    expect(mock).toHaveBeenNthCalledWith(1, "/v1/templates");
    expect(mock).toHaveBeenNthCalledWith(2, "/v1/tools");
  });

  it("exposes memory and recovery evidence through stable read contracts", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "memory.consent_status", {});
    await dispatchTool(mock, "recovery.ledger", {});
    await dispatchTool(mock, "recovery.my_wins", { days: 14 });
    expect(mock).toHaveBeenNthCalledWith(1, "/v1/memory/consent-status");
    expect(mock).toHaveBeenNthCalledWith(2, "/v1/recovery/ledger");
    expect(mock).toHaveBeenNthCalledWith(3, "/v1/recovery/my-wins?days=14");
  });

  it("runs.get builds a URLSearchParams query with eventsLimit + cursor", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.get", {
      runId: "run-42",
      eventsLimit: 50,
      eventsCursor: "2024-01-01T00:00:00.000Z|evt-x",
    });
    const path = mock.mock.calls[0][0];
    expect(path).toMatch(/^\/v1\/run\?/);
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

  it("workflows.save POSTs to the stable save contract when env is on", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const workflow = { dslVersion: "1.0", id: "wf1", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await dispatchTool(mock, "workflows.save", { workflow });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/workflows/save");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(workflow);
  });

  it("workflows.save with dryRun: true routes to stable validation instead of saving", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const workflow = { dslVersion: "1.0", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    const result = await dispatchTool(mock, "workflows.save", { workflow, dryRun: true });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/validate");
    expect(init?.method).toBe("POST");
    // Dispatcher flattens the stable validation result beside the mode marker.
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toEqual({
      result: {
        mode: "dry-run",
        ok: true,
        path: "/v1/validate",
      },
    });
  });

  it("workflows.save rejects a non-boolean dryRun instead of persisting", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const workflow = { dslVersion: "1.0", nodes: [], edges: [] };

    await expect(
      dispatchTool(mock, "workflows.save", { workflow, dryRun: "false" }),
    ).rejects.toThrow(/dryRun.*boolean/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.save with env on still rejects when the workflow body is missing", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.save", {})).rejects.toThrow(/workflow.*object/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.validate POSTs the workflow body to stable validation", async () => {
    const { mock } = makeMockCallApi();
    const workflow = { nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await dispatchTool(mock, "workflows.validate", { workflow });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/validate");
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

  it("returns the API response as both compatible text and structured content", async () => {
    const { mock } = makeMockCallApi();
    const result = await dispatchTool(mock, "workflows.list", {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain('"path"');
    expect(result.structuredContent).toEqual({
      result: { ok: true, path: "/v1/workflows" },
    });
  });

  it("workflows.versions URL-encodes the workflowId", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.versions", { workflowId: "wf with space" });
    expect(mock).toHaveBeenCalledWith("/v1/workflows/versions?workflowId=wf%20with%20space");
  });

  it("workflows.versions throws when workflowId is missing", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.versions", {})).rejects.toThrow(/workflowId/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.health URL-encodes the workflowId", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.health", { workflowId: "wf-1" });
    expect(mock).toHaveBeenCalledWith("/v1/workflows/health?workflowId=wf-1");
  });

  it("workflows.health throws when workflowId is missing", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.health", {})).rejects.toThrow(/workflowId/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.readiness POSTs the workflow body to stable readiness", async () => {
    const { mock } = makeMockCallApi();
    const workflow = { dslVersion: "1.0", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await dispatchTool(mock, "workflows.readiness", { workflow });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/workflows/readiness");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(workflow);
  });

  it("workflows.readiness throws when workflow is missing or not a plain object", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "workflows.readiness", {})).rejects.toThrow(/workflow.*object/);
    await expect(dispatchTool(mock, "workflows.readiness", { workflow: 42 })).rejects.toThrow(/workflow.*object/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("workflows.schedule_preview URL-encodes the cron expression", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.schedule_preview", { cron: "0 9 * * 1-5" });
    expect(mock).toHaveBeenCalledWith(
      "/v1/workflows/schedule-preview?cron=0+9+*+*+1-5",
    );
  });

  it("runs.list with no args hits /runs without query params", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.list", {});
    expect(mock).toHaveBeenCalledWith("/v1/runs");
  });

  it("runs.list threads every stable filter when provided", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.list", {
      workflowId: "wf-1",
      limit: 50,
      status: "failed",
      runKind: "production",
      before: "2026-07-01T00:00:00.000Z|run-10",
    });
    const path = mock.mock.calls[0][0] as string;
    expect(path).toMatch(/^\/v1\/runs\?/);
    expect(path).toContain("workflowId=wf-1");
    expect(path).toContain("limit=50");
    expect(path).toContain("status=failed");
    expect(path).toContain("runKind=production");
    expect(path).toContain("before=2026-07-01T00%3A00%3A00.000Z%7Crun-10");
  });

  it("runs.list rejects invalid filters instead of silently broadening the query", async () => {
    const { mock } = makeMockCallApi();
    await expect(
      dispatchTool(mock, "runs.list", { limit: "not-a-number" as unknown as number }),
    ).rejects.toThrow(/integer/);
    await expect(
      dispatchTool(mock, "runs.list", { status: "unknown" }),
    ).rejects.toThrow(/status/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("runs.status and runs.usage expose polling and attribution contracts", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.status", { runId: "run 42", eventsLimit: 25 });
    await dispatchTool(mock, "runs.usage", { runId: "run 42" });
    expect(mock.mock.calls[0][0]).toContain("/v1/status?");
    expect(mock.mock.calls[0][0]).toContain("runId=run+42");
    expect(mock.mock.calls[0][0]).toContain("eventsLimit=25");
    expect(mock).toHaveBeenNthCalledWith(2, "/v1/run/usage?runId=run%2042");
  });

  it("dlq.list with no args hits the stable endpoint without query params", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.list", {});
    expect(mock).toHaveBeenCalledWith("/v1/dlq");
  });

  it("dlq.list threads all stable filters when provided", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.list", {
      status: "open",
      severity: "p1",
      sort: "sla",
      owner: "on-call",
      search: "timeout",
      limit: 25,
    });
    const path = mock.mock.calls[0][0] as string;
    expect(path).toMatch(/^\/v1\/dlq\?/);
    expect(path).toContain("status=open");
    expect(path).toContain("severity=p1");
    expect(path).toContain("sort=sla");
    expect(path).toContain("owner=on-call");
    expect(path).toContain("search=timeout");
    expect(path).toContain("limit=25");
  });

  it("dlq.list rejects invalid status before broadening to the full DLQ list", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "dlq.list", { status: "pending" })).rejects.toThrow(/status/);
    expect(mock).not.toHaveBeenCalled();
  });

  // -------- dlq.clusters --------

  it("dlq.clusters with no args hits the stable endpoint without query params", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.clusters", {});
    expect(mock).toHaveBeenCalledWith("/v1/dlq/clusters");
  });

  it("dlq.clusters threads windowDays when provided", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.clusters", { windowDays: 14 });
    expect(mock).toHaveBeenCalledWith("/v1/dlq/clusters?windowDays=14");
  });

  it("dlq.clusters rejects out-of-shape windowDays values", async () => {
    const { mock } = makeMockCallApi();
    await expect(
      dispatchTool(mock, "dlq.clusters", {
        windowDays: "not-a-number" as unknown as number,
      }),
    ).rejects.toThrow(/integer/);
    expect(mock).not.toHaveBeenCalled();
  });

  // -------- recovery.metrics --------

  it("recovery.metrics with no args hits /recovery/metrics without query params", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "recovery.metrics", {});
    expect(mock).toHaveBeenCalledWith("/v1/recovery/metrics");
  });

  it("recovery.metrics threads windowDays when provided", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "recovery.metrics", { windowDays: 7 });
    expect(mock).toHaveBeenCalledWith("/v1/recovery/metrics?windowDays=7");
  });

  it("recovery.metrics rejects zero/negative windowDays", async () => {
    const { mock } = makeMockCallApi();
    await expect(
      dispatchTool(mock, "recovery.metrics", { windowDays: 0 }),
    ).rejects.toThrow(/between 1 and 90/);
    expect(mock).not.toHaveBeenCalled();
  });

  // -------- reports.run_explain --------

  it("reports.run_explain forces format=json so the client gets a structured envelope", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "reports.run_explain", { runId: "run-77" });
    const path = mock.mock.calls[0][0] as string;
    expect(path).toMatch(/^\/v1\/reports\/run-explain\?/);
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

  it("ai.patch_workflow POSTs the deadLetterId to the stable patch contract", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "ai.patch_workflow", { deadLetterId: "dlq-99" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/ai/patch-workflow");
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

  // -------- ai.generate_workflow (always visible, operational side effects) --------

  it("ai.generate_workflow POSTs the prompt to the stable generation contract (no write flag needed)", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "ai.generate_workflow", { prompt: "email a receipt when a payment lands" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/ai/generate-workflow");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ prompt: "email a receipt when a payment lands" });
  });

  it("ai.generate_workflow throws on an empty prompt", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "ai.generate_workflow", { prompt: "  " })).rejects.toThrow(/prompt/);
    expect(mock).not.toHaveBeenCalled();
  });

  // -------- read-only MCP connection surface --------

  it("mcp.connections.list is a no-arg passthrough to the stable API", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.list", {});
    expect(mock).toHaveBeenCalledWith("/v1/mcp/connections");
  });

  it("mcp.connections.tools uses a contract-valid alias", async () => {
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.tools", { alias: "note-book" });
    expect(mock).toHaveBeenCalledWith("/v1/mcp/connections/note-book/tools");
  });

  it("mcp.connections.tools rejects aliases outside the stable path contract", async () => {
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "mcp.connections.tools", { alias: "note book" }))
      .rejects.toThrow(/matching/);
    expect(mock).not.toHaveBeenCalled();
  });

  // -------- gated write surface: env-off rejection --------

  it("every write tool is rejected with a clear error when the env flag is off", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    const { mock } = makeMockCallApi();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["runs.start", { workflow: { dslVersion: "1.0", nodes: [], edges: [] } }],
      ["runs.resume", { runId: "r1", nodeId: "n1" }],
      ["runs.redrive", { runId: "r1" }],
      ["runs.cancel", { runId: "r1" }],
      ["dlq.replay", { deadLetterId: "dlq-1" }],
      ["workflows.rollback", { workflowId: "wf1", sourceVersionId: "v1" }],
      ["workflows.resume", { workflowId: "wf1" }],
      ["mcp.connections.create", { alias: "notion", transport: "http" }],
      ["mcp.connections.update", { alias: "notion", enabled: false }],
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

  it("runs.start POSTs { workflow, input } to the stable API", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const workflow = { dslVersion: "1.0", id: "wf1", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };
    await dispatchTool(mock, "runs.start", { workflow, input: { amount: 42 } });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/start");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ workflow, input: { amount: 42 } });
  });

  it("runs.start preserves primitive root input supported by the workflow contract", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const workflow = {
      dslVersion: "1.0",
      id: "wf1",
      nodes: [{ id: "n1", type: "noop", config: {} }],
      edges: [],
    };
    await dispatchTool(mock, "runs.start", { workflow, input: false });
    expect(JSON.parse(mock.mock.calls[0][1]?.body as string)).toEqual({
      workflow,
      input: false,
    });
  });

  it("runs.resume threads runId/nodeId/input/resumeToken to /resume", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.resume", { runId: "r1", nodeId: "n1", input: { ok: true }, resumeToken: "tok" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/resume");
    expect(JSON.parse(init?.body as string)).toEqual({ runId: "r1", nodeId: "n1", input: { ok: true }, resumeToken: "tok" });
  });

  it("runs.redrive POSTs the failed run and optional target selectors", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.redrive", {
      runId: " run-1 ",
      nodeId: " failed-node ",
      workflowVersionId: " version-2 ",
    });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/runs/redrive");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      runId: "run-1",
      nodeId: "failed-node",
      workflowVersionId: "version-2",
    });
  });

  it("runs.cancel POSTs { runId, reason } to /run/cancel", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "runs.cancel", { runId: "r1", reason: "superseded" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/run/cancel");
    expect(JSON.parse(init?.body as string)).toEqual({ runId: "r1", reason: "superseded" });
  });

  it("dlq.replay requires canonical dead-letter identity on the stable endpoint", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "dlq.replay", { deadLetterId: "  dlq-1  " });
    expect(mock.mock.calls[0][0]).toBe("/v1/dlq/replay");
    expect(JSON.parse(mock.mock.calls[0][1]?.body as string)).toEqual({ deadLetterId: "dlq-1" });
    await expect(
      dispatchTool(mock, "dlq.replay", { runId: "r1", nodeId: "n1" }),
    ).rejects.toThrow(/unknown argument `runId`/);
    await expect(dispatchTool(mock, "dlq.replay", {})).rejects.toThrow(/deadLetterId/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("workflows.rollback POSTs identifiers to the stable rollback contract", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.rollback", { workflowId: "wf1", sourceVersionId: "v2" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/workflows/rollback");
    expect(JSON.parse(init?.body as string)).toEqual({ workflowId: "wf1", sourceVersionId: "v2" });
  });

  it("workflows.resume POSTs to the encoded stable workflow path", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "workflows.resume", { workflowId: " workflow/customer sync " });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/workflows/workflow%2Fcustomer%20sync/resume");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
  });

  it("mcp.connections.create POSTs the full body to the stable API", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    const body = { alias: "notion", transport: "http", url: "https://mcp.example/notion" };
    await dispatchTool(mock, "mcp.connections.create", body);
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/mcp/connections");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(body);
  });

  it("rejects unknown arguments instead of silently dropping them", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "mcp.connections.create", {
        alias: "notion",
        transport: "http",
        url: "https://mcp.example/notion",
        unexpected: "do-not-forward",
      }))
      .rejects.toThrow(/unknown argument `unexpected`/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects unknown nested environment-reference fields", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await expect(dispatchTool(mock, "mcp.connections.create", {
      alias: "notion",
      transport: "http",
      url: "https://mcp.example/notion",
      envRefs: {
        AUTHORIZATION: {
          kind: "env",
          name: "NOTION_TOKEN",
          value: "must-not-be-accepted",
        },
      },
    })).rejects.toThrow(/unknown field `value`/);
    expect(mock).not.toHaveBeenCalled();
  });

  it("mcp.connections.update forwards only contract fields and requires a patch", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.update", {
      alias: "note-book",
      enabled: false,
      exposeToAi: true,
    });
    expect(mock.mock.calls[0][0]).toBe("/v1/mcp/connections/note-book");
    expect(JSON.parse(mock.mock.calls[0][1]?.body as string)).toEqual({
      enabled: false,
      exposeToAi: true,
    });

    await expect(
      dispatchTool(mock, "mcp.connections.update", { alias: "note-book" }),
    ).rejects.toThrow(/at least one field/);
  });

  it("mcp.connections.rediscover POSTs an empty body to the stable alias path", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.rediscover", { alias: "note-book" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/mcp/connections/note-book/rediscover");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("{}");
  });

  it("mcp.connections.set_tool strips alias/toolName from the body and puts them in the path", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.set_tool", { alias: "notion", toolName: "pages.update", enabled: true, writeSide: false });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/mcp/connections/notion/tools/pages.update");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ enabled: true, writeSide: false });
  });

  it("mcp.connections.set_tool supports clearing the rate-limit override and rejects empty patches", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.set_tool", {
      alias: "notion",
      toolName: "pages.update",
      rateLimitPerMin: null,
    });
    expect(JSON.parse(mock.mock.calls[0][1]?.body as string)).toEqual({
      rateLimitPerMin: null,
    });
    await expect(
      dispatchTool(mock, "mcp.connections.set_tool", {
        alias: "notion",
        toolName: "pages.update",
      }),
    ).rejects.toThrow(/at least one field/);
  });

  it("mcp.connections.delete issues a DELETE to the alias path", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    const { mock } = makeMockCallApi();
    await dispatchTool(mock, "mcp.connections.delete", { alias: "notion" });
    const [path, init] = mock.mock.calls[0];
    expect(path).toBe("/v1/mcp/connections/notion");
    expect(init?.method).toBe("DELETE");
  });
});
