/**
 * Route-level tests for the liveness probe + admin rate-limiter snapshot.
 *
 * Covers:
 * - ``GET /health`` returns ``{ ok: true, rateLimiter }`` when healthy
 * - ``GET /health`` carries the degraded block when buckets are failing
 * - Public ``/health`` shape does NOT leak Redis internal error text,
 *   tenant-chosen MCP aliases/tool names, or the bucket key
 *   (``lastObservedKey``)
 * - ``GET /system/rate-limiter`` exposes the admin shape with the full
 *   error string + key for incident triage
 * - ``/system/rate-limiter`` declares ``role: "admin"`` so the dispatcher
 *   gates non-admins; this pin verifies the route entry
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  };
});

import {
  _resetRateLimiterDegradationForTests,
  recordRateLimiterError,
} from "@janusly/data/src/rate-limit-degradation";
import { healthRoutes } from "./health-routes";
import { sendJson } from "../http";
import type { Route } from "../routes";

// The degradation tracker calls into @janusly/db on the first audit
// write. We don't care about the audit row in these tests — stub it.
vi.mock("@janusly/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
      })),
    })),
  },
  auditLogs: {
    id: "id",
    orgId: "org_id",
    action: "action",
    metadata: "metadata",
    createdAt: "created_at",
  },
}));

const sendJsonMock = vi.mocked(sendJson);

function findRoute(method: string, path: string): Route {
  const route = healthRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

async function callRoute(method: string, path: string) {
  const route = findRoute(method, path);
  // The dispatcher gates routes BEFORE calling the handler; routes are
  // therefore tested at the handler level. The admin gate on
  // ``/system/rate-limiter`` is pinned separately by inspecting the
  // route entry's ``role`` field.
  return route.handler({
    req: { url: path } as never,
    res: {} as never,
    auth: { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as never,
  });
}

afterEach(() => {
  _resetRateLimiterDegradationForTests();
  sendJsonMock.mockClear();
});

describe("GET /health", () => {
  it("returns { ok: true, rateLimiter: { healthy: true } } when no buckets degraded", async () => {
    await callRoute("GET", "/health");
    expect(sendJsonMock).toHaveBeenCalledTimes(1);
    const payload = sendJsonMock.mock.calls[0]?.[1] as {
      ok: boolean;
      rateLimiter: { healthy: boolean; degradedBuckets: unknown[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.rateLimiter.healthy).toBe(true);
    expect(payload.rateLimiter.degradedBuckets).toEqual([]);
  });

  it("surfaces the degraded block when a bucket is failing", async () => {
    await recordRateLimiterError("ai", "org-1", new Error("ECONNREFUSED"));
    await callRoute("GET", "/health");
    const payload = sendJsonMock.mock.calls[0]?.[1] as {
      ok: boolean;
      rateLimiter: { healthy: boolean; degradedBuckets: Array<{ bucket: string; errorCount: number }> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.rateLimiter.healthy).toBe(false);
    expect(payload.rateLimiter.degradedBuckets).toHaveLength(1);
    expect(payload.rateLimiter.degradedBuckets[0]).toMatchObject({
      bucket: "ai",
      errorCount: 1,
    });
  });

  it("does NOT leak Redis error text or the bucket key on the public route", async () => {
    await recordRateLimiterError(
      "ai",
      "org-secret-123",
      new Error("connection to internal-redis.cluster.local:6379 refused"),
    );
    await callRoute("GET", "/health");
    const payload = sendJsonMock.mock.calls[0]?.[1] as {
      rateLimiter: { degradedBuckets: Array<Record<string, unknown>> };
    };
    const bucket = payload.rateLimiter.degradedBuckets[0]!;
    expect("lastError" in bucket).toBe(false);
    expect("lastObservedKey" in bucket).toBe(false);
    // The serialized JSON must not contain the leaky strings either —
    // defense in depth against future schema drift.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("internal-redis.cluster.local");
    expect(serialized).not.toContain("org-secret-123");
  });

  it("collapses tenant-chosen MCP aliases and tool names on the public route", async () => {
    await recordRateLimiterError(
      "mcp_client.secret-notion.pages.delete",
      "org-1",
      new Error("connection refused"),
    );
    await callRoute("GET", "/health");
    const payload = sendJsonMock.mock.calls[0]?.[1] as {
      rateLimiter: { degradedBuckets: Array<Record<string, unknown>> };
    };
    expect(payload.rateLimiter.degradedBuckets[0]).toMatchObject({
      bucket: "mcp_client",
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("secret-notion");
    expect(serialized).not.toContain("pages.delete");
  });
});

describe("GET /system/rate-limiter", () => {
  it("returns the admin snapshot including lastError + lastObservedKey", async () => {
    await recordRateLimiterError("ai", "org-1", new Error("ECONNREFUSED"));
    await callRoute("GET", "/system/rate-limiter");
    const payload = sendJsonMock.mock.calls[0]?.[1] as {
      healthy: boolean;
      degradedBuckets: Array<{
        bucket: string;
        lastError: string;
        lastObservedKey: string;
      }>;
    };
    expect(payload.healthy).toBe(false);
    expect(payload.degradedBuckets[0]).toMatchObject({
      bucket: "ai",
      lastError: "ECONNREFUSED",
      lastObservedKey: "org-1",
    });
  });

  it("declares role: admin so the dispatcher gates non-admins", () => {
    const route = findRoute("GET", "/system/rate-limiter");
    expect(route.role).toBe("admin");
  });
});
