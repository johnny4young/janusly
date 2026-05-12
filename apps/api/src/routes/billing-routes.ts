/**
 * Usage reporting. Default response is the existing flat
 * `Record<metric, quantity>` for back-compat. When the caller passes
 * `?breakdown=provider,model,mode,day,node,workflow` (any combination
 * of the closed-enum dimensions), the response also includes a
 * `breakdown` array of per-bucket aggregates (token totals, call count,
 * fallback count, costUsd, latency p50/p95/avg). Both paths read the
 * same bounded 30-day / 10k-row slice — the unbounded-scan invariant
 * stays intact.
 */

import {
  DEFAULT_USAGE_WINDOW_DAYS,
  getUsageBreakdown,
  getUsageSummary,
  isUsageBreakdownDimension,
  type UsageBreakdownDimension,
} from "@janusly/engine/src/billing";

import { sendJson } from "../http";
import type { Route } from "../routes";

export const billingRoutes: Route[] = [
  { method: "GET", match: (url) => url === "/billing/usage" || url.startsWith("/billing/usage?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const raw = url.searchParams.get("breakdown");
      const tokens = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const dimensions: UsageBreakdownDimension[] = [];
      for (const token of tokens) {
        if (!isUsageBreakdownDimension(token)) {
          return sendJson(res, { error: `Unknown breakdown dimension: ${token}` }, 400);
        }
        if (!dimensions.includes(token)) dimensions.push(token);
      }
      const summary = await getUsageSummary(auth.orgId);
      if (dimensions.length === 0) {
        return sendJson(res, summary);
      }
      const breakdown = await getUsageBreakdown(auth.orgId, dimensions);
      return sendJson(res, { summary, breakdown, windowDays: DEFAULT_USAGE_WINDOW_DAYS });
    } },
];
