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
  requireRole: vi.fn(async () => "editor"),
}));

import { requireAuth } from "./auth";
import { requireRole } from "./permissions";
import { configureApiServerTimeouts, createApiServer } from "./server";

const requireAuthMock = vi.mocked(requireAuth);
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
