/**
 * Liveness probe. Open route — `skipAuth: true`. Used by container
 * orchestrators and the local dev orchestrator's readiness check.
 */

import { sendJson } from "../http";
import type { Route } from "../routes";

export const healthRoutes: Route[] = [
  { method: "GET", match: "/health", skipAuth: true,
    handler: async ({ res }) => sendJson(res, { ok: true }) },
];
