/**
 * Per-tenant runtime configuration. GET reads the merged catalog
 * (defaults + env fallbacks + tenant overrides); POST upserts one
 * tenant override after the closed-catalog validator accepts it.
 *
 * Admin role on POST so non-admins can't change provider / model /
 * rate-limit posture for their org.
 */

import {
  listOrgConfig,
  upsertOrgConfig,
  getOrgConfigSnapshot,
} from "@janusly/data";
import {
  cancelPendingMemoryPurge,
  schedulePendingMemoryPurge,
} from "@janusly/engine/src/memory-purge-scheduler";
import { summarizeOperatorGuidance } from "@janusly/shared";

import { auditAction } from "../audit-helper";
import { publishCacheInvalidation } from "../cache-invalidation-bus";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
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
      if (!key) return sendError(res, "org_key_required", "key is required", 400);
      if (!Object.hasOwn(body, "value")) return sendError(res, "org_value_required", "value is required", 400);

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
        publishCacheInvalidation({ kind: "org-config", orgId: auth.orgId });
        const configAuditMetadata = key === "ai.operatorGuidance"
          ? { key, ...summarizeOperatorGuidance(entry.value) }
          : { key, value: entry.value };
        await auditAction(auth, "org.config.updated", { targetType: "org_config", targetId: key, metadata: configAuditMetadata });
        if (AI_BUDGET_CONFIG_KEYS.has(key)) {
          try {
            await auditAction(auth, "billing.budget.configured", { targetType: "org_config", targetId: key, metadata: {
              scope: "org",
              key,
              value: entry.value,
            } });
          } catch (err) {
            console.warn("[org-config] budget audit write failed", err);
          }
        }
        if (key === "memory.enabled" && typeof entry.value === "boolean" && previousMemoryEnabled !== null) {
          const newValue = entry.value;
          if (previousMemoryEnabled === false && newValue === true) {
            // Re-grant path. We try to cancel any pending bulk-purge
            // job BEFORE writing the granted audit so we can include
            // the cancellation result in the audit metadata —
            // operators reading the audit log see "consent re-granted
            // + cancelled a pending purge" in one row. The cancel
            // helper never throws; a Redis blip results in
            // `pendingPurgeCancelled: false` which is fine because
            // the purge handler re-checks `memory.enabled` at fire
            // time and skips the actual purge anyway (defense in
            // depth — safety lives in the handler).
            const pendingPurgeCancelled = await cancelPendingMemoryPurge({
              orgId: auth.orgId,
            });
            try {
              await auditAction(auth, "memory.consent.granted", { targetType: "org_config", targetId: key, metadata: {
                previousValue: previousMemoryEnabled,
                newValue,
                pendingPurgeCancelled,
              } });
            } catch (err) {
              console.warn("[org-config] memory consent audit write failed", err);
            }
          } else if (previousMemoryEnabled === true && newValue === false) {
            try {
              await auditAction(auth, "memory.consent.revoked", { targetType: "org_config", targetId: key, metadata: {
                previousValue: previousMemoryEnabled,
                newValue,
              } });
            } catch (err) {
              console.warn("[org-config] memory consent audit write failed", err);
            }
            // Schedule the 7-day bulk purge AFTER the revoke audit so
            // an audit-log reader sees the consent flip first. The
            // helper is bounded + never throws, so awaiting it closes
            // the crash-before-enqueue gap without letting a Redis
            // outage break the config response.
            const pendingPurgeScheduled = await schedulePendingMemoryPurge({ orgId: auth.orgId });
            if (!pendingPurgeScheduled) {
              console.warn("[org-config] pending memory purge was not scheduled", { orgId: auth.orgId });
            }
          }
        }
        return sendJson(res, entry);
      } catch (error) {
        return sendError(res, "org_config_invalid", error instanceof Error ? error.message : "Invalid org config", 400);
      }
    } },
];
