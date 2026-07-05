/**
 * Installed-plugin catalog. The `available` list reuses the tool
 * registry (`listTools()`) until plugin packaging exists; `installed`
 * is the persisted per-org list.
 *
 * Multi-tenant scope on every read; admin role required to install.
 */

import { eq } from "drizzle-orm";

import { db, installedPlugins } from "@janusly/db";
import { listTools } from "@janusly/engine/src/tool-registry";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import type { Route } from "../routes";

export const pluginsRoutes: Route[] = [
  { method: "GET", match: "/plugins",
    handler: async ({ res, auth }) => {
      const installed = await db.select().from(installedPlugins).where(eq(installedPlugins.orgId, auth.orgId));
      return sendJson(res, { available: listTools(), installed });
    } },
  { method: "POST", match: "/plugins/install", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const pluginId = typeof body.pluginId === "string" ? body.pluginId : "";
      if (!pluginId) return sendError(res, "plugins_plugin_id_required", "pluginId is required", 400);
      const id = crypto.randomUUID();
      await db.insert(installedPlugins).values({ id, orgId: auth.orgId, pluginId, configJson: body.config ?? {}, installedBy: auth.userId });
      await auditAction(auth, "plugin.installed", { targetType: "plugin", targetId: pluginId, metadata: (body.config ?? {}) as Record<string, unknown> });
      return sendJson(res, { id });
    } },
];
