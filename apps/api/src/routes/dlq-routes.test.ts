/**
 * Route-level tests for the DLQ list endpoint.
 *
 * The `GET /dlq` registry entry MUST declare `role: "viewer"` so the
 * dispatcher invokes `requireRole(...)` before reaching the handler.
 * Omitting `role:` lets the dispatcher fall through to the
 * authenticated-only check, which would expose every open dead letter
 * to any caller carrying a valid token (e.g. a service token without an
 * `org_members` row, or a stale Supabase JWT). The two sibling routes
 * (`/dlq/clusters` and `/dlq/cluster-members`) already declare
 * `role: "viewer"`; this test pins the contract symmetrically.
 *
 * Two test surfaces:
 * - Declarative pin on the registry entry's `role` field.
 * - Integration cases through `createApiServer` covering the 401 / 403
 *   / 200 paths the dispatcher walks for an unauthenticated request,
 *   an authenticated request below `viewer`, and a successful viewer /
 *   editor caller respectively.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("../permissions", () => ({
  requireRole: vi.fn(),
  requirePermission: vi.fn(),
}));

vi.mock("../dlq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dlq")>();
  return {
    ...actual,
    listRecoveryQueue: vi.fn(),
  };
});

import { requireAuth } from "../auth";
import { requireRole } from "../permissions";
import { listRecoveryQueue } from "../dlq";
import { createApiServer } from "../server";
import { dlqRoutes } from "./dlq-routes";
import type { Route } from "../routes";

const requireAuthMock = vi.mocked(requireAuth);
const requireRoleMock = vi.mocked(requireRole);
const listRecoveryQueueMock = vi.mocked(listRecoveryQueue);

function findRoute(method: string, path: string): Route {
  const route = dlqRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function makeStatusError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
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
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /dlq route declaration", () => {
  it("declares role: viewer so the dispatcher gates non-readers", () => {
    const route = findRoute("GET", "/dlq");
    expect(route.role).toBe("viewer");
  });

  it("does NOT declare a permission gate (no migration to permission: form per ROADMAP non-goal)", () => {
    const route = findRoute("GET", "/dlq");
    expect(route.permission).toBeUndefined();
  });

  it("matches the role posture of its sibling list routes", () => {
    expect(findRoute("GET", "/dlq/clusters").role).toBe("viewer");
    expect(findRoute("GET", "/dlq/cluster-members?signature=x").role).toBe("viewer");
  });
});

describe("GET /dlq dispatcher gate", () => {
  it("returns 401 when the caller is unauthenticated", async () => {
    requireAuthMock.mockRejectedValueOnce(makeStatusError("Unauthenticated", 401));
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq`);
      expect(response.status).toBe(401);
      expect(requireRoleMock).not.toHaveBeenCalled();
      expect(listRecoveryQueueMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("returns 403 when the caller is authenticated but below viewer (no org_members row)", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "service-token", source: "service" });
    requireRoleMock.mockRejectedValueOnce(makeStatusError("Forbidden: requires viewer role", 403));
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq`);
      expect(response.status).toBe(403);
      expect(requireRoleMock).toHaveBeenCalledWith("org-1", "user-1", "viewer", "service-token");
      expect(listRecoveryQueueMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("returns 200 with the DLQ list when the caller has viewer membership", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    listRecoveryQueueMock.mockResolvedValueOnce([{ id: "dl-1", orgId: "org-1", runId: "r-1", nodeId: "n-1", status: "open" } as never]);
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq`);
      expect(response.status).toBe(200);
      const payload = await response.json() as Array<{ id: string }>;
      expect(payload).toHaveLength(1);
      expect(payload[0]?.id).toBe("dl-1");
      // Bare /dlq: no filters, no sort — the home-preview path.
      expect(listRecoveryQueueMock).toHaveBeenCalledWith("org-1", {
        status: null,
        owner: null,
        severity: undefined,
        sort: undefined,
        limit: undefined,
      });
    } finally {
      await close(server);
    }
  });

  it("returns 200 byte-for-byte when the caller has editor or admin membership", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-2", userId: "user-2", mode: "dev-headers", source: "dev" });
    requireRoleMock.mockResolvedValueOnce("editor");
    listRecoveryQueueMock.mockResolvedValueOnce([]);
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq`);
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual([]);
      expect(requireRoleMock).toHaveBeenCalledWith("org-2", "user-2", "viewer", "dev-headers");
    } finally {
      await close(server);
    }
  });
});

describe("GET /dlq filter + sort param wiring", () => {
  it("threads owner=me → auth.userId and passes severity + sort through to the query", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    listRecoveryQueueMock.mockResolvedValueOnce([]);
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq?owner=me&severity=p1&sort=severity&status=open&limit=200`);
      expect(response.status).toBe(200);
      expect(listRecoveryQueueMock).toHaveBeenCalledWith("org-1", {
        status: "open",
        owner: "user-1",
        severity: "p1",
        sort: "severity",
        limit: 200,
      });
    } finally {
      await close(server);
    }
  });

  it("rejects an unknown severity with 400 and never queries", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq?severity=p9`);
      expect(response.status).toBe(400);
      expect(listRecoveryQueueMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("rejects an unknown sort with 400 and never queries", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq?sort=sideways`);
      expect(response.status).toBe(400);
      expect(listRecoveryQueueMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});
