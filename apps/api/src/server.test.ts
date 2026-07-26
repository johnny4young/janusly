import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { readJson, sendError, sendJson } from "./http";
import type { ApiRouteContract } from "./api-contract-types";
import type { Route } from "./routes";

vi.mock("./auth", () => ({
  getIdentity: vi.fn(async () => null),
  requireAuth: vi.fn(async () => ({
    orgId: "org-1",
    userId: "user-1",
    mode: "dev-headers",
    source: "dev",
  })),
  requireIdentity: vi.fn(async () => ({
    userId: "identity-1",
    email: "identity@example.com",
    mode: "supabase",
    source: "web",
    orgHint: null,
  })),
}));

vi.mock("./permissions", () => ({
  requirePermission: vi.fn(async () => ({ name: "editor", inheritsFrom: "editor" })),
  requireRole: vi.fn(async () => "editor"),
}));

import { getIdentity, requireAuth, requireIdentity } from "./auth";
import { requirePermission, requireRole } from "./permissions";
import { configureApiServerTimeouts, createApiServer, matchesContractPath } from "./server";

const requireAuthMock = vi.mocked(requireAuth);
const requireIdentityMock = vi.mocked(requireIdentity);
const getIdentityMock = vi.mocked(getIdentity);
const requirePermissionMock = vi.mocked(requirePermission);
const requireRoleMock = vi.mocked(requireRole);

afterEach(() => {
  vi.clearAllMocks();
});

describe("configureApiServerTimeouts", () => {
  it("sets explicit request and socket timeouts", () => {
    const server = http.createServer();

    configureApiServerTimeouts(server, {
      requestTimeoutMs: 1_234,
      keepAliveTimeoutMs: 3_000,
      headersTimeoutMs: 3_001,
    });

    expect(server.requestTimeout).toBe(1_234);
    expect(server.timeout).toBe(1_234);
    expect(server.keepAliveTimeout).toBe(3_000);
    expect(server.headersTimeout).toBe(4_000);
  });
});

