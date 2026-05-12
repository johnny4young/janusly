/**
 * Audit-log read surface. Bounded list with `?limit=` opt-in
 * (capped at 200, default 100). Multi-tenant scope on the query.
 */

import { desc, eq } from "drizzle-orm";

import { auditLogs, db } from "@janusly/db";

import { AUDIT_PAGE_SIZE } from "../api-config";
import { sendJson } from "../http";
import type { Route } from "../routes";

export const auditRoutes: Route[] = [
  { method: "GET", match: (url) => url.startsWith("/audit"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 200)
        : AUDIT_PAGE_SIZE;
      const rows = await db.select().from(auditLogs)
        .where(eq(auditLogs.orgId, auth.orgId))
        .orderBy(desc(auditLogs.createdAt))
        .limit(limitValue);
      return sendJson(res, rows);
    } },
];
