/**
 * Audit-log read surface — the operator-facing trail viewer.
 *
 * `GET /audit?action=&cursor=&limit=` returns one keyset page of the org's
 * audit rows, newest-first: optional `action` PREFIX filter, `(createdAt,id)`
 * cursor pagination (so an operator can page back through history, not just
 * the latest window), capped at `AUDIT_LOG_PAGE_MAX` (default `AUDIT_PAGE_SIZE`).
 *
 * Admin-gated: the org-wide audit trail is a compliance surface, so it is
 * `role: "admin"` (not viewer-or-above). Multi-tenant scope lives in
 * `queryAuditLogs` (`eq(orgId)`).
 */

import { AUDIT_LOG_PAGE_MAX, queryAuditLogs } from "@janusly/data";

import { AUDIT_PAGE_SIZE } from "../api-config";
import { sendJson } from "../http";
import { parseEventsCursor, parseEventsLimit } from "../run-pagination";
import type { Route } from "../routes";

export const auditRoutes: Route[] = [
  {
    method: "GET",
    match: (url) => url.startsWith("/audit"),
    role: "admin",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limit = parseEventsLimit(url.searchParams.get("limit"), AUDIT_PAGE_SIZE, AUDIT_LOG_PAGE_MAX);
      const action = url.searchParams.get("action");
      const cursor = parseEventsCursor(url.searchParams.get("cursor"));
      const page = await queryAuditLogs(auth.orgId, { action, cursor, limit });
      return sendJson(res, page);
    },
  },
];
