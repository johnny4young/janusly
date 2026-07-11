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

const { findMatchingPlaybookMock, replayDeadLetterMock, replayValidationMock } = vi.hoisted(() => ({
  findMatchingPlaybookMock: vi.fn(),
  replayDeadLetterMock: vi.fn(),
  replayValidationMock: vi.fn(),
}));

vi.mock("@janusly/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@janusly/data")>();
  return { ...actual, findMatchingActiveRecoveryPlaybook: findMatchingPlaybookMock };
});

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
    // The list + page + counts queries are mocked; the cursor codec stays real
    // so the /dlq/queue wiring tests exercise the actual decode → thread path.
    listRecoveryQueue: vi.fn(),
    queryRecoveryQueuePage: vi.fn(),
    countDeadLettersByStatus: vi.fn(),
    // Bulk-resolve + bulk-replay writers (the loops touch these per entry).
    getDeadLetter: vi.fn(),
    markDeadLetterResolved: vi.fn(),
    markDeadLetterReplayed: vi.fn(),
  };
});

// Bulk-resolve also audits per entry + auto-closes the linked recovery item.
vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));

// M-08: the detail read attaches the suspect-version correlation; mocked so
// the route tests control hit/miss without a DB.
vi.mock("../suspect-version", () => ({ resolveSuspectVersion: vi.fn() }));

// Cluster-apply gates on the org's AI rate limit before the loop; both are
// infra chokepoints (DB org-config read + Redis) irrelevant to route logic.
vi.mock("../ai-runtime", () => ({
  orgLlmRuntime: vi.fn(async () => ({ orgConfig: { ai: { rateLimitPerMin: 60 } } })),
  sanitizeAiWorkflow: vi.fn((workflow: unknown) => workflow),
}));
vi.mock("../rate-limit", () => ({ enforceRateLimit: vi.fn() }));

// The signature recheck guards against stale member lists; route tests pin
// the downtime accounting, not the signature algebra (covered in
// cluster-recovery's own tests) — force a match.
vi.mock("../cluster-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cluster-recovery")>();
  return { ...actual, recheckSignature: vi.fn(() => true) };
});
vi.mock("@janusly/engine/src/recovery/recovery-item-hook", () => ({
  autoResolveRecoveryItemFromReplay: vi.fn(),
  createRecoveryItemForDeadLetter: vi.fn(),
}));

// Bulk-replay drives the shared DLQReplayAdapter instance created at module
// load; stub it with a REAL class so `new DLQReplayAdapter()` constructs
// cleanly (vitest `Reflect.construct`s a `new`-ed mock — an arrow factory
// would throw "not a constructor"). Each instance's replayDeadLetter is the
// shared hoisted mock we assert on / make reject.
vi.mock("@janusly/engine/src/adapters/dlq-replay", () => ({
  DLQReplayAdapter: class {
    replayDeadLetter = replayDeadLetterMock;
    replayDeadLetterAsValidation = replayValidationMock;
  },
}));

// The real claim error is not mocked, so the route's `instanceof` check and this
// test agree on the same class (the persistence module is loaded transitively
// by the route import; importing the class adds no DB connection).
import { ReplayNotClaimableError } from "@janusly/engine/src/persistence";

import { requireAuth } from "../auth";
import { requireRole } from "../permissions";
import { countDeadLettersByStatus, encodeRecoveryQueueCursor, getDeadLetter, listRecoveryQueue, markDeadLetterReplayed, markDeadLetterResolved, queryRecoveryQueuePage, type RecoveryQueueRow } from "../dlq";
import { auditAction } from "../audit-helper";
import { resolveSuspectVersion } from "../suspect-version";
import { autoResolveRecoveryItemFromReplay } from "@janusly/engine/src/recovery/recovery-item-hook";
import { createApiServer } from "../server";
import { dlqRoutes } from "./dlq-routes";
import type { Route } from "../routes";

