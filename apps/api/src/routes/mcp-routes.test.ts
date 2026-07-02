/**
 * Tests for the MCP client admin routes. Mocks the repo + the
 * transport-agnostic MCP client so the route handlers can be
 * exercised without spawning a real process / opening a real socket.
 *
 * The dispatcher / auth gate is NOT exercised — these tests call the
 * handler functions directly with a synthetic `AuthContext`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../audit", () => ({
  audit: vi.fn(),
}));

vi.mock("@janusly/data/src/mcpConnectionsRepo", () => ({
  createConnection: vi.fn(),
  deleteConnection: vi.fn(),
  getConnectionByAlias: vi.fn(),
  getToolDescriptor: vi.fn(),
  listConnections: vi.fn(),
  listToolDescriptors: vi.fn(),
  setConnectionStatus: vi.fn(),
  setToolFlags: vi.fn(),
  updateConnection: vi.fn(),
  upsertToolDescriptor: vi.fn(),
}));

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: vi.fn(async () => ({
    ai: {} as never,
    http: {} as never,
    email: {} as never,
    runs: {} as never,
    mcp: {
      writeConsent: false,
      clientWriteConsent: false,
      clientRateLimitPerMin: 60,
      clientCommandAllowlist: "node,uvx",
      stdioMaxLifetimeMs: 600_000,
      stdioMaxStderrBytes: 65_536,
      stdioMaxVmKb: 524_288,
    },
    integrations: {} as never,
    objectstore: {} as never,
    memory: {} as never,
    autoHealing: {} as never,
    recovery: {} as never,
    value: {} as never,
    onboarding: {} as never,
  })),
}));

vi.mock("@janusly/engine/src/mcp-client", () => ({
  createStdioMcpClient: vi.fn(),
  createSseMcpClient: vi.fn(),
  withMcpClient: vi.fn(async (factory: () => unknown, fn: (client: unknown) => Promise<unknown>) => {
    return fn(typeof factory === "function" ? factory() : factory);
  }),
}));

import {
  createConnection,
  deleteConnection,
  getConnectionByAlias,
  getToolDescriptor,
  listConnections,
  listToolDescriptors,
  setConnectionStatus,
  setToolFlags,
  updateConnection,
  upsertToolDescriptor,
} from "@janusly/data/src/mcpConnectionsRepo";
import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";
import { withMcpClient } from "@janusly/engine/src/mcp-client";
import { audit } from "../audit";
import { mcpRoutes } from "./mcp-routes";
import type { Route, RouteContext } from "../routes";
import type { AuthContext } from "../auth";
import http from "http";

const auth: AuthContext = {
  orgId: "org-1",
  userId: "user-1",
  source: "service",
  mode: "service-token",
} as AuthContext;

function mockReq(method: string, url: string, body?: unknown): http.IncomingMessage {
  const serialised = body !== undefined ? JSON.stringify(body) : "";
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  const req = {
    method,
    url,
    headers: {},
    on(event: string, fn: (arg: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(fn);
      if (event === "end") {
        // Fire data + end synchronously on the next microtask so readJson's
        // promise resolves before the handler is awaited.
        Promise.resolve().then(() => {
          if (serialised) {
            for (const data of listeners.data ?? []) data(serialised);
          }
          for (const end of listeners.end ?? []) end(undefined);
        });
      }
      return req;
    },
    destroy: vi.fn(),
  } as unknown as http.IncomingMessage;
  return req;
}

function mockRes() {
  const captured: { status: number; payload: unknown } = { status: 0, payload: null };
  const res = {
    writeHead: vi.fn((status: number) => {
      captured.status = status;
      return res;
    }),
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      if (typeof body === "string") {
        try {
          captured.payload = JSON.parse(body);
        } catch {
          captured.payload = body;
        }
      }
      return res;
    }),
    writableEnded: false,
    statusCode: 200,
  } as unknown as RouteContext["res"];
  return { res, captured };
}

function findRoute(method: string, urlSample: string): Route | null {
  for (const route of mcpRoutes) {
    if (route.method !== method) continue;
    if (typeof route.match === "string") {
      if (route.match === urlSample) return route;
    } else if (route.match(urlSample)) {
      return route;
    }
  }
  return null;
}

const connectionRow = {
  id: "conn-1",
  orgId: "org-1",
  alias: "demo",
  transport: "stdio" as const,
  command: "node",
  args: ["./srv.js"],
  url: null,
  envRefs: {},
  enabled: true,
  status: "pending" as const,
  statusReason: null,
  exposeToAi: false,
  lastDiscoveryAt: null,
  createdBy: "user-1",
  createdAt: null,
  updatedAt: null,
};

beforeEach(() => {
  vi.mocked(createConnection).mockReset();
  vi.mocked(deleteConnection).mockReset();
  vi.mocked(getConnectionByAlias).mockReset();
  vi.mocked(getToolDescriptor).mockReset();
  vi.mocked(listConnections).mockReset();
  vi.mocked(listToolDescriptors).mockReset();
  vi.mocked(setConnectionStatus).mockReset();
  vi.mocked(setToolFlags).mockReset();
  vi.mocked(updateConnection).mockReset();
  vi.mocked(upsertToolDescriptor).mockReset();
  vi.mocked(audit).mockReset();
  vi.mocked(getOrgConfigSnapshot).mockReset();
  vi.mocked(getOrgConfigSnapshot).mockResolvedValue({
    ai: {} as never,
    http: {} as never,
    email: {} as never,
    runs: {} as never,
    mcp: {
      writeConsent: false,
      clientWriteConsent: false,
      clientRateLimitPerMin: 60,
      clientCommandAllowlist: "node,uvx",
      stdioMaxLifetimeMs: 600_000,
      stdioMaxStderrBytes: 65_536,
      stdioMaxVmKb: 524_288,
    },
    integrations: {} as never,
    objectstore: {} as never,
    memory: {} as never,
    autoHealing: {} as never,
    recovery: {} as never,
    value: {} as never,
    onboarding: {} as never,
  });
  vi.mocked(withMcpClient).mockReset();
  vi.mocked(withMcpClient).mockImplementation(async (factory, fn) => {
    return (fn as (c: unknown) => Promise<unknown>)({});
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /mcp/connections", () => {
  it("rejects an alias that does not match the regex", async () => {
    const route = findRoute("POST", "/mcp/connections")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections", { alias: "Bad Alias!", transport: "stdio", command: "node" }), res, auth });
    expect(captured.status).toBe(400);
    expect((captured.payload as { error?: string }).error).toMatch(/alias/);
  });

  it("rejects an unknown transport", async () => {
    const route = findRoute("POST", "/mcp/connections")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections", { alias: "demo", transport: "websocket" }), res, auth });
    expect(captured.status).toBe(400);
    expect((captured.payload as { error?: string }).error).toMatch(/transport/);
  });

  it("rejects a stdio command not in the allowlist", async () => {
    const route = findRoute("POST", "/mcp/connections")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections", { alias: "demo", transport: "stdio", command: "/bin/sh" }), res, auth });
    expect(captured.status).toBe(400);
    expect((captured.payload as { code?: string }).code).toBe("mcp_command_not_allowed");
  });

  it("rejects a duplicate alias with 409", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    const route = findRoute("POST", "/mcp/connections")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections", { alias: "demo", transport: "stdio", command: "node" }), res, auth });
    expect(captured.status).toBe(409);
  });

  it("creates a stdio connection and runs discovery (happy path)", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...connectionRow, status: "active" });
    vi.mocked(createConnection).mockResolvedValueOnce(connectionRow);
    vi.mocked(withMcpClient).mockImplementationOnce(async () => [
      { name: "do_thing", description: "demo", inputSchema: { type: "object" } },
    ]);
    vi.mocked(upsertToolDescriptor).mockResolvedValue({
      id: "tool-1",
      connectionId: "conn-1",
      name: "do_thing",
      description: "demo",
      inputSchema: { type: "object" },
      writeSide: true,
      enabled: false,
      rateLimitPerMin: null,
      exposeToAi: false,
      createdAt: null,
      updatedAt: null,
    });
    vi.mocked(listToolDescriptors).mockResolvedValue([]);
    const route = findRoute("POST", "/mcp/connections")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections", { alias: "demo", transport: "stdio", command: "node" }), res, auth });
    expect(captured.status).toBe(200);
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", alias: "demo" }));
    expect(setConnectionStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("falls back to the process stdio allowlist when the tenant allowlist is empty", async () => {
    vi.stubEnv("JANUSLY_MCP_ALLOWED_COMMANDS", "node");
    vi.mocked(getOrgConfigSnapshot).mockResolvedValueOnce({
      ai: {} as never,
      http: {} as never,
      email: {} as never,
      runs: {} as never,
      mcp: {
        writeConsent: false,
        clientWriteConsent: false,
        clientRateLimitPerMin: 60,
        clientCommandAllowlist: "",
        stdioMaxLifetimeMs: 600_000,
        stdioMaxStderrBytes: 65_536,
        stdioMaxVmKb: 524_288,
      },
      integrations: {} as never,
      objectstore: {} as never,
      memory: {} as never,
      autoHealing: {} as never,
      recovery: {} as never,
      value: {} as never,
      onboarding: {} as never,
    });
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...connectionRow, status: "active" });
    vi.mocked(createConnection).mockResolvedValueOnce(connectionRow);
    vi.mocked(withMcpClient).mockImplementationOnce(async () => []);
    vi.mocked(listToolDescriptors).mockResolvedValue([]);
    const route = findRoute("POST", "/mcp/connections")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections", { alias: "demo", transport: "stdio", command: "node" }), res, auth });
    expect(captured.status).toBe(200);
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ command: "node" }));
  });

  it("flips the connection to status=failed when discovery throws", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...connectionRow, status: "failed" });
    vi.mocked(createConnection).mockResolvedValueOnce(connectionRow);
    vi.mocked(withMcpClient).mockImplementationOnce(async () => {
      throw new Error("could not spawn");
    });
    vi.mocked(listToolDescriptors).mockResolvedValue([]);
    const route = findRoute("POST", "/mcp/connections")!;
    const { res, captured: _captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections", { alias: "demo", transport: "stdio", command: "node" }), res, auth });
    expect(setConnectionStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("creates an http (Streamable HTTP) connection with a url and runs discovery", async () => {
    // Modern hosted MCP servers (Cloudflare Workers, Anthropic native
    // endpoints) ship Streamable HTTP only — confirming the route
    // accepts `transport: "http"` with `url` is the unblocker for that
    // population of operators. The route shape mirrors sse: no
    // command, no args, just a URL endpoint + optional envRefs.
    const httpRow = {
      ...connectionRow,
      transport: "http" as const,
      command: null,
      args: null,
      url: "https://hosted-mcp.example.com/",
    };
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...httpRow, status: "active" });
    vi.mocked(createConnection).mockResolvedValueOnce(httpRow);
    vi.mocked(withMcpClient).mockImplementationOnce(async () => []);
    vi.mocked(listToolDescriptors).mockResolvedValue([]);
    const route = findRoute("POST", "/mcp/connections")!;
    const { res, captured } = mockRes();
    await route.handler({
      req: mockReq("POST", "/mcp/connections", {
        alias: "hosted",
        transport: "http",
        url: "https://hosted-mcp.example.com/",
      }),
      res,
      auth,
    });
    expect(captured.status).toBe(200);
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "hosted", transport: "http", url: "https://hosted-mcp.example.com/" }),
    );
    expect(setConnectionStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });

  it("rejects an http transport with an empty url", async () => {
    // Symmetric to the existing sse-empty-url check — http requires
    // a URL. The error message names the transport so the operator
    // knows which field to fill.
    const route = findRoute("POST", "/mcp/connections")!;
    const { res, captured } = mockRes();
    await route.handler({
      req: mockReq("POST", "/mcp/connections", { alias: "demo", transport: "http", url: "   " }),
      res,
      auth,
    });
    expect(captured.status).toBe(400);
    expect((captured.payload as { error?: string }).error).toMatch(/http.*url/);
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("updates the url on an existing http connection", async () => {
    // Once an http connection exists, the admin can repoint it at a
    // new endpoint (server migrated, alias re-purposed) via the
    // POST /:alias update route — same code path sse already uses.
    const httpRow = {
      ...connectionRow,
      transport: "http" as const,
      command: null,
      args: null,
      url: "https://old.example.com/",
    };
    vi.mocked(getConnectionByAlias)
      .mockResolvedValueOnce(httpRow)
      .mockResolvedValueOnce({ ...httpRow, url: "https://new.example.com/" });
    vi.mocked(updateConnection).mockResolvedValueOnce({
      before: { enabled: true, exposeToAi: false },
      after: { ...httpRow, url: "https://new.example.com/" },
    });
    const route = findRoute("POST", "/mcp/connections/demo")!;
    const { res } = mockRes();
    await route.handler({
      req: mockReq("POST", "/mcp/connections/demo", { url: "https://new.example.com/" }),
      res,
      auth,
    });
    expect(updateConnection).toHaveBeenCalledWith(expect.objectContaining({ url: "https://new.example.com/" }));
  });
});

describe("POST /mcp/connections/:alias", () => {
  it("rejects an empty SSE URL update", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce({
      ...connectionRow,
      transport: "sse",
      command: null,
      args: null,
      url: "https://mcp.example.com/sse",
    });
    const route = findRoute("POST", "/mcp/connections/demo")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections/demo", { url: "   " }), res, auth });
    expect(captured.status).toBe(400);
    expect(updateConnection).not.toHaveBeenCalled();
  });

  it("persists exposeToAi: true AND emits a mcp.connection.expose_to_ai_set audit row when the flag flips false → true", async () => {
    // First lookup (existence check) sees the prior row with exposeToAi: false.
    // Second lookup (post-update fresh) returns the updated row.
    vi.mocked(getConnectionByAlias)
      .mockResolvedValueOnce(connectionRow) // existence check at route entry
      .mockResolvedValueOnce({ ...connectionRow, exposeToAi: true }); // fresh after update
    vi.mocked(updateConnection).mockResolvedValueOnce({
      before: { enabled: true, exposeToAi: false },
      after: { ...connectionRow, exposeToAi: true },
    });
    const route = findRoute("POST", "/mcp/connections/demo")!;
    const { res } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections/demo", { exposeToAi: true }), res, auth });

    expect(updateConnection).toHaveBeenCalledWith(expect.objectContaining({ exposeToAi: true }));
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "mcp.connection.expose_to_ai_set",
      "mcp_connection",
      "conn-1",
      expect.objectContaining({ alias: "demo", before: false, after: true }),
    );
  });

  it("audits the reverse flip true → false with before/after", async () => {
    const exposedRow = { ...connectionRow, exposeToAi: true };
    vi.mocked(getConnectionByAlias)
      .mockResolvedValueOnce(exposedRow)
      .mockResolvedValueOnce({ ...exposedRow, exposeToAi: false });
    vi.mocked(updateConnection).mockResolvedValueOnce({
      before: { enabled: true, exposeToAi: true },
      after: { ...exposedRow, exposeToAi: false },
    });
    const route = findRoute("POST", "/mcp/connections/demo")!;
    const { res } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections/demo", { exposeToAi: false }), res, auth });

    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "mcp.connection.expose_to_ai_set",
      "mcp_connection",
      "conn-1",
      expect.objectContaining({ before: true, after: false }),
    );
  });

  it("does NOT emit the expose_to_ai_set audit row when the field is omitted from the body", async () => {
    vi.mocked(getConnectionByAlias)
      .mockResolvedValueOnce(connectionRow)
      .mockResolvedValueOnce({ ...connectionRow, enabled: false });
    vi.mocked(updateConnection).mockResolvedValueOnce({
      before: { enabled: true, exposeToAi: false },
      after: { ...connectionRow, enabled: false },
    });
    const route = findRoute("POST", "/mcp/connections/demo")!;
    const { res } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections/demo", { enabled: false }), res, auth });

    // The generic `mcp.connection.updated` row fires for the enabled flip
    // but the expose_to_ai_set row must NOT, because the field wasn't in
    // the body.
    const auditActions = vi.mocked(audit).mock.calls.map((call) => call[2]);
    expect(auditActions).toContain("mcp.connection.updated");
    expect(auditActions).not.toContain("mcp.connection.expose_to_ai_set");
  });
});

describe("DELETE /mcp/connections/:alias", () => {
  it("404s when the alias does not exist", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(null);
    const route = findRoute("DELETE", "/mcp/connections/missing")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("DELETE", "/mcp/connections/missing"), res, auth });
    expect(captured.status).toBe(404);
  });

  it("deletes and audits when the alias exists", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    const route = findRoute("DELETE", "/mcp/connections/demo")!;
    const { res } = mockRes();
    await route.handler({ req: mockReq("DELETE", "/mcp/connections/demo"), res, auth });
    expect(deleteConnection).toHaveBeenCalledWith({ orgId: "org-1", alias: "demo" });
  });
});

describe("POST /mcp/connections/:alias/tools/:toolName", () => {
  it("flips the enabled flag and emits an audit row", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    vi.mocked(getToolDescriptor).mockResolvedValueOnce({
      id: "tool-1",
      connectionId: "conn-1",
      name: "do_thing",
      description: null,
      inputSchema: null,
      writeSide: false,
      enabled: false,
      rateLimitPerMin: null,
      exposeToAi: false,
      createdAt: null,
      updatedAt: null,
    });
    vi.mocked(setToolFlags).mockResolvedValueOnce({
      before: { enabled: false, writeSide: false, rateLimitPerMin: null, exposeToAi: false },
      after: {
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
      },
    });
    const route = findRoute("POST", "/mcp/connections/demo/tools/do_thing")!;
    const { res } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections/demo/tools/do_thing", { enabled: true }), res, auth });
    expect(setToolFlags).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("404s on an unknown tool", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    vi.mocked(getToolDescriptor).mockResolvedValueOnce(null);
    const route = findRoute("POST", "/mcp/connections/demo/tools/ghost")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections/demo/tools/ghost", { enabled: true }), res, auth });
    expect(captured.status).toBe(404);
  });

  it("400s when no fields are present", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    vi.mocked(getToolDescriptor).mockResolvedValueOnce({
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
    });
    const route = findRoute("POST", "/mcp/connections/demo/tools/do_thing")!;
    const { res, captured } = mockRes();
    await route.handler({ req: mockReq("POST", "/mcp/connections/demo/tools/do_thing", {}), res, auth });
    expect(captured.status).toBe(400);
  });

  it("persists a numeric rateLimitPerMin override AND writes a mcp.tool.rate_limit_set audit row", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    vi.mocked(getToolDescriptor).mockResolvedValueOnce({
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
    });
    vi.mocked(setToolFlags).mockResolvedValueOnce({
      before: { enabled: true, writeSide: false, rateLimitPerMin: null, exposeToAi: false },
      after: {
        id: "tool-1",
        connectionId: "conn-1",
        name: "do_thing",
        description: null,
        inputSchema: null,
        writeSide: false,
        enabled: true,
        rateLimitPerMin: 30,
        exposeToAi: false,
        createdAt: null,
        updatedAt: null,
      },
    });
    const route = findRoute("POST", "/mcp/connections/demo/tools/do_thing")!;
    const { res } = mockRes();
    await route.handler({
      req: mockReq("POST", "/mcp/connections/demo/tools/do_thing", { rateLimitPerMin: 30 }),
      res,
      auth,
    });
    expect(setToolFlags).toHaveBeenCalledWith(expect.objectContaining({ rateLimitPerMin: 30 }));
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "mcp.tool.rate_limit_set",
      "mcp_tool",
      "tool-1",
      expect.objectContaining({ alias: "demo", toolName: "do_thing", before: null, after: 30 }),
    );
  });

  it("clears a prior rateLimitPerMin override on explicit null AND audits before/after", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    vi.mocked(getToolDescriptor).mockResolvedValueOnce({
      id: "tool-1",
      connectionId: "conn-1",
      name: "do_thing",
      description: null,
      inputSchema: null,
      writeSide: false,
      enabled: true,
      rateLimitPerMin: 30,
      exposeToAi: false,
      createdAt: null,
      updatedAt: null,
    });
    vi.mocked(setToolFlags).mockResolvedValueOnce({
      before: { enabled: true, writeSide: false, rateLimitPerMin: 30, exposeToAi: false },
      after: {
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
      },
    });
    const route = findRoute("POST", "/mcp/connections/demo/tools/do_thing")!;
    const { res } = mockRes();
    await route.handler({
      req: mockReq("POST", "/mcp/connections/demo/tools/do_thing", { rateLimitPerMin: null }),
      res,
      auth,
    });
    expect(setToolFlags).toHaveBeenCalledWith(expect.objectContaining({ rateLimitPerMin: null }));
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "mcp.tool.rate_limit_set",
      "mcp_tool",
      "tool-1",
      expect.objectContaining({ before: 30, after: null }),
    );
  });

  it("400s when rateLimitPerMin is above the 10_000 sanity ceiling", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    vi.mocked(getToolDescriptor).mockResolvedValueOnce({
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
    });
    const route = findRoute("POST", "/mcp/connections/demo/tools/do_thing")!;
    const { res, captured } = mockRes();
    await route.handler({
      req: mockReq("POST", "/mcp/connections/demo/tools/do_thing", { rateLimitPerMin: 10_001 }),
      res,
      auth,
    });
    expect(captured.status).toBe(400);
    expect(setToolFlags).not.toHaveBeenCalled();
  });

  it("persists exposeToAi: true AND audits mcp.tool.expose_to_ai_set with before/after", async () => {
    // Per-tool opt-in for LLM exposure. The audit row fires only when
    // the value actually flips — mirror of the rate_limit_set pattern.
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    vi.mocked(getToolDescriptor).mockResolvedValueOnce({
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
    });
    vi.mocked(setToolFlags).mockResolvedValueOnce({
      before: { enabled: true, writeSide: false, rateLimitPerMin: null, exposeToAi: false },
      after: {
        id: "tool-1",
        connectionId: "conn-1",
        name: "do_thing",
        description: null,
        inputSchema: null,
        writeSide: false,
        enabled: true,
        rateLimitPerMin: null,
        exposeToAi: true,
        createdAt: null,
        updatedAt: null,
      },
    });
    const route = findRoute("POST", "/mcp/connections/demo/tools/do_thing")!;
    const { res } = mockRes();
    await route.handler({
      req: mockReq("POST", "/mcp/connections/demo/tools/do_thing", { exposeToAi: true }),
      res,
      auth,
    });
    expect(setToolFlags).toHaveBeenCalledWith(expect.objectContaining({ exposeToAi: true }));
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "mcp.tool.expose_to_ai_set",
      "mcp_tool",
      "tool-1",
      expect.objectContaining({ alias: "demo", toolName: "do_thing", before: false, after: true }),
    );
  });

  it("audits the reverse flip exposeToAi true → false with the inverse metadata", async () => {
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    vi.mocked(getToolDescriptor).mockResolvedValueOnce({
      id: "tool-1",
      connectionId: "conn-1",
      name: "do_thing",
      description: null,
      inputSchema: null,
      writeSide: false,
      enabled: true,
      rateLimitPerMin: null,
      exposeToAi: true,
      createdAt: null,
      updatedAt: null,
    });
    vi.mocked(setToolFlags).mockResolvedValueOnce({
      before: { enabled: true, writeSide: false, rateLimitPerMin: null, exposeToAi: true },
      after: {
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
      },
    });
    const route = findRoute("POST", "/mcp/connections/demo/tools/do_thing")!;
    const { res } = mockRes();
    await route.handler({
      req: mockReq("POST", "/mcp/connections/demo/tools/do_thing", { exposeToAi: false }),
      res,
      auth,
    });
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "mcp.tool.expose_to_ai_set",
      "mcp_tool",
      "tool-1",
      expect.objectContaining({ before: true, after: false }),
    );
  });
});

describe("admin gates on every mutating route", () => {
  it("declares admin role + mcp.connections.write on every mutating route", () => {
    for (const route of mcpRoutes) {
      if (route.method === "POST" || route.method === "DELETE") {
        expect(route.role).toBe("admin");
        expect(route.permission).toBe("mcp.connections.write");
      } else {
        expect(route.permission).toBe("mcp.connections.read");
      }
    }
  });
});

// Proves `guardMcpWrite` is WIRED on every connection-write route (not just
// that the helper works — that's `mcp-consent.test.ts`). An MCP-source caller
// with the process flag off must be refused BEFORE any mutation, so a future
// edit that drops the gate line fails here. Tenant isolation itself rides on
// the org-scoped repo calls (`getConnectionByAlias({ orgId: auth.orgId })`)
// exercised throughout the rest of this file.
describe("MCP-source write consent gate", () => {
  const mcpAuth = { ...auth, source: "mcp", serviceTokenSuffix: "abcd" } as AuthContext;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const cases: Array<{ name: string; method: string; url: string; body?: unknown }> = [
    { name: "create", method: "POST", url: "/mcp/connections", body: { alias: "demo", transport: "stdio", command: "node" } },
    { name: "delete", method: "DELETE", url: "/mcp/connections/demo" },
    { name: "rediscover", method: "POST", url: "/mcp/connections/demo/rediscover" },
    { name: "set_tool", method: "POST", url: "/mcp/connections/demo/tools/pages.update", body: { enabled: true } },
  ];

  for (const c of cases) {
    it(`${c.name} refuses MCP-source traffic (403 mcp_process_disabled) with the process flag off, and never mutates`, async () => {
      vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
      const route = findRoute(c.method, c.url);
      expect(route).not.toBeNull();
      const { res, captured } = mockRes();
      await route!.handler({ req: mockReq(c.method, c.url, c.body), res, auth: mcpAuth } as unknown as RouteContext);
      expect(captured.status).toBe(403);
      expect((captured.payload as { code?: string }).code).toBe("mcp_process_disabled");
      // The gate fired before any repo mutation.
      expect(vi.mocked(createConnection)).not.toHaveBeenCalled();
      expect(vi.mocked(deleteConnection)).not.toHaveBeenCalled();
    });
  }

  it("lets a non-MCP admin caller through the gate unchanged (source=service)", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    const route = findRoute("DELETE", "/mcp/connections/demo");
    vi.mocked(getConnectionByAlias).mockResolvedValueOnce(connectionRow);
    vi.mocked(deleteConnection).mockResolvedValueOnce(undefined as never);
    const { res, captured } = mockRes();
    await route!.handler({ req: mockReq("DELETE", "/mcp/connections/demo"), res, auth } as unknown as RouteContext);
    // No 403 from the MCP gate — the service-token path proceeds to the repo.
    expect(captured.status).not.toBe(403);
    expect(vi.mocked(deleteConnection)).toHaveBeenCalled();
  });
});
