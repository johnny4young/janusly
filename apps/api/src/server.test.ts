import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Route } from "./routes";

vi.mock("./auth", () => ({
  requireAuth: vi.fn(async () => ({
    orgId: "org-1",
    userId: "user-1",
    mode: "dev-headers",
  })),
}));

vi.mock("./permissions", () => ({
  requirePermission: vi.fn(async () => ({ name: "editor", inheritsFrom: "editor" })),
  requireRole: vi.fn(async () => "editor"),
}));

import { requireAuth } from "./auth";
import { requirePermission, requireRole } from "./permissions";
import { configureApiServerTimeouts, createApiServer } from "./server";

const requireAuthMock = vi.mocked(requireAuth);
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
      await expect(response.json()).resolves.toEqual({ error: "Server error" });
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
      await expect(response.json()).resolves.toEqual({ error: "workflowId is required" });
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
});

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