const requireAuthMock = vi.mocked(requireAuth);
const requireRoleMock = vi.mocked(requireRole);
const listRecoveryQueueMock = vi.mocked(listRecoveryQueue);
const queryRecoveryQueuePageMock = vi.mocked(queryRecoveryQueuePage);
const countDeadLettersByStatusMock = vi.mocked(countDeadLettersByStatus);
const getDeadLetterMock = vi.mocked(getDeadLetter);
const markDeadLetterResolvedMock = vi.mocked(markDeadLetterResolved);
const markDeadLetterReplayedMock = vi.mocked(markDeadLetterReplayed);
const auditActionMock = vi.mocked(auditAction);
const autoResolveMock = vi.mocked(autoResolveRecoveryItemFromReplay);
const resolveSuspectVersionMock = vi.mocked(resolveSuspectVersion);

/** A cursor minted by the REAL encoder, for the /dlq/queue wiring tests. */
function cursorFor(sort: "newest" | "oldest" | "severity" | "sla", id: string, severity = "p1"): string {
  const row = {
    id,
    createdAt: new Date("2026-06-01T10:00:00.000Z"),
    recovery: { severity, slaTargetAt: new Date("2026-06-02T10:00:00.000Z") },
  } as unknown as RecoveryQueueRow;
  return encodeRecoveryQueueCursor(sort, row);
}

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
  vi.unstubAllEnvs();
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

  it("threads a trimmed ?search= term through to the bare /dlq query", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    listRecoveryQueueMock.mockResolvedValueOnce([]);
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq?search=${encodeURIComponent("  timeout  ")}`);
      expect(response.status).toBe(200);
      expect(listRecoveryQueueMock).toHaveBeenCalledWith("org-1", expect.objectContaining({ search: "timeout" }));
    } finally {
      await close(server);
    }
  });

  it("drops an over-cap (>100) ?search= so search stays undefined", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    listRecoveryQueueMock.mockResolvedValueOnce([]);
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq?search=${encodeURIComponent("x".repeat(101))}`);
      expect(response.status).toBe(200);
      const call = listRecoveryQueueMock.mock.calls[0];
      expect(call?.[1]?.search).toBeUndefined();
    } finally {
      await close(server);
    }
  });
});

