/**
 * Recovery alerting policy CRUD + recent-dispatch feed.
 *
 * Five routes registered into the global `routes: Route[]` registry:
 *
 *   - `POST /alerts/policies`       — create   (admin, `alerts.write`)
 *   - `GET  /alerts/policies`       — list     (viewer, `alerts.read`)
 *   - `GET  /alerts/recent`         — recent dispatches feed (viewer, `alerts.read`)
 *   - `POST /alerts/policies/:id`   — update   (admin, `alerts.write`)
 *   - `DELETE /alerts/policies/:id` — delete   (admin, `alerts.write`)
 *
 * Body validation runs through `AlertPolicyConfigSchema` from
 * `@janusly/shared` then `validateAlertPolicyConfig` for the per-trigger /
 * per-channel refinement. 422 responses carry the structured error list.
 *
 * Multi-tenant scope is enforced by the repos. The `limiter.degraded`
 * trigger only makes sense on `orgId: "system"`, which normal auth modes
 * don't reach.
 */

import {
  AlertPolicyConfigSchema,
  validateAlertPolicyConfig,
} from "@janusly/shared";
import {
  createAlertPolicy,
  deleteAlertPolicy,
  getAlertPolicyById,
  listAlertPolicies,
  updateAlertPolicy,
  RECENT_DISPATCHES_DEFAULT_LIMIT,
  RECENT_DISPATCHES_MAX_LIMIT,
  listRecentDispatches,
} from "@janusly/data";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import type { Route } from "../routes";

function idFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const match = /^\/alerts\/policies\/([^/?]+)/.exec(url);
  return match ? match[1] : null;
}

function isSystemOnlyTriggerAllowed(orgId: string, trigger: string): boolean {
  return trigger !== "limiter.degraded" || orgId === "system";
}

export const alertsRoutes: Route[] = [
  {
    method: "GET",
    match: "/alerts/policies",
    role: "viewer",
    permission: "alerts.read",
    handler: async ({ res, auth }) => {
      const policies = await listAlertPolicies(auth.orgId);
      return sendJson(res, { policies });
    },
  },
  {
    method: "GET",
    match: (url) => url === "/alerts/recent" || url.startsWith("/alerts/recent?"),
    role: "viewer",
    permission: "alerts.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "/alerts/recent", "http://internal");
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam
        ? Math.min(
            Math.max(1, Number.parseInt(limitParam, 10) || RECENT_DISPATCHES_DEFAULT_LIMIT),
            RECENT_DISPATCHES_MAX_LIMIT,
          )
        : RECENT_DISPATCHES_DEFAULT_LIMIT;
      const cursorIso = url.searchParams.get("cursor") ?? undefined;
      const result = await listRecentDispatches({ orgId: auth.orgId, limit, cursorIso });
      return sendJson(res, result);
    },
  },
  {
    method: "POST",
    match: "/alerts/policies",
    role: "admin",
    permission: "alerts.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = AlertPolicyConfigSchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(
          res,
          {
            error: "invalid alert policy body",
            code: "alert_policy_invalid",
            issues: parsed.error.issues.map((iss) => ({
              path: iss.path.join("."),
              message: iss.message,
            })),
          },
          422,
        );
      }
      const refinement = validateAlertPolicyConfig(parsed.data);
      if (!refinement.ok) {
        return sendJson(
          res,
          {
            error: "alert policy refinement failed",
            code: "alert_policy_invalid",
            errors: refinement.errors,
          },
          422,
        );
      }
      if (!isSystemOnlyTriggerAllowed(auth.orgId, refinement.policy.trigger)) {
        return sendJson(
          res,
          {
            error: "alert trigger is only available to the system org",
            code: "alert_policy_system_trigger_only",
          },
          422,
        );
      }
      const policy = await createAlertPolicy(auth.orgId, {
        ...refinement.policy,
        createdBy: auth.userId,
      });
      await auditAction(auth, "alert.policy.created", { targetType: "alert-policy", targetId: policy.id, metadata: {
        name: policy.name,
        trigger: policy.trigger,
        cooldownSeconds: policy.cooldownSeconds,
        enabled: policy.enabled,
        channelCount: policy.channels.length,
      } });
      return sendJson(res, { policy });
    },
  },
  {
    method: "POST",
    match: (url) => /^\/alerts\/policies\/[^/]+$/.test(url),
    role: "admin",
    permission: "alerts.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url);
      if (!id) return sendJson(res, { error: "policy id required" }, 400);
      const existing = await getAlertPolicyById(auth.orgId, id);
      if (!existing) {
        return sendJson(res, { error: "policy not found", code: "alert_policy_not_found" }, 404);
      }

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const merged = {
        name: typeof body.name === "string" ? body.name : existing.name,
        trigger: typeof body.trigger === "string" ? body.trigger : existing.trigger,
        parameters: body.parameters !== undefined ? body.parameters : existing.parameters,
        channels: body.channels !== undefined ? body.channels : existing.channels,
        cooldownSeconds:
          typeof body.cooldownSeconds === "number" ? body.cooldownSeconds : existing.cooldownSeconds,
        enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
      };
      const parsed = AlertPolicyConfigSchema.safeParse(merged);
      if (!parsed.success) {
        return sendJson(
          res,
          {
            error: "invalid alert policy body",
            code: "alert_policy_invalid",
            issues: parsed.error.issues.map((iss) => ({
              path: iss.path.join("."),
              message: iss.message,
            })),
          },
          422,
        );
      }
      const refinement = validateAlertPolicyConfig(parsed.data);
      if (!refinement.ok) {
        return sendJson(
          res,
          {
            error: "alert policy refinement failed",
            code: "alert_policy_invalid",
            errors: refinement.errors,
          },
          422,
        );
      }
      if (!isSystemOnlyTriggerAllowed(auth.orgId, refinement.policy.trigger)) {
        return sendJson(
          res,
          {
            error: "alert trigger is only available to the system org",
            code: "alert_policy_system_trigger_only",
          },
          422,
        );
      }

      const result = await updateAlertPolicy(auth.orgId, id, refinement.policy);
      if (!result) {
        return sendJson(res, { error: "policy not found", code: "alert_policy_not_found" }, 404);
      }

      await auditAction(auth, "alert.policy.updated", { targetType: "alert-policy", targetId: id, metadata: {
        before: {
          name: result.before.name,
          trigger: result.before.trigger,
          parameters: result.before.parameters,
          channels: result.before.channels,
          cooldownSeconds: result.before.cooldownSeconds,
          enabled: result.before.enabled,
        },
        after: {
          name: result.after.name,
          trigger: result.after.trigger,
          parameters: result.after.parameters,
          channels: result.after.channels,
          cooldownSeconds: result.after.cooldownSeconds,
          enabled: result.after.enabled,
        },
      } });
      return sendJson(res, { policy: result.after });
    },
  },
  {
    method: "DELETE",
    match: (url) => /^\/alerts\/policies\/[^/]+$/.test(url),
    role: "admin",
    permission: "alerts.write",
    handler: async ({ req, res, auth }) => {
      const id = idFromUrl(req.url);
      if (!id) return sendJson(res, { error: "policy id required" }, 400);
      const before = await deleteAlertPolicy(auth.orgId, id);
      if (!before) {
        return sendJson(res, { error: "policy not found", code: "alert_policy_not_found" }, 404);
      }
      await auditAction(auth, "alert.policy.deleted", { targetType: "alert-policy", targetId: id, metadata: {
        name: before.name,
        trigger: before.trigger,
      } });
      return sendJson(res, { ok: true });
    },
  },
];
