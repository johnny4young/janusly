/**
 * Per-tenant runtime configuration. GET reads the merged catalog
 * (defaults + env fallbacks + tenant overrides); POST upserts one
 * tenant override after the closed-catalog validator accepts it.
 *
 * Admin role on POST so non-admins can't change provider / model /
 * rate-limit posture for their org.
 */

import { listOrgConfig, upsertOrgConfig, getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";

import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import type { Route } from "../routes";

const AI_BUDGET_CONFIG_KEYS = new Set([
  "ai.budgetMonthlyUsd",
  "ai.budgetWarnPercent",
  "ai.budgetExceededPolicy",
]);

export const orgRoutes: Route[] = [
  { method: "GET", match: "/org/config",
    handler: async ({ res, auth }) => sendJson(res, { config: await listOrgConfig(auth.orgId) }) },
  { method: "POST", match: "/org/config", role: "admin", permission: "org.config.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const key = typeof body.key === "string" ? body.key : "";
      if (!key) return sendJson(res, { error: "key is required" }, 400);
      if (!Object.hasOwn(body, "value")) return sendJson(res, { error: "value is required" }, 400);

      // Capture the previous value of `memory.enabled` BEFORE the
      // upsert so we can detect a true/false flip and emit the
      // dedicated consent audit row alongside the generic update.
      // The memory policy requires a stable
      // `memory.consent.granted` / `memory.consent.revoked` action
      // (not just `org.config.updated`) so audit-log readers can
      // filter the consent timeline cleanly.
      let previousMemoryEnabled: boolean | null = null;
      if (key === "memory.enabled") {
        try {
          const snapshot = await getOrgConfigSnapshot(auth.orgId);
          previousMemoryEnabled = snapshot.memory.enabled;
        } catch (err) {
          console.warn("[org-config] failed to read previous memory.enabled", err);
        }
      }

      try {
        const entry = await upsertOrgConfig({ orgId: auth.orgId, key, value: body.value, userId: auth.userId });
        await audit(auth.orgId, auth.userId, "org.config.updated", "org_config", key, { key, value: entry.value });
        if (AI_BUDGET_CONFIG_KEYS.has(key)) {
          try {
            await audit(auth.orgId, auth.userId, "billing.budget.configured", "org_config", key, {
              scope: "org",
              key,
              value: entry.value,
            });
          } catch (err) {
            console.warn("[org-config] budget audit write failed", err);
          }
        }
        if (key === "memory.enabled" && typeof entry.value === "boolean" && previousMemoryEnabled !== null) {
          const newValue = entry.value;
          if (previousMemoryEnabled === false && newValue === true) {
            try {
              await audit(auth.orgId, auth.userId, "memory.consent.granted", "org_config", key, {
                previousValue: previousMemoryEnabled,
                newValue,
              });
            } catch (err) {
              console.warn("[org-config] memory consent audit write failed", err);
            }
          } else if (previousMemoryEnabled === true && newValue === false) {
            try {
              await audit(auth.orgId, auth.userId, "memory.consent.revoked", "org_config", key, {
                previousValue: previousMemoryEnabled,
                newValue,
              });
            } catch (err) {
              console.warn("[org-config] memory consent audit write failed", err);
            }
          }
        }
        return sendJson(res, entry);
      } catch (error) {
        return sendJson(res, { error: error instanceof Error ? error.message : "Invalid org config" }, 400);
      }
    } },
];