describe("GET /dlq/queue (keyset pagination)", () => {
  it("declares role: viewer, matching the bare /dlq surface", () => {
    expect(findRoute("GET", "/dlq/queue").role).toBe("viewer");
  });

  it("resolves to the paginated route BEFORE the /dlq wildcard (first-match-wins)", () => {
    // Both routes match "/dlq/queue"; the registry must list the queue route
    // first so the dispatcher reaches the page handler, not the bare array.
    const matchesGet = (r: Route, url: string) =>
      r.method === "GET" && (typeof r.match === "string" ? r.match === url : r.match(url));
    const queueIdx = dlqRoutes.findIndex((r) => matchesGet(r, "/dlq/queue"));
    // The catch-all is the GET route that swallows an arbitrary /dlq path.
    const wildcardIdx = dlqRoutes.findIndex((r) => matchesGet(r, "/dlq/anything-else"));
    expect(queueIdx).toBeGreaterThanOrEqual(0);
    expect(wildcardIdx).toBeGreaterThanOrEqual(0);
    expect(queueIdx).toBeLessThan(wildcardIdx);
  });

  it("returns the { items, nextCursor, hasMore } envelope and threads owner=me + filters + pageSize", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    const envelope = { items: [{ id: "dl-1" } as never], nextCursor: "next-abc", hasMore: true };
    queryRecoveryQueuePageMock.mockResolvedValueOnce(envelope);
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const cursor = cursorFor("severity", "dl-9", "p2");
      const response = await fetch(`${baseUrl}/dlq/queue?owner=me&severity=p1&sort=severity&status=open&limit=50&cursor=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(envelope);
      // The raw cursor is DECODED (real codec) and threaded as the cursor object;
      // pageSize rides as the 3rd arg; the bare /dlq path is untouched.
      expect(listRecoveryQueueMock).not.toHaveBeenCalled();
      expect(queryRecoveryQueuePageMock).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({
          status: "open",
          owner: "user-1",
          severity: "p1",
          sort: "severity",
          cursor: expect.objectContaining({ id: "dl-9", key: "p2" }),
        }),
        50,
      );
    } finally {
      await close(server);
    }
  });

  it("threads ?search= through to the paginated query", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    queryRecoveryQueuePageMock.mockResolvedValueOnce({ items: [], nextCursor: null, hasMore: false });
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/queue?search=${encodeURIComponent("run-abc")}`);
      expect(response.status).toBe(200);
      expect(queryRecoveryQueuePageMock).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ search: "run-abc" }),
        undefined,
      );
    } finally {
      await close(server);
    }
  });

  it("ignores a cursor minted under a different sort (→ page 1, cursor: null)", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    queryRecoveryQueuePageMock.mockResolvedValueOnce({ items: [], nextCursor: null, hasMore: false });
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      // cursor minted under "severity" but the request asks for "newest".
      const cursor = cursorFor("severity", "dl-9");
      const response = await fetch(`${baseUrl}/dlq/queue?sort=newest&cursor=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(200);
      const call = queryRecoveryQueuePageMock.mock.calls[0];
      expect(call?.[1]?.cursor).toBeNull();
    } finally {
      await close(server);
    }
  });

  it("rejects an unknown severity / sort with 400 and never queries", async () => {
    requireAuthMock.mockResolvedValue({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValue("viewer");
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      expect((await fetch(`${baseUrl}/dlq/queue?severity=p9`)).status).toBe(400);
      expect((await fetch(`${baseUrl}/dlq/queue?sort=sideways`)).status).toBe(400);
      expect(queryRecoveryQueuePageMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});

describe("GET /dlq/counts (org-wide mini-grid)", () => {
  it("declares role: viewer", () => {
    expect(findRoute("GET", "/dlq/counts").role).toBe("viewer");
  });

  it("resolves to the counts route BEFORE the /dlq wildcard (first-match-wins)", () => {
    const matchesGet = (r: Route, url: string) =>
      r.method === "GET" && (typeof r.match === "string" ? r.match === url : r.match(url));
    const countsIdx = dlqRoutes.findIndex((r) => matchesGet(r, "/dlq/counts"));
    const wildcardIdx = dlqRoutes.findIndex((r) => matchesGet(r, "/dlq/anything-else"));
    expect(countsIdx).toBeGreaterThanOrEqual(0);
    expect(wildcardIdx).toBeGreaterThanOrEqual(0);
    expect(countsIdx).toBeLessThan(wildcardIdx);
  });

  it("returns the org-wide { total, open, replayed, resolved } envelope for the caller's org", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    const envelope = { total: 120, open: 100, replayed: 15, resolved: 5 };
    countDeadLettersByStatusMock.mockResolvedValueOnce(envelope);
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/counts`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(envelope);
      expect(countDeadLettersByStatusMock).toHaveBeenCalledWith("org-1");
      // The summary is its own query — the list + page paths are untouched.
      expect(listRecoveryQueueMock).not.toHaveBeenCalled();
      expect(queryRecoveryQueuePageMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});

describe("POST /dlq/bulk-resolve", () => {
  it("declares role editor on the registry entry", () => {
    expect(findRoute("POST", "/dlq/bulk-resolve").role).toBe("editor");
  });

  it("resolves every listed open entry + audits each as a bulk dlq.resolved", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    getDeadLetterMock.mockImplementation(async (_orgId: string, id: string) => ({ id, orgId: "org-1", runId: "r", nodeId: "n", status: "open" } as never));
    markDeadLetterResolvedMock.mockResolvedValue(undefined as never);
    autoResolveMock.mockResolvedValue(undefined as never);

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/bulk-resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterIds: ["dl-1", "dl-2"] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ resolved: 2, failed: 0, errors: [] });
      // Each id is org-scoped, marked resolved, audited (bulk flag), auto-closed.
      expect(markDeadLetterResolvedMock).toHaveBeenCalledWith("org-1", "dl-1");
      expect(markDeadLetterResolvedMock).toHaveBeenCalledWith("org-1", "dl-2");
      expect(auditActionMock).toHaveBeenCalledTimes(2);
      expect(auditActionMock).toHaveBeenCalledWith(expect.anything(), "dlq.resolved", expect.objectContaining({ targetType: "dlq", targetId: "dl-1", metadata: { bulk: true } }));
      expect(autoResolveMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", deadLetterId: "dl-2", resolutionReason: "accepted_loss", via: "dlq_resolve" }));
    } finally {
      await close(server);
    }
  });

  it("reports a not-found / cross-org id in errors without aborting the batch (partial success)", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    // dl-1 exists in the org; ghost is not found (cross-org / bogus → null).
    getDeadLetterMock.mockImplementation(async (_orgId: string, id: string) => (id === "dl-1" ? ({ id, orgId: "org-1", runId: "r", nodeId: "n", status: "open" } as never) : (null as never)));
    markDeadLetterResolvedMock.mockResolvedValue(undefined as never);
    autoResolveMock.mockResolvedValue(undefined as never);

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/bulk-resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterIds: ["dl-1", "ghost"] }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as { resolved: number; failed: number; errors: Array<{ deadLetterId: string }> };
      expect(payload.resolved).toBe(1);
      expect(payload.failed).toBe(1);
      expect(payload.errors[0]?.deadLetterId).toBe("ghost");
      // The unresolvable id never reaches the writer.
      expect(markDeadLetterResolvedMock).toHaveBeenCalledTimes(1);
      expect(markDeadLetterResolvedMock).toHaveBeenCalledWith("org-1", "dl-1");
    } finally {
      await close(server);
    }
  });

  it("rejects an empty or missing deadLetterIds array with 400", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/bulk-resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterIds: [] }),
      });
      expect(response.status).toBe(400);
      expect(getDeadLetterMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("rejects an over-cap batch with 400", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const tooMany = Array.from({ length: 101 }, (_, i) => `dl-${i}`);
      const response = await fetch(`${baseUrl}/dlq/bulk-resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterIds: tooMany }),
      });
      expect(response.status).toBe(400);
      expect(markDeadLetterResolvedMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});

describe("POST /dlq/replay suggestedWorkflow (apply-a-fix)", () => {
  const failedItem = {
    id: "dl-1",
    orgId: "org-1",
    runId: "run-1",
    nodeId: "n",
    status: "open",
    workflowJson: { id: "wf-1", name: "WF", nodes: [{ id: "n", type: "http", config: { url: "https://x", method: "GET" } }], edges: [] },
    nodeJson: { id: "n", type: "http", config: { url: "https://x", method: "GET" } },
  };

  it("replays against the supplied fix (not the original snapshot) when suggestedWorkflow is given", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    getDeadLetterMock.mockResolvedValueOnce(failedItem as never);
    replayDeadLetterMock.mockResolvedValue(undefined as never);
    markDeadLetterReplayedMock.mockResolvedValue(undefined as never);
    autoResolveMock.mockResolvedValue(undefined as never);

    const fix = { id: "wf-1", name: "WF", nodes: [{ id: "n", type: "noop", config: {} }], edges: [] };
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterId: "dl-1", suggestedWorkflow: fix }),
      });
      expect(response.status).toBe(200);
      // The adapter receives the FIX (node `n` is now a noop), not the original http node.
      const call = replayDeadLetterMock.mock.calls[0][0] as { workflow: { nodes: Array<{ id: string; type: string }> } };
      expect(call.workflow.nodes.find((x) => x.id === "n")?.type).toBe("noop");
    } finally {
      await close(server);
    }
  });

  it("400s when the suggestedWorkflow drops the failing node id", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    getDeadLetterMock.mockResolvedValueOnce(failedItem as never);
    replayDeadLetterMock.mockReset();

    const noFailingNode = { id: "wf-1", name: "WF", nodes: [{ id: "other", type: "noop", config: {} }], edges: [] };
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterId: "dl-1", suggestedWorkflow: noFailingNode }),
      });
      expect(response.status).toBe(400);
      expect(replayDeadLetterMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("maps a run_not_replayable rejection to 409 dlq_replay_conflict (not a silent no-op)", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    getDeadLetterMock.mockResolvedValueOnce(failedItem as never);
    replayDeadLetterMock.mockReset();
    replayDeadLetterMock.mockRejectedValueOnce(new ReplayNotClaimableError("run_not_replayable"));
    markDeadLetterReplayedMock.mockReset();

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterId: "dl-1" }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("dlq_replay_conflict");
      // A rejected claim must NOT mark the DLQ row replayed.
      expect(markDeadLetterReplayedMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("maps a node_mid_retry rejection to 409 dlq_node_mid_retry", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    getDeadLetterMock.mockResolvedValueOnce(failedItem as never);
    replayDeadLetterMock.mockReset();
    replayDeadLetterMock.mockRejectedValueOnce(new ReplayNotClaimableError("node_mid_retry"));

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterId: "dl-1" }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("dlq_node_mid_retry");
    } finally {
      await close(server);
    }
  });
});

describe("POST /dlq/validate-fix with a Recovery Playbook", () => {
  const sourceWorkflow = {
    id: "wf-1",
    name: "WF",
    dslVersion: "1.0",
    nodes: [{ id: "n", type: "http", config: { url: "https://example.com", method: "GET", timeoutMs: 5000 } }],
    edges: [],
  };
  const item = {
    id: "dl-1",
    orgId: "org-1",
    runId: "run-1",
    nodeId: "n",
    status: "open",
    workflowJson: sourceWorkflow,
    nodeJson: sourceWorkflow.nodes[0],
    errorJson: { message: "request timed out" },
  };

  it("attests only an active exact-match playbook on the validation run", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    getDeadLetterMock.mockResolvedValueOnce(item as never);
    findMatchingPlaybookMock.mockResolvedValueOnce({ id: "pb-1", sourceWorkflow });
    replayValidationMock.mockResolvedValueOnce({ runId: "validation-1" });

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/validate-fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterId: "dl-1", suggestedWorkflow: sourceWorkflow, recoveryPlaybookId: "pb-1" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ runId: "validation-1" });
      expect(findMatchingPlaybookMock).toHaveBeenCalledWith("org-1", "wf-1", expect.any(String));
      expect(replayValidationMock).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "org-1",
        originalRunId: "run-1",
        recoveryPlaybookId: "pb-1",
      }));
      expect(auditActionMock).toHaveBeenCalledWith(expect.anything(), "recovery.validation_started", expect.objectContaining({
        metadata: { validationRunId: "validation-1", recoveryPlaybookId: "pb-1" },
      }));
    } finally {
      await close(server);
    }
  });

  it("rejects a stale or modified playbook source before starting sandbox", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    getDeadLetterMock.mockResolvedValueOnce(item as never);
    findMatchingPlaybookMock.mockResolvedValueOnce({ id: "pb-1", sourceWorkflow });
    replayValidationMock.mockReset();
    const modified = {
      ...sourceWorkflow,
      nodes: [{ ...sourceWorkflow.nodes[0], config: { ...sourceWorkflow.nodes[0].config, timeoutMs: 9000 } }],
    };

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/validate-fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterId: "dl-1", suggestedWorkflow: modified, recoveryPlaybookId: "pb-1" }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("recovery_playbook_match_changed");
      expect(replayValidationMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});

describe("POST /dlq/bulk-replay", () => {
  // An open DLQ row whose stored JSONs pass the real Workflow/Node schemas, so
  // the route reaches the (mocked) replay adapter instead of erroring at parse.
  const openItem = (id: string, status = "open") => ({
    id,
    orgId: "org-1",
    runId: "run-1",
    nodeId: "n",
    status,
    workflowJson: { id: "wf-1", name: "WF", nodes: [{ id: "n", type: "noop", config: {} }], edges: [] },
    nodeJson: { id: "n", type: "noop", config: {} },
  });

  it("declares editor role + dlq.replay permission on the registry entry", () => {
    const route = findRoute("POST", "/dlq/bulk-replay");
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("dlq.replay");
  });

  it("replays every listed open entry + audits each as a bulk dlq.replayed", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    getDeadLetterMock.mockImplementation(async (_orgId: string, id: string) => openItem(id) as never);
    replayDeadLetterMock.mockResolvedValue(undefined as never);
    markDeadLetterReplayedMock.mockResolvedValue(undefined as never);
    autoResolveMock.mockResolvedValue(undefined as never);

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/bulk-replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterIds: ["dl-1", "dl-2"] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ replayed: 2, failed: 0, errors: [] });
      // Each id is replayed via the shared adapter, marked replayed, audited
      // (bulk flag), and its recovery item auto-closed.
      expect(replayDeadLetterMock).toHaveBeenCalledTimes(2);
      expect(markDeadLetterReplayedMock).toHaveBeenCalledWith("org-1", "dl-1");
      expect(markDeadLetterReplayedMock).toHaveBeenCalledWith("org-1", "dl-2");
      expect(auditActionMock).toHaveBeenCalledTimes(2);
      expect(auditActionMock).toHaveBeenCalledWith(
        expect.anything(),
        "dlq.replayed",
        expect.objectContaining({ targetType: "dlq", targetId: "dl-1", metadata: expect.objectContaining({ bulk: true }) }),
      );
      expect(autoResolveMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", deadLetterId: "dl-2", actor: "user-1" }));
    } finally {
      await close(server);
    }
  });

  it("reports a not-found / cross-org id in errors without aborting the batch (partial success)", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    // dl-1 exists in the org; ghost is not found (cross-org / bogus → null).
    getDeadLetterMock.mockImplementation(async (_orgId: string, id: string) => (id === "dl-1" ? (openItem(id) as never) : (null as never)));
    replayDeadLetterMock.mockResolvedValue(undefined as never);
    markDeadLetterReplayedMock.mockResolvedValue(undefined as never);
    autoResolveMock.mockResolvedValue(undefined as never);

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/bulk-replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterIds: ["dl-1", "ghost"] }),
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { replayed: number; failed: number; errors: Array<{ deadLetterId: string }> };
      expect(payload.replayed).toBe(1);
      expect(payload.failed).toBe(1);
      expect(payload.errors[0]?.deadLetterId).toBe("ghost");
      // The unreplayable id never reaches the replay adapter.
      expect(replayDeadLetterMock).toHaveBeenCalledTimes(1);
      expect(markDeadLetterReplayedMock).toHaveBeenCalledTimes(1);
      expect(markDeadLetterReplayedMock).toHaveBeenCalledWith("org-1", "dl-1");
    } finally {
      await close(server);
    }
  });

  it("skips a non-open entry (status guard) and never replays it", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    // dl-1 is open; dl-2 was already replayed by another path → must be skipped.
    getDeadLetterMock.mockImplementation(async (_orgId: string, id: string) =>
      id === "dl-2" ? (openItem(id, "replayed") as never) : (openItem(id) as never),
    );
    replayDeadLetterMock.mockResolvedValue(undefined as never);
    markDeadLetterReplayedMock.mockResolvedValue(undefined as never);
    autoResolveMock.mockResolvedValue(undefined as never);

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/bulk-replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterIds: ["dl-1", "dl-2"] }),
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { replayed: number; failed: number; errors: Array<{ deadLetterId: string; error: string }> };
      expect(payload.replayed).toBe(1);
      expect(payload.failed).toBe(1);
      expect(payload.errors[0]).toEqual({ deadLetterId: "dl-2", error: "DLQ entry already replayed" });
      // Only the open row reaches the adapter — no double-enqueue on dl-2.
      expect(replayDeadLetterMock).toHaveBeenCalledTimes(1);
      expect(markDeadLetterReplayedMock).toHaveBeenCalledWith("org-1", "dl-1");
      expect(markDeadLetterReplayedMock).not.toHaveBeenCalledWith("org-1", "dl-2");
    } finally {
      await close(server);
    }
  });

  it("rejects an empty or missing deadLetterIds array with 400", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/bulk-replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterIds: [] }),
      });
      expect(response.status).toBe(400);
      expect(getDeadLetterMock).not.toHaveBeenCalled();
      expect(replayDeadLetterMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("rejects an over-cap batch with 400", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const tooMany = Array.from({ length: 101 }, (_, i) => `dl-${i}`);
      const response = await fetch(`${baseUrl}/dlq/bulk-replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterIds: tooMany }),
      });
      expect(response.status).toBe(400);
      expect(replayDeadLetterMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});

