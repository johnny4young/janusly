/**
 * `GET /ai/health` — read-only AI provider status probe.
 *
 * No LLM call and no mutation, so the AI-fallback + audit contract that
 * governs the other `/ai/*` surfaces does not apply here: it just reports
 * the org's resolved provider posture via `aiStatus`.
 */
import { aiStatus } from "../ai-runtime";
import { sendJson } from "../http";
import type { Route } from "../routes";

export const aiHealthRoutes: Route[] = [
  { method: "GET", match: "/ai/health",
    handler: async ({ res, auth }) => sendJson(res, await aiStatus(auth.orgId)) },
];
