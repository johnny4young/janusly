/**
 * Tests for `executeMcpTool` — the per-call orchestration that
 * resolves a connection + descriptor, enforces dry-run / write-consent
 * / env-ref / rate-limit gates, invokes the MCP client, and returns
 * the typed envelope. Every error path is asserted to NEVER throw and
 * to fire the usage recorder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data/src/mcpConnectionsRepo", () => ({
  getConnectionByAlias: vi.fn(),
  getToolDescriptor: vi.fn(),
}));

vi.mock("./mcp-client", () => ({
  withMcpClient: vi.fn(),
  createStdioMcpClient: vi.fn(),
  createSseMcpClient: vi.fn(),
}));

import {
  getConnectionByAlias,
  getToolDescriptor,
  type McpConnectionRow,
  type McpToolDescriptorRow,
} from "@janusly/data/src/mcpConnectionsRepo";
import { withMcpClient } from "./mcp-client";
import { executeMcpTool, readMcpClientWritesEnabled, resolveMcpClientRateLimitPerMin } from "./mcp-tool-executor";
import {
  _resetMcpUsageRecorderForTests,
  setMcpUsageRecorder,
  type McpUsageRecord,
} from "./mcp-usage";
import { _resetEngineRateLimiterForTests, setEngineRateLimiter } from "./rate-limit";

const getConnectionMock = vi.mocked(getConnectionByAlias);
const getDescriptorMock = vi.mocked(getToolDescriptor);
const withMcpClientMock = vi.mocked(withMcpClient);

const captured: McpUsageRecord[] = [];

function activeConnection(overrides: Partial<McpConnectionRow> = {}): McpConnectionRow {
  return {
    id: "conn-1",
    orgId: "org-1",
    alias: "demo",
    transport: "stdio",
    command: "node",
    args: ["./srv.js"],
    url: null,
    envRefs: {},
    enabled: true,
    status: "active",
    statusReason: null,
    lastDiscoveryAt: null,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function descriptor(overrides: Partial<McpToolDescriptorRow> = {}): McpToolDescriptorRow {
  return {
    id: "tool-1",
    connectionId: "conn-1",
    name: "do_thing",
    description: null,
    inputSchema: null,
    writeSide: false,
    enabled: true,
    rateLimitPerMin: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  captured.length = 0;
  getConnectionMock.mockReset();
  getDescriptorMock.mockReset();
  withMcpClientMock.mockReset();
  _resetEngineRateLimiterForTests();
  _resetMcpUsageRecorderForTests();
  setMcpUsageRecorder((record) => {
    captured.push(record);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("executeMcpTool", () => {
  it("returns a successful envelope and fires usage on the happy path", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    withMcpClientMock.mockImplementationOnce(async (_factory, fn) =>
      // The executor's inner callback collapses into our return shape; just call it through.
      (fn as (client: unknown) => Promise<unknown>)({
        callTool: async () => ({ output: { text: "ok", isError: false }, latencyMs: 12 }),
      }),
    );

    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.output).toMatchObject({ text: "ok" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ ok: true, connectionAlias: "demo", toolName: "do_thing", writeSide: false });
  });

  it("rejects when the org is missing", async () => {
    const envelope = await executeMcpTool({
      orgId: "",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/multi-tenant/);
  });

  it("rejects when the connection is not found", async () => {
    getConnectionMock.mockResolvedValueOnce(null);
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/not found/);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.ok).toBe(false);
  });

  it("rejects when the connection is disabled", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection({ enabled: false, status: "disabled" }));
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/disabled/);
  });

  it("rejects when the connection status is not active", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection({ status: "failed" }));
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/not active/);
  });

  it("rejects when the tool descriptor is not enabled", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor({ enabled: false }));
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/not enabled/);
  });

  it("rejects inputs that do not match the cached descriptor schema before invoking the client", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor({
      inputSchema: {
        type: "object",
        required: ["ticketId"],
        properties: {
          ticketId: { type: "string" },
          priority: { type: "integer" },
        },
        additionalProperties: false,
      },
    }));
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      input: { priority: 2 },
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("mcp tool input missing required field: ticketId");
    expect(withMcpClientMock).not.toHaveBeenCalled();
  });

  it("rejects writes when the process flag is off", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor({ writeSide: true }));
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: false,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/process/);
    expect(envelope.writeSide).toBe(true);
  });

  it("rejects writes when the tenant flag is off", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor({ writeSide: true }));
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: false,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/tenant/);
  });

  it("skips write-side tools in dry-run mode without invoking the client", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor({ writeSide: true }));
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      dryRun: true,
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.output).toMatchObject({ dryRun: true, skipped: true });
    expect(withMcpClientMock).not.toHaveBeenCalled();
  });

  it("returns a generic credential message when an env-ref is missing", async () => {
    vi.stubEnv("MISSING_KEY", "");
    getConnectionMock.mockResolvedValueOnce(activeConnection({ envRefs: { TOKEN: { kind: "env", name: "MISSING_KEY" } } }));
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("credential secret missing for TOKEN");
    // The env-var name (`MISSING_KEY`) MUST NOT appear in the error message.
    expect(envelope.error).not.toMatch(/MISSING_KEY/);
  });

  it("surfaces rate-limit rejections as a non-ok envelope", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    setEngineRateLimiter(async () => {
      throw new Error("Rate limit exceeded");
    });
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("Rate limit exceeded");
  });

  it("uses the descriptor's rateLimitPerMin override instead of the caller's org default", async () => {
    // Admin set a lower per-tool budget (e.g. notion.pages.create
    // costs more than the rest of the connection). The executor MUST
    // pass the descriptor value to the limiter — passing the caller's
    // org default would defeat the override.
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor({ rateLimitPerMin: 10 }));
    const limiterCalls: Array<{ name: string; orgId: string; max: number }> = [];
    setEngineRateLimiter(async (name, orgId, opts) => {
      limiterCalls.push({ name, orgId, max: opts.max });
    });
    withMcpClientMock.mockImplementationOnce(async (_factory, fn) =>
      (fn as (client: unknown) => Promise<unknown>)({
        callTool: async () => ({ output: { ok: true }, latencyMs: 1 }),
      }),
    );

    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      // Caller passes the org default (60) — the override (10) should win.
      rateLimitPerMin: 60,
    });

    expect(envelope.ok).toBe(true);
    expect(limiterCalls).toHaveLength(1);
    expect(limiterCalls[0]?.name).toBe("mcp_client.demo.do_thing");
    expect(limiterCalls[0]?.max).toBe(10);
  });

  it("falls back to the caller's rateLimitPerMin when the descriptor override is null", async () => {
    // The common case: no per-tool override → caller's org default wins.
    // Pins the back-compat default behaviour so future regressions are caught.
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor({ rateLimitPerMin: null }));
    const limiterCalls: Array<{ max: number }> = [];
    setEngineRateLimiter(async (_name, _orgId, opts) => {
      limiterCalls.push({ max: opts.max });
    });
    withMcpClientMock.mockImplementationOnce(async (_factory, fn) =>
      (fn as (client: unknown) => Promise<unknown>)({
        callTool: async () => ({ output: { ok: true }, latencyMs: 1 }),
      }),
    );

    await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });

    expect(limiterCalls).toHaveLength(1);
    expect(limiterCalls[0]?.max).toBe(60);
  });

  it("surfaces an MCP isError result as an error envelope", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    withMcpClientMock.mockImplementationOnce(async (_factory, fn) =>
      (fn as (client: unknown) => Promise<unknown>)({
        callTool: async () => ({ output: { isError: true, text: "upstream said nope" }, latencyMs: 5 }),
      }),
    );
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatch(/nope/);
  });

  it("scrubs secret-shaped values returned by MCP isError responses", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    withMcpClientMock.mockImplementationOnce(async (_factory, fn) =>
      (fn as (client: unknown) => Promise<unknown>)({
        callTool: async () => ({ output: { isError: true, text: "upstream echoed Bearer sk-12345678901234567890" }, latencyMs: 5 }),
      }),
    );
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("[redacted]");
    expect(envelope.error).not.toContain("sk-12345678901234567890");
    expect(captured[0]?.error).not.toContain("sk-12345678901234567890");
  });

  it("surfaces a timeout thrown by the SDK as a non-ok envelope", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    withMcpClientMock.mockRejectedValueOnce(new Error("timeout"));
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("timeout");
  });

  it("scrubs secret-shaped values from thrown SDK errors before telemetry", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    withMcpClientMock.mockRejectedValueOnce(new Error("request failed with Bearer sk-12345678901234567890"));
    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain("[redacted]");
    expect(envelope.error).not.toContain("sk-12345678901234567890");
    expect(captured[0]?.error).not.toContain("sk-12345678901234567890");
  });

  it("fires the audit callback on both success and failure", async () => {
    const auditEvents: Array<{ ok: boolean }> = [];
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    withMcpClientMock.mockImplementationOnce(async (_factory, fn) =>
      (fn as (client: unknown) => Promise<unknown>)({
        callTool: async () => ({ output: { text: "ok", isError: false }, latencyMs: 1 }),
      }),
    );
    await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
      onAudit: ({ ok }) => {
        auditEvents.push({ ok });
      },
    });
    getConnectionMock.mockResolvedValueOnce(null);
    await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
      onAudit: ({ ok }) => {
        auditEvents.push({ ok });
      },
    });
    expect(auditEvents).toEqual([{ ok: true }, { ok: false }]);
  });
});

describe("readMcpClientWritesEnabled", () => {
  it("returns false when the env var is unset", () => {
    expect(readMcpClientWritesEnabled({})).toBe(false);
  });
  it("returns true only when set to the literal 'true'", () => {
    expect(readMcpClientWritesEnabled({ JANUSLY_MCP_CLIENT_WRITES_ENABLED: "true" })).toBe(true);
    expect(readMcpClientWritesEnabled({ JANUSLY_MCP_CLIENT_WRITES_ENABLED: "TRUE" })).toBe(false);
    expect(readMcpClientWritesEnabled({ JANUSLY_MCP_CLIENT_WRITES_ENABLED: "1" })).toBe(false);
  });
});

describe("resolveMcpClientRateLimitPerMin", () => {
  it("prefers the tenant override when positive", () => {
    expect(resolveMcpClientRateLimitPerMin(120, {})).toBe(120);
  });
  it("falls back to the env var", () => {
    expect(resolveMcpClientRateLimitPerMin(null, { JANUSLY_MCP_CLIENT_RATE_LIMIT_PER_MIN: "30" })).toBe(30);
  });
  it("falls back to the default 60", () => {
    expect(resolveMcpClientRateLimitPerMin(null, {})).toBe(60);
  });
});