// Proves `guardMcpWrite` is WIRED at the top of POST /dlq/replay — an
// MCP-source caller (that passes RBAC) with the process flag off is refused
// before the DLQ row is even looked up, so no node is re-enqueued.
describe("POST /dlq/replay — MCP-source write consent gate", () => {
  it("refuses MCP-source replay (403 mcp_process_disabled) with the process flag off, and never re-enqueues", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "service-token", source: "mcp", serviceTokenSuffix: "abcd" });
    requireRoleMock.mockResolvedValueOnce("editor");

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deadLetterId: "dl-1" }),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("mcp_process_disabled");
      // Gate fired before the DLQ lookup + the replay adapter.
      expect(getDeadLetterMock).not.toHaveBeenCalled();
      expect(replayDeadLetterMock).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});

describe("GET /dlq?id= detail read (M-08 suspect version)", () => {
  const DETAIL_ROW = {
    id: "dl-1",
    orgId: "org-1",
    runId: "run-1",
    nodeId: "n-1",
    status: "open",
    createdAt: new Date("2026-07-10T12:00:00.000Z"),
    errorJson: { message: "boom" },
  };

  it("attaches the resolver's envelope to the detail response", async () => {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("viewer");
    getDeadLetterMock.mockResolvedValueOnce(DETAIL_ROW as never);
    const envelope = {
      workflowId: "wf-1",
      version: 4,
      versionId: "wfv-4",
      savedAt: "2026-07-10T11:30:00.000Z",
      previousVersion: 3,
      previousVersionId: "wfv-3",
      dagJson: { id: "wf-1", nodes: [] },
      previousDagJson: { id: "wf-1", nodes: [] },
    };
    resolveSuspectVersionMock.mockResolvedValueOnce(envelope as never);
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/dlq?id=dl-1`);
      expect(response.status).toBe(200);
      const payload = await response.json() as { id: string; suspectVersion: unknown };
      expect(payload.id).toBe("dl-1");
      expect(payload.suspectVersion).toEqual(envelope);
      // The resolver gets the row's own runId + failure timestamp.
      expect(resolveSuspectVersionMock).toHaveBeenCalledWith("org-1", "run-1", DETAIL_ROW.createdAt);
    } finally {
      await close(server);
    }
  });

  it("attaches null when no correlation, and a resolver throw never breaks the detail read", async () => {
    requireAuthMock.mockResolvedValue({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValue("viewer");
    getDeadLetterMock.mockResolvedValue(DETAIL_ROW as never);
    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      resolveSuspectVersionMock.mockResolvedValueOnce(null);
      const missResponse = await fetch(`${baseUrl}/dlq?id=dl-1`);
      expect(missResponse.status).toBe(200);
      expect(((await missResponse.json()) as { suspectVersion: unknown }).suspectVersion).toBeNull();

      resolveSuspectVersionMock.mockRejectedValueOnce(new Error("db hiccup"));
      const errorResponse = await fetch(`${baseUrl}/dlq?id=dl-1`);
      expect(errorResponse.status).toBe(200);
      expect(((await errorResponse.json()) as { suspectVersion: unknown }).suspectVersion).toBeNull();
    } finally {
      await close(server);
    }
  });
});

describe("POST /dlq/cluster-apply downtime accounting", () => {
  function openMember(id: string, createdAt: Date | null) {
    return {
      id,
      orgId: "org-1",
      runId: `run-${id}`,
      nodeId: "n",
      status: "open",
      createdAt,
      workflowJson: { id: "wf-1", name: "WF", nodes: [{ id: "n", type: "http", config: { url: "https://x", method: "GET" } }], edges: [] },
      nodeJson: { id: "n", type: "http", config: { url: "https://x", method: "GET" } },
    };
  }

  function editorAuth() {
    requireAuthMock.mockResolvedValueOnce({ orgId: "org-1", userId: "user-1", mode: "supabase", source: "web" });
    requireRoleMock.mockResolvedValueOnce("editor");
  }

  async function applyCluster(baseUrl: string, deadLetterIds: string[]) {
    return fetch(`${baseUrl}/dlq/cluster-apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clusterSignature: "sig-1", deadLetterIds }),
    });
  }

  it("sums (now − createdAt) across successfully replayed members", async () => {
    editorAuth();
    const now = Date.now();
    getDeadLetterMock
      .mockResolvedValueOnce(openMember("dl-1", new Date(now - 60_000)) as never)
      .mockResolvedValueOnce(openMember("dl-2", new Date(now - 120_000)) as never);
    replayDeadLetterMock.mockResolvedValue(undefined as never);
    markDeadLetterReplayedMock.mockResolvedValue(undefined as never);

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await applyCluster(baseUrl, ["dl-1", "dl-2"]);
      expect(response.status).toBe(200);
      const payload = await response.json() as { replayed: number; failed: number; downtimeEndedMs: number };
      expect(payload.replayed).toBe(2);
      expect(payload.failed).toBe(0);
      // ~60s + ~120s of downtime ended; bounded loosely for wall-clock drift.
      expect(payload.downtimeEndedMs).toBeGreaterThanOrEqual(180_000);
      expect(payload.downtimeEndedMs).toBeLessThan(200_000);
    } finally {
      await close(server);
    }
  });

  it("a failed member contributes nothing; legacy rows without createdAt contribute 0", async () => {
    editorAuth();
    const now = Date.now();
    getDeadLetterMock
      .mockResolvedValueOnce(openMember("dl-1", new Date(now - 60_000)) as never)
      .mockResolvedValueOnce(null as never) // dl-2 vanished → per-row error
      .mockResolvedValueOnce(openMember("dl-3", null) as never); // legacy row
    replayDeadLetterMock.mockResolvedValue(undefined as never);
    markDeadLetterReplayedMock.mockResolvedValue(undefined as never);

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await applyCluster(baseUrl, ["dl-1", "dl-2", "dl-3"]);
      expect(response.status).toBe(200);
      const payload = await response.json() as { replayed: number; failed: number; downtimeEndedMs: number };
      expect(payload.replayed).toBe(2);
      expect(payload.failed).toBe(1);
      // Only dl-1's ~60s counts — dl-2 errored, dl-3 has no failure clock.
      expect(payload.downtimeEndedMs).toBeGreaterThanOrEqual(60_000);
      expect(payload.downtimeEndedMs).toBeLessThan(90_000);
    } finally {
      await close(server);
    }
  });

  it("downtimeEndedMs is 0 (not absent/NaN) when every member fails", async () => {
    editorAuth();
    getDeadLetterMock.mockResolvedValueOnce(null as never);

    const server = createApiServer({ routes: dlqRoutes });
    const baseUrl = await listen(server);
    try {
      const response = await applyCluster(baseUrl, ["dl-1"]);
      expect(response.status).toBe(200);
      const payload = await response.json() as { replayed: number; downtimeEndedMs: number };
      expect(payload.replayed).toBe(0);
      expect(payload.downtimeEndedMs).toBe(0);
    } finally {
      await close(server);
    }
  });
});
