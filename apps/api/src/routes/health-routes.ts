/**
 * Liveness probe + infrastructure degradation snapshots.
 *
 * Three routes live here:
 *
 * - ``GET /health`` (open, ``skipAuth: true``) — container / orchestrator
 *   readiness probe. Now carries an additive ``rateLimiter`` block fed by
 *   the in-memory degradation tracker so external probes can flag a
 *   limiter that's failing open. The public shape truncates each degraded
 *   bucket to ``{ bucket, errorCount, firstObservedAt, lastObservedAt }``;
 *   ``bucket`` is a public-safe label, not necessarily the raw internal
 *   bucket name. The open route never leaks Redis internal error text,
 *   tenant-chosen MCP aliases/tool names, or the bucket key (typically
 *   ``orgId``).
 *   The queue block is deliberately coarse: ``{ degraded }`` or ``null``.
 * - ``GET /system/rate-limiter`` (admin) — full snapshot including
 *   per-bucket ``lastError`` + ``lastObservedKey`` for incident triage.
 * - ``GET /system/queue`` (admin) — live waiting/active counts, oldest
 *   waiting age, and the server-owned warning threshold.
 *
 * Invariants:
 * - ``/health`` stays additive — ``body.ok: true`` still anchors any probe
 *   that reads only that field.
 * - Rate-limiter snapshots are process-local. Multi-replica deployments observe
 *   per-replica views; that's intentional v1.
 * - Queue Redis failure returns ``queue: null`` while ``ok`` stays true.
 * - Never add live queue counts or latency to unauthenticated ``/health``.
 */

import { sendJson } from "../http";
import type { Route } from "../routes";
import {
  getRateLimiterAdminHealth,
  getRateLimiterPublicHealth,
} from "@janusly/data";
import { getPublicQueueHealth, getQueueHealthSnapshot } from "../queue-health";

export const healthRoutes: Route[] = [
  {
    method: "GET",
    match: "/health",
    skipAuth: true,
    handler: async ({ res }) => sendJson(res, {
      ok: true,
      rateLimiter: getRateLimiterPublicHealth(),
      queue: await getPublicQueueHealth(),
    }),
  },
  {
    method: "GET",
    match: "/system/rate-limiter",
    role: "admin",
    handler: async ({ res }) => sendJson(res, getRateLimiterAdminHealth()),
  },
  {
    method: "GET",
    match: "/system/queue",
    role: "admin",
    handler: async ({ res }) => sendJson(res, await getQueueHealthSnapshot()),
  },
];
