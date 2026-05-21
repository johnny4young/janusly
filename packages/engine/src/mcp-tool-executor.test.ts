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
  createHttpMcpClient: vi.fn(),
}));

import {
  getConnectionByAlias,
  getToolDescriptor,
  type McpConnectionRow,
  type McpToolDescriptorRow,
} from "@janusly/data/src/mcpConnectionsRepo";
import { createHttpMcpClient, createSseMcpClient, withMcpClient } from "./mcp-client";
import { executeMcpTool, parseCommandAllowlist, readMcpClientWritesEnabled, resolveMcpClientRateLimitPerMin, resolveStdioSandboxConfig, SANDBOX_ERROR_CODES } from "./mcp-tool-executor";
import { McpSandboxCommandNotAllowedError, McpSandboxLifetimeExceededError, McpSandboxStderrExceededError } from "./mcp-sandbox";
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

/**
 * Sandbox payload used by every existing test that doesn't exercise the
 * sandbox itself. The `executeMcpTool` signature requires `stdioSandbox`;
 * with `withMcpClient` mocked, the sandbox config is structurally
 * present but never reached by the real factory — the mocked client is
 * substituted in directly.
 */
const DEFAULT_SANDBOX = {
  allowedCommands: ["node", "uvx"],
  enforceLinuxUlimit: false,
};

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
    exposeToAi: false,
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
    exposeToAi: false,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
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
      stdioSandbox: DEFAULT_SANDBOX,
      onAudit: ({ ok }) => {
        auditEvents.push({ ok });
      },
    });
    expect(auditEvents).toEqual([{ ok: true }, { ok: false }]);
  });

  it("dispatches to the Streamable HTTP factory when the connection transport is `http`", async () => {
    // The dispatcher inside `buildClientForConnection` selects the
    // factory by `connection.transport`. Wire up `withMcpClient` to
    // actually invoke the factory closure so we can assert which
    // SDK-wrapping factory got called. The same envelope shape comes
    // back regardless of transport — the difference is the wire.
    getConnectionMock.mockResolvedValueOnce(
      activeConnection({
        transport: "http",
        command: null,
        args: null,
        url: "https://hosted-mcp.example.com/",
      }),
    );
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    vi.mocked(createHttpMcpClient).mockResolvedValueOnce({
      listTools: async () => [],
      callTool: async () => ({ output: { text: "ok", isError: false }, latencyMs: 7 }),
      close: async () => {
        // no-op
      },
    });
    withMcpClientMock.mockImplementationOnce(async (factory, fn) => {
      const client = await factory();
      return (fn as (c: unknown) => Promise<unknown>)(client);
    });

    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
      stdioSandbox: DEFAULT_SANDBOX,
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.transport).toBe("http");
    expect(createHttpMcpClient).toHaveBeenCalledWith({
      url: "https://hosted-mcp.example.com/",
      headers: {},
    });
    // Sister factories MUST NOT fire on an http transport — keeps the
    // dispatcher branches mutually exclusive.
    expect(createSseMcpClient).not.toHaveBeenCalled();
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

describe("parseCommandAllowlist", () => {
  it("returns an empty array for empty / nullish input", () => {
    expect(parseCommandAllowlist("")).toEqual([]);
    expect(parseCommandAllowlist(undefined)).toEqual([]);
    expect(parseCommandAllowlist(null)).toEqual([]);
  });
  it("trims + drops empty entries", () => {
    expect(parseCommandAllowlist("node, uvx ,, npx")).toEqual(["node", "uvx", "npx"]);
  });
});

describe("resolveStdioSandboxConfig", () => {
  const baseConfig = {
    clientCommandAllowlist: "",
    stdioMaxLifetimeMs: 600_000,
    stdioMaxStderrBytes: 65_536,
    stdioMaxVmKb: 524_288,
  };

  it("prefers the tenant allowlist when non-empty", () => {
    const sandbox = resolveStdioSandboxConfig(
      { ...baseConfig, clientCommandAllowlist: "node,uvx" },
      { JANUSLY_MCP_ALLOWED_COMMANDS: "curl" },
      "linux",
    );
    expect(sandbox.allowedCommands).toEqual(["node", "uvx"]);
  });

  it("falls back to the env CSV when the tenant list is empty", () => {
    const sandbox = resolveStdioSandboxConfig(
      baseConfig,
      { JANUSLY_MCP_ALLOWED_COMMANDS: "node,npx" },
      "linux",
    );
    expect(sandbox.allowedCommands).toEqual(["node", "npx"]);
  });

  it("defaults enforceLinuxUlimit to true only on Linux production", () => {
    expect(
      resolveStdioSandboxConfig(baseConfig, { NODE_ENV: "production" }, "linux").enforceLinuxUlimit,
    ).toBe(true);
    expect(
      resolveStdioSandboxConfig(baseConfig, { NODE_ENV: "production" }, "darwin").enforceLinuxUlimit,
    ).toBe(false);
    expect(
      resolveStdioSandboxConfig(baseConfig, { NODE_ENV: "development" }, "linux").enforceLinuxUlimit,
    ).toBe(false);
  });

  it("honours the explicit JANUSLY_MCP_SANDBOX_ENFORCE_LINUX override", () => {
    expect(
      resolveStdioSandboxConfig(
        baseConfig,
        { JANUSLY_MCP_SANDBOX_ENFORCE_LINUX: "true", NODE_ENV: "development" },
        "darwin",
      ).enforceLinuxUlimit,
    ).toBe(true);
    expect(
      resolveStdioSandboxConfig(
        baseConfig,
        { JANUSLY_MCP_SANDBOX_ENFORCE_LINUX: "false", NODE_ENV: "production" },
        "linux",
      ).enforceLinuxUlimit,
    ).toBe(false);
  });

  it("forwards the cap values into the StdioSandbox payload", () => {
    const sandbox = resolveStdioSandboxConfig(
      { ...baseConfig, stdioMaxLifetimeMs: 120_000, stdioMaxStderrBytes: 4096, stdioMaxVmKb: 262_144 },
      { JANUSLY_MCP_ALLOWED_COMMANDS: "node" },
      "darwin",
    );
    expect(sandbox.maxLifetimeMs).toBe(120_000);
    expect(sandbox.maxStderrBytes).toBe(4096);
    expect(sandbox.maxVmKb).toBe(262_144);
  });
});

describe("executeMcpTool — sandbox-driven failures", () => {
  it("maps McpSandboxCommandNotAllowedError to the COMMAND_REJECTED envelope code", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    // The factory inside withMcpClient throws (allowlist re-check at
    // spawn time). withMcpClient's mock implementation re-throws factory
    // errors out to the executor's outer catch.
    withMcpClientMock.mockImplementationOnce(async (factory) => {
      await (factory as () => Promise<unknown>)();
      throw new Error("factory should have thrown");
    });
    // Make the factory throw the typed error.
    const { createStdioMcpClient } = await import("./mcp-client");
    vi.mocked(createStdioMcpClient).mockImplementationOnce(() => {
      throw new McpSandboxCommandNotAllowedError("curl", "command_not_in_allowlist");
    });
    const auditEvents: Array<{ ok: boolean; sandboxFailureCode?: string | null }> = [];

    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
      stdioSandbox: { allowedCommands: ["node"], enforceLinuxUlimit: false },
      onAudit: ({ ok, sandboxFailureCode }) => {
        auditEvents.push({ ok, sandboxFailureCode });
      },
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error).toContain(SANDBOX_ERROR_CODES.COMMAND_REJECTED);
    expect(auditEvents).toEqual([
      { ok: false, sandboxFailureCode: SANDBOX_ERROR_CODES.COMMAND_REJECTED },
    ]);
  });

  it("maps McpSandboxLifetimeExceededError to the LIFETIME_EXCEEDED envelope code with redacted stderr tail", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    // The fake client surfaces the typed error from callTool and a
    // captured-stderr snapshot from getSandboxSnapshot. Mirrors the
    // post-lifetime-kill shape the real client returns.
    withMcpClientMock.mockImplementationOnce(async (_factory, fn) => {
      const fakeClient = {
        callTool: async () => {
          throw new McpSandboxLifetimeExceededError(600_000);
        },
        getSandboxSnapshot: () => ({
          capturedStderr: "leaking sk-[redacted] before kill",
          stderrTruncated: false,
          stderrByteCount: 32,
          lifetimeExceeded: true,
          stderrExceeded: false,
          enforced: false,
        }),
      };
      return (fn as (client: unknown) => Promise<unknown>)(fakeClient);
    });
    const auditEvents: Array<{ sandboxFailureCode?: string | null; capturedStderrTail?: string | null }> = [];

    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
      stdioSandbox: DEFAULT_SANDBOX,
      onAudit: ({ sandboxFailureCode, capturedStderrTail }) => {
        auditEvents.push({ sandboxFailureCode, capturedStderrTail });
      },
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe(SANDBOX_ERROR_CODES.LIFETIME_EXCEEDED);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.sandboxFailureCode).toBe(SANDBOX_ERROR_CODES.LIFETIME_EXCEEDED);
    expect(auditEvents[0]?.capturedStderrTail).toContain("[redacted]");
  });

  it("maps McpSandboxStderrExceededError to the STDERR_EXCEEDED envelope code with redacted stderr tail", async () => {
    getConnectionMock.mockResolvedValueOnce(activeConnection());
    getDescriptorMock.mockResolvedValueOnce(descriptor());
    withMcpClientMock.mockImplementationOnce(async (_factory, fn) => {
      const fakeClient = {
        callTool: async () => {
          throw new McpSandboxStderrExceededError(65_536);
        },
        getSandboxSnapshot: () => ({
          capturedStderr: "stderr cap hit after ghp_[redacted]",
          stderrTruncated: true,
          stderrByteCount: 70_000,
          lifetimeExceeded: false,
          stderrExceeded: true,
          enforced: false,
        }),
      };
      return (fn as (client: unknown) => Promise<unknown>)(fakeClient);
    });
    const auditEvents: Array<{ sandboxFailureCode?: string | null; capturedStderrTail?: string | null }> = [];

    const envelope = await executeMcpTool({
      orgId: "org-1",
      connectionAlias: "demo",
      toolName: "do_thing",
      writeConsentProcess: true,
      writeConsentTenant: true,
      rateLimitPerMin: 60,
      stdioSandbox: DEFAULT_SANDBOX,
      onAudit: ({ sandboxFailureCode, capturedStderrTail }) => {
        auditEvents.push({ sandboxFailureCode, capturedStderrTail });
      },
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe(SANDBOX_ERROR_CODES.STDERR_EXCEEDED);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.sandboxFailureCode).toBe(SANDBOX_ERROR_CODES.STDERR_EXCEEDED);
    expect(auditEvents[0]?.capturedStderrTail).toContain("[redacted]");
  });
});
