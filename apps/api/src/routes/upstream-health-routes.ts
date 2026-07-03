/**
 * Upstream health source routes — operator CRUD over the
 * `upstream_health_sources` table plus an immediate "Check now" poll.
 *
 * Five routes:
 *   - `GET    /upstream/sources`          (viewer, upstream.read)  — list
 *   - `POST   /upstream/sources`          (admin,  upstream.write) — create
 *   - `POST   /upstream/sources/:id`      (admin,  upstream.write) — update (POST-as-update)
 *   - `DELETE /upstream/sources/:id`      (admin,  upstream.write) — delete
 *   - `POST   /upstream/sources/:id/check`(admin,  upstream.write) — poll once now
 *
 * `POST /upstream/sources/:id` is the update verb — the codebase's `Route.method`
 * enum is closed to GET/POST/DELETE, so we follow the `/mcp/connections/:alias`
 * and `/alerts/policies/:id` POST-as-update convention.
 *
 * The background poll (auto-pause / resume) runs in the worker via the
 * `system:upstream-health-poll` scheduler; these routes only manage the source
 * config and let an admin trigger an immediate poll. Multi-tenant scope: every
 * query carries `eq(<table>.orgId, auth.orgId)` inside the repo.
 */

import {
  UpsertUpstreamHealthSourceBodySchema,
} from "@janusly/shared";
import {
  createUpstreamHealthSource,
  deleteUpstreamHealthSource,
  findUpstreamHealthSourceByName,
  getUpstreamHealthSourceById,
  listUpstreamHealthSources,
  updateUpstreamHealthSource,
} from "@janusly/data";
import { pollOneSource } from "@janusly/engine/src/upstream-health-poller";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import type { Route } from "../routes";

/** Match `/upstream/sources/<id>` (no trailing segment). */
function matchSourceById(url: string): boolean {
  if (!url.startsWith("/upstream/sources/")) return false;
  const rest = url.slice("/upstream/sources/".length).split("?")[0];
  const segments = rest.split("/");
  return segments.length === 1 && segments[0].length > 0;
}

/** Match `/upstream/sources/<id>/check`. */
function matchSourceCheck(url: string): boolean {
  if (!url.startsWith("/upstream/sources/")) return false;
  const rest = url.slice("/upstream/sources/".length).split("?")[0];
  const segments = rest.split("/");
  return segments.length === 2 && segments[1] === "check" && segments[0].length > 0;
}

function sourceIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith("/upstream/sources/")) return null;
  const segments = path.slice("/upstream/sources/".length).split("/");
  return segments[0] || null;
}

function invalidBody(
  res: Parameters<Route["handler"]>[0]["res"],
  issues: readonly { path: PropertyKey[]; message: string }[],
) {
  return sendJson(
    res,
    {
      error: "invalid upstream health source body",
      code: "upstream_source_invalid",
      issues: issues.map((iss) => ({ path: iss.path.map(String).join("."), message: iss.message })),
    },
    422,
  );
}

export const upstreamHealthRoutes: Route[] = [
  // Check-now MUST come before the bare `/upstream/sources/:id` matcher so the
  // first-match-wins dispatcher doesn't treat "check" as an id.
  {
    method: "POST",
    match: matchSourceCheck,
    role: "admin",
    permission: "upstream.write",
    handler: async ({ req, res, auth }) => {
      const id = sourceIdFromUrl(req.url);
      if (!id) return sendError(res, "upstream_source_id_required", "source id required", 400);
      const source = await getUpstreamHealthSourceById(auth.orgId, id);
      if (!source) {
        return sendError(res, "upstream_source_not_found", "Upstream source not found", 404);
      }
      // Immediate poll. `pollOneSource` never throws — fetch errors fail open.
      const result = await pollOneSource(source);
      const refreshed = await getUpstreamHealthSourceById(auth.orgId, id);
      return sendJson(res, {
        source: refreshed,
        parse: result.parse,
        pausedWorkflowIds: result.pausedWorkflowIds,
        resumedWorkflowIds: result.resumedWorkflowIds,
        failedOpen: result.failedOpen,
      });
    },
  },
  {
    method: "GET",
    match: (url) => url === "/upstream/sources" || url.startsWith("/upstream/sources?"),
    role: "viewer",
    permission: "upstream.read",
    handler: async ({ res, auth }) => {
      const sources = await listUpstreamHealthSources(auth.orgId);
      return sendJson(res, { sources });
    },
  },
  {
    method: "POST",
    match: (url) => url === "/upstream/sources" || url.startsWith("/upstream/sources?"),
    role: "admin",
    permission: "upstream.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = UpsertUpstreamHealthSourceBodySchema.safeParse(body);
      if (!parsed.success) return invalidBody(res, parsed.error.issues);

      // Reject duplicate name up-front for a clean 409 instead of a raw 23505.
      const existing = await findUpstreamHealthSourceByName(auth.orgId, parsed.data.source.name);
      if (existing) {
        return sendError(res, "upstream_source_duplicate", "An upstream source with that name already exists", 409, { name: parsed.data.source.name });
      }

      const source = await createUpstreamHealthSource(auth.orgId, {
        ...parsed.data.source,
        createdBy: auth.userId,
      });
      await auditAction(auth, "upstream_health.source.created", {
        targetType: "upstream_health_source",
        targetId: source.id,
        metadata: { name: source.name, kind: source.kind, expectedComponents: source.expectedComponents, enabled: source.enabled },
      });
      return sendJson(res, { source }, 201);
    },
  },
  {
    method: "POST",
    match: matchSourceById,
    role: "admin",
    permission: "upstream.write",
    handler: async ({ req, res, auth }) => {
      const id = sourceIdFromUrl(req.url);
      if (!id) return sendError(res, "upstream_source_id_required", "source id required", 400);

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = UpsertUpstreamHealthSourceBodySchema.safeParse(body);
      if (!parsed.success) return invalidBody(res, parsed.error.issues);

      // If the name is changing, guard the unique index for a clean 409.
      const renaming = await findUpstreamHealthSourceByName(auth.orgId, parsed.data.source.name);
      if (renaming && renaming.id !== id) {
        return sendError(res, "upstream_source_duplicate", "An upstream source with that name already exists", 409, { name: parsed.data.source.name });
      }

      const updated = await updateUpstreamHealthSource(auth.orgId, id, parsed.data.source);
      if (!updated) {
        return sendError(res, "upstream_source_not_found", "Upstream source not found", 404);
      }
      await auditAction(auth, "upstream_health.source.updated", {
        targetType: "upstream_health_source",
        targetId: id,
        metadata: { before: updated.before, after: updated.after },
      });
      return sendJson(res, { source: updated.after });
    },
  },
  {
    method: "DELETE",
    match: matchSourceById,
    role: "admin",
    permission: "upstream.write",
    handler: async ({ req, res, auth }) => {
      const id = sourceIdFromUrl(req.url);
      if (!id) return sendError(res, "upstream_source_id_required", "source id required", 400);
      const deleted = await deleteUpstreamHealthSource(auth.orgId, id);
      if (!deleted) {
        return sendError(res, "upstream_source_not_found", "Upstream source not found", 404);
      }
      await auditAction(auth, "upstream_health.source.deleted", {
        targetType: "upstream_health_source",
        targetId: id,
        metadata: { name: deleted.name, kind: deleted.kind },
      });
      return sendJson(res, { ok: true, id });
    },
  },
];