describe("createApiServer", () => {
  it("answers CORS preflight without auth", async () => {
    const server = createApiServer({ routes: [] });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/workflows`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      expect(requireAuthMock).not.toHaveBeenCalled();
      expect(requireRoleMock).not.toHaveBeenCalled();
      expect(requirePermissionMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("enforces auth and role before dispatching route handlers", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        match: "/secure",
        role: "editor",
        handler: async ({ auth, res }) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ orgId: auth.orgId, userId: auth.userId }));
        },
      },
    ];
    const server = createApiServer({ routes });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/secure`, {
        headers: { Origin: "http://localhost:5173" },
      });

      await expect(response.json()).resolves.toEqual({ orgId: "org-1", userId: "user-1" });
      expect(requireAuthMock).toHaveBeenCalledTimes(1);
      expect(requireRoleMock).toHaveBeenCalledWith("org-1", "user-1", "editor", "dev-headers");
    } finally {
      await close(server);
    }
  });

  it("dispatches identity-only bootstrap routes without tenant authorization", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        match: "/identity",
        identityOnly: true,
        handler: async ({ identity, res }) => sendJson(res, {
          userId: identity?.userId,
          orgId: identity?.orgHint,
        }),
      },
    ];
    const server = createApiServer({ routes });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/identity`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ userId: "identity-1", orgId: null });
      expect(requireIdentityMock).toHaveBeenCalledTimes(1);
      expect(requireAuthMock).not.toHaveBeenCalled();
      expect(requireRoleMock).not.toHaveBeenCalled();
      expect(requirePermissionMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("dispatches an optional-identity probe without turning absence into 401", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        match: "/identity/optional",
        optionalIdentity: true,
        handler: async ({ identity, res }) => sendJson(res, { authenticated: identity !== null }),
      },
    ];
    const server = createApiServer({ routes });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/identity/optional`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ authenticated: false });
      expect(getIdentityMock).toHaveBeenCalledTimes(1);
      expect(requireIdentityMock).not.toHaveBeenCalled();
      expect(requireAuthMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("responds with a generic message and logs server-side when a handler throws without a statusCode", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        match: "/explodes",
        handler: async () => {
          // Simulates an uncurated internal failure (driver error, bug). The
          // raw message must never reach the client.
          throw new Error("connection refused to db-internal-host:5432 (password=hunter2)");
        },
      },
    ];
    const server = createApiServer({ routes });
    const baseUrl = await listen(server);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = await fetch(`${baseUrl}/explodes`, {
        headers: { Origin: "http://localhost:5173" },
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Server error", code: "server_internal_error" });
      // The real error is preserved server-side for diagnosis.
      expect(consoleError).toHaveBeenCalledWith(
        "[api] unhandled route error",
        expect.objectContaining({ method: "GET", url: "/explodes" }),
      );
    } finally {
      consoleError.mockRestore();
      await close(server);
    }
  });

  it("keeps the curated message for deliberate httpError throws", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        match: "/teapot",
        handler: async () => {
          const err = new Error("workflowId is required") as Error & { statusCode?: number };
          err.statusCode = 422;
          throw err;
        },
      },
    ];
    const server = createApiServer({ routes });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/teapot`, {
        headers: { Origin: "http://localhost:5173" },
      });

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({ error: "workflowId is required", code: "server_request_failed" });
    } finally {
      await close(server);
    }
  });

  it("enforces declared permissions after auth and role gates", async () => {
    const routes: Route[] = [
      {
        method: "POST",
        match: "/permissioned",
        role: "admin",
        permission: "org.permissions.write",
        handler: async ({ res }) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        },
      },
    ];
    const server = createApiServer({ routes });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/permissioned`, {
        method: "POST",
        headers: { Origin: "http://localhost:5173" },
      });

      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(requireAuthMock).toHaveBeenCalledTimes(1);
      expect(requireRoleMock).toHaveBeenCalledWith("org-1", "user-1", "admin", "dev-headers");
      expect(requirePermissionMock).toHaveBeenCalledWith("org-1", "user-1", "org.permissions.write", "dev-headers");
    } finally {
      await close(server);
    }
  });

  it("requires an allowlisted origin and CSRF marker for cookie-authenticated mutations", async () => {
    const handler = vi.fn(async ({ res }) => sendJson(res, { ok: true }));
    requireAuthMock.mockResolvedValue({
      orgId: "org-1",
      userId: "user-1",
      mode: "janusly-session",
      source: "web",
      browserSessionId: "session-1",
    });
    const server = createApiServer({
      routes: [{ method: "POST", match: "/cookie-write", handler }],
    });
    const baseUrl = await listen(server);

    try {
      const missingMarker = await fetch(`${baseUrl}/cookie-write`, {
        method: "POST",
        headers: { Origin: "http://localhost:5173" },
      });
      expect(missingMarker.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();

      const foreignOrigin = await fetch(`${baseUrl}/cookie-write`, {
        method: "POST",
        headers: { Origin: "https://attacker.example", "x-janusly-csrf": "1" },
      });
      expect(foreignOrigin.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();

      const accepted = await fetch(`${baseUrl}/cookie-write`, {
        method: "POST",
        headers: { Origin: "http://localhost:5173", "x-janusly-csrf": "1" },
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ ok: true });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      requireAuthMock.mockResolvedValue({
        orgId: "org-1",
        userId: "user-1",
        mode: "dev-headers",
        source: "dev",
      });
      await close(server);
    }
  });

  it("keeps legacy responses unchanged and wraps contracted v1 aliases", async () => {
    const contract = testContract();
    const routes: Route[] = [{
      method: "GET",
      match: (url) => url === "/stable" || url.startsWith("/stable?"),
      contract,
      handler: async ({ req, res }) => sendJson(res, { value: req.url }),
    }];
    const server = createApiServer({ routes });
    const baseUrl = await listen(server);

    try {
      const legacy = await fetch(`${baseUrl}/stable?limit=2`);
      expect(legacy.status).toBe(200);
      await expect(legacy.json()).resolves.toEqual({ value: "/stable?limit=2" });

      const versioned = await fetch(`${baseUrl}/v1/stable?limit=2`, {
        headers: { "X-Request-Id": "browser-request-42" },
      });
      expect(versioned.status).toBe(200);
      expect(versioned.headers.get("x-request-id")).toBe("browser-request-42");
      await expect(versioned.json()).resolves.toEqual({
        apiVersion: "v1",
        requestId: "browser-request-42",
        data: { value: "/stable?limit=2" },
      });
    } finally {
      await close(server);
    }
  });

  it("rejects unknown query keys and uncontracted v1 aliases", async () => {
    const handler = vi.fn(async ({ res }) => sendJson(res, { value: "ok" }));
    const routes: Route[] = [
      {
        method: "GET",
        match: (url) => url.startsWith("/stable"),
        contract: testContract(),
        handler,
      },
      { method: "GET", match: "/legacy-only", handler },
    ];
    const server = createApiServer({ routes });
    const baseUrl = await listen(server);

    try {
      const invalid = await fetch(`${baseUrl}/v1/stable?unknown=yes`);
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        apiVersion: "v1",
        error: { code: "invalid_input", message: "Invalid request query" },
      });

      const unavailable = await fetch(`${baseUrl}/v1/legacy-only`);
      expect(unavailable.status).toBe(404);
      await expect(unavailable.json()).resolves.toMatchObject({
        apiVersion: "v1",
        error: { code: "server_not_found", message: "Not found" },
      });

      const broadMatcherBypass = await fetch(`${baseUrl}/v1/stable-extra`);
      expect(broadMatcherBypass.status).toBe(404);
      await expect(broadMatcherBypass.json()).resolves.toMatchObject({
        apiVersion: "v1",
        error: { code: "server_not_found" },
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("validates contracted v1 bodies before dispatch and lets handlers reuse the parsed body", async () => {
    const handler = vi.fn(async ({ req, res }) => {
      const body = await readJson(req, 1_048_576);
      sendJson(res, { value: (body as { value: string }).value });
    });
    const contract: ApiRouteContract = {
      ...testContract("createStable", "/stable"),
      request: {
        body: z.object({ value: z.string().min(1) }).strict(),
      },
    };
    const server = createApiServer({
      routes: [{ method: "POST", match: "/stable", contract, handler }],
    });
    const baseUrl = await listen(server);

    try {
      const valid = await fetch(`${baseUrl}/v1/stable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "accepted" }),
      });
      expect(valid.status).toBe(200);
      await expect(valid.json()).resolves.toMatchObject({
        apiVersion: "v1",
        data: { value: "accepted" },
      });
      expect(handler).toHaveBeenCalledTimes(1);

      const invalid = await fetch(`${baseUrl}/v1/stable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "accepted", unexpected: true }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        apiVersion: "v1",
        error: {
          code: "invalid_input",
          message: "Invalid request body",
          params: { field: "body" },
        },
      });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });

  it("validates decoded path parameters before dispatching dynamic v1 aliases", async () => {
    const handler = vi.fn(async ({ req, res }) => sendJson(res, { value: req.url ?? "" }));
    const contract: ApiRouteContract = {
      ...testContract("getConnection", "/connections/{alias}"),
      request: {
        path: z.object({ alias: z.string().regex(/^[a-z0-9_-]{1,32}$/) }).strict(),
      },
    };
    const server = createApiServer({
      routes: [{
        method: "GET",
        match: (url) => /^\/connections\/[^/?]+$/.test(url),
        contract,
        handler,
      }],
    });
    const baseUrl = await listen(server);

    try {
      const valid = await fetch(`${baseUrl}/v1/connections/demo-one`);
      expect(valid.status).toBe(200);
      await expect(valid.json()).resolves.toMatchObject({
        apiVersion: "v1",
        data: { value: "/connections/demo-one" },
      });

      const invalid = await fetch(`${baseUrl}/v1/connections/Bad%20Alias`);
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        apiVersion: "v1",
        error: {
          code: "invalid_input",
          message: "Invalid request path",
          params: { field: "alias" },
        },
      });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await close(server);
    }
  });

  it("keeps authentication failures inside the stable v1 error contract", async () => {
    const handler = vi.fn(async ({ res }) => sendJson(res, { value: "ok" }));
    const unauthorized = new Error("Unauthorized") as Error & { statusCode?: number };
    unauthorized.statusCode = 401;
    requireAuthMock.mockRejectedValueOnce(unauthorized);
    const server = createApiServer({
      routes: [{ method: "GET", match: "/stable", contract: testContract(), handler }],
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/v1/stable`, {
        headers: { "X-Request-Id": "unauthorized-request" },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("x-request-id")).toBe("unauthorized-request");
      await expect(response.json()).resolves.toEqual({
        apiVersion: "v1",
        requestId: "unauthorized-request",
        error: { code: "server_request_failed", message: "Unauthorized" },
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("uses the stable v1 error shape and fails closed on response drift", async () => {
    const routes: Route[] = [
      {
        method: "GET",
        match: "/denied",
        contract: { ...testContract("getDenied", "/denied"), errorCodes: ["runs_forbidden", "invalid_input"] },
        handler: async ({ res }) => sendError(res, "runs_forbidden", "Forbidden", 403),
      },
      {
        method: "GET",
        match: "/drifted",
        contract: testContract("getDrifted", "/drifted"),
        handler: async ({ res }) => sendJson(res, { unexpected: true }),
      },
    ];
    const server = createApiServer({ routes });
    const baseUrl = await listen(server);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const denied = await fetch(`${baseUrl}/v1/denied`);
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({
        apiVersion: "v1",
        error: { code: "runs_forbidden", message: "Forbidden" },
      });

      const drifted = await fetch(`${baseUrl}/v1/drifted`);
      expect(drifted.status).toBe(500);
      await expect(drifted.json()).resolves.toMatchObject({
        apiVersion: "v1",
        error: { code: "server_internal_error", message: "Server error" },
      });
      expect(consoleError).toHaveBeenCalledWith(
        "[api] v1 response contract violation",
        expect.objectContaining({ operationId: "getDrifted" }),
      );
    } finally {
      consoleError.mockRestore();
      await close(server);
    }
  });
});

describe("matchesContractPath", () => {
  it("matches exact paths and OpenAPI parameter segments only", () => {
    expect(matchesContractPath("/workflows", "/workflows?limit=20")).toBe(true);
    expect(matchesContractPath("/runs/{runId}", "/runs/run-1?detail=true")).toBe(true);
    expect(matchesContractPath("/workflows", "/workflows-extra")).toBe(false);
    expect(matchesContractPath("/runs/{runId}", "/runs/a/stream")).toBe(false);
  });
});

function testContract(operationId = "getStable", path: `/${string}` = "/stable"): ApiRouteContract {
  return {
    operationId,
    path,
    summary: "Test contract",
    tags: ["Test"],
    request: {
      query: z.object({ limit: z.coerce.number().int().positive().optional() }).strict(),
    },
    response: z.object({ value: z.string() }),
    errorCodes: ["invalid_input"],
  };
}

async function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;

  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
