/**
 * Per-tenant runtime configuration. GET reads the merged catalog
 * (defaults + env fallbacks + tenant overrides); POST upserts one
 * tenant override after the closed-catalog validator accepts it.
 *
 * Admin role on POST so non-admins can't change provider / model /
 * rate-limit posture for their org.
 */

import { listOrgConfig, upsertOrgConfig } from "@janusly/data/src/orgConfigRepo";

import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import type { Route } from "../routes";

export const orgRoutes: Route[] = [
  { method: "GET", match: "/org/config",
    handler: async ({ res, auth }) => sendJson(res, { config: await listOrgConfig(auth.orgId) }) },
  { method: "POST", match: "/org/config", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const key = typeof body.key === "string" ? body.key : "";
      if (!key) return sendJson(res, { error: "key is required" }, 400);
      if (!Object.hasOwn(body, "value")) return sendJson(res, { error: "value is required" }, 400);

      try {
        const entry = await upsertOrgConfig({ orgId: auth.orgId, key, value: body.value, userId: auth.userId });
        await audit(auth.orgId, auth.userId, "org.config.updated", "org_config", key, { key, value: entry.value });
        return sendJson(res, entry);
      } catch (error) {
        return sendJson(res, { error: error instanceof Error ? error.message : "Invalid org config" }, 400);
      }
    } },
];
