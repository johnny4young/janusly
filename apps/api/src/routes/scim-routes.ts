/**
 * SCIM routes — admin CRUD for `scim_directories` and the inbound
 * webhook receiver for WorkOS Directory Sync events.
 *
 * Admin CRUD shape mirrors `sso-routes.ts`. The webhook receiver:
 *   1. Reads the raw request body (NOT JSON.parse'd — HMAC needs the
 *      exact bytes).
 *   2. Verifies `WorkOS-Signature` via `verifyWorkOsWebhookSignature`.
 *      Missing / malformed / expired / mismatched → 401 with an audit row.
 *   3. JSON.parse the body. Malformed → 400.
 *   4. Resolve the org via `getScimDirectoryByProviderDirectoryId` (the
 *      org-binding seam — never trust an upstream payload's tenant id).
 *   5. Dispatch to `handleScimEvent`, which runs the 3 idempotency /
 *      safety guards in deterministic order before applying state.
 *
 * The route ALWAYS 200s on signature-pass + parseable JSON, regardless
 * of the handler's guard outcome — WorkOS retries on non-2xx for hours,
 * and we don't want a replayed / out-of-order / resurrection-blocked
 * event to trigger more retries. Real I/O failures still bubble up to
 * 5xx so WorkOS retries those.
 *
 * Multi-tenant scope: admin routes use `auth.orgId`; the webhook
 * derives `orgId` from the matched `scim_directories` row (the only
 * un-scoped DB read in this module, by design).
 */

import { audit } from "../audit";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, readRawBody, sendJson } from "../http";
import {
  createScimDirectory,
  getScimDirectoryById,
  getScimDirectoryByOrgId,
  getScimDirectoryByProviderDirectoryId,
  listScimDirectories,
  recordScimDirectorySync,
  revokeScimDirectory,
  updateScimDirectory,
  type ScimDefaultRole,
  getScimUserState,
  markScimUserInactive,
  upsertScimUserState,
  deleteScimGroupState,
  getScimGroupState,
  upsertScimGroupState,
  deleteProcessedEvent,
  recordProcessedEvent,
  deleteMembership,
  upsertMembershipByEmail,
  getAuthPolicyConfig,
} from "@janusly/data";

import { handleScimEvent, type ScimEvent } from "../scim-event-handler";
import type { Route } from "../routes";
import { verifyWorkOsWebhookSignature } from "../workos-webhook";

const VALID_DEFAULT_ROLES: readonly ScimDefaultRole[] = ["viewer", "editor", "admin"];

function isDefaultRole(v: unknown): v is ScimDefaultRole {
  return typeof v === "string" && (VALID_DEFAULT_ROLES as readonly string[]).includes(v);
}

export const scimRoutes: Route[] = [
  // === Admin CRUD on scim_directories ===
  {
    method: "GET",
    match: "/org/scim/directories",
    role: "viewer",
    handler: async ({ res, auth }) => {
      const rows = await listScimDirectories(auth.orgId);
      return sendJson(res, rows);
    },
  },
  {
    method: "POST",
    match: "/org/scim/directories",
    role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const providerDirectoryId = typeof body.providerDirectoryId === "string"
        ? body.providerDirectoryId.trim()
        : "";
      if (!providerDirectoryId) {
        return sendJson(res, { error: "providerDirectoryId is required (e.g. directory_…)" }, 400);
      }
      const defaultRole: ScimDefaultRole = isDefaultRole(body.defaultRole) ? body.defaultRole : "viewer";
      const directoryType = typeof body.directoryType === "string" && body.directoryType.length > 0
        ? body.directoryType
        : undefined;

      const existing = await getScimDirectoryByOrgId(auth.orgId);
      if (existing) {
        return sendJson(res, { error: "SCIM directory already attached for this org" }, 409);
      }
      const row = await createScimDirectory({
        orgId: auth.orgId,
        providerDirectoryId,
        directoryType,
        defaultRole,
      });
      await auditAction(auth, "org.scim.directory_attached", { targetType: "scim_directory", targetId: row.id, metadata: {
        providerDirectoryId,
        directoryType: directoryType ?? null,
        defaultRole,
      } });
      return sendJson(res, row);
    },
  },
  {
    method: "POST",
    match: (url) => /^\/org\/scim\/directories\/[^/]+$/.test(url),
    role: "admin",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/org\/scim\/directories\/([^/?]+)/);
      const id = match?.[1];
      if (!id) return sendJson(res, { error: "directory id is required" }, 400);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const updates: { defaultRole?: ScimDefaultRole } = {};
      if (body.defaultRole !== undefined) {
        if (!isDefaultRole(body.defaultRole)) {
          return sendJson(res, { error: "defaultRole must be viewer | editor | admin" }, 400);
        }
        updates.defaultRole = body.defaultRole;
      }
      if (body.status !== undefined) {
        return sendJson(res, { error: "use DELETE /org/scim/directories/:id to revoke a directory" }, 400);
      }
      if (updates.defaultRole === undefined) {
        return sendJson(res, { error: "no updatable fields provided" }, 400);
      }
      const existing = await getScimDirectoryById({ id, orgId: auth.orgId });
      if (!existing) return sendJson(res, { error: "SCIM directory not found" }, 404);
      const updated = await updateScimDirectory({ id, orgId: auth.orgId, ...updates });
      await auditAction(auth, "org.scim.directory_updated", { targetType: "scim_directory", targetId: id, metadata: updates });
      return sendJson(res, updated);
    },
  },
  {
    method: "DELETE",
    match: (url) => /^\/org\/scim\/directories\/[^/]+$/.test(url),
    role: "admin",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/org\/scim\/directories\/([^/?]+)/);
      const id = match?.[1];
      if (!id) return sendJson(res, { error: "directory id is required" }, 400);
      const existing = await getScimDirectoryById({ id, orgId: auth.orgId });
      if (!existing) return sendJson(res, { error: "SCIM directory not found" }, 404);
      await revokeScimDirectory({ id, orgId: auth.orgId });
      await auditAction(auth, "org.scim.directory_revoked", { targetType: "scim_directory", targetId: id });
      return sendJson(res, { ok: true });
    },
  },

  // === Webhook receiver ===
  {
    method: "POST",
    match: "/webhooks/workos/directory",
    skipAuth: true,
    handler: async ({ req, res }) => {
      const secret = process.env.WORKOS_WEBHOOK_SECRET || "";
      const rawBody = await readRawBody(req, MAX_JSON_BODY_BYTES);
      const headerValue = req.headers["workos-signature"];
      const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;

      const verification = verifyWorkOsWebhookSignature({
        header: header ?? null,
        rawBody,
        secret,
      });
      if (!verification.valid) {
        // No org context yet — audit against "default" tenant for forensics.
        await audit("default", "scim:webhook", "scim.webhook.signature_invalid", "scim_event", "", {
          reason: verification.reason,
        });
        return sendJson(res, { error: "invalid signature" }, 401);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return sendJson(res, { error: "invalid JSON" }, 400);
      }

      const event = asScimEvent(parsed);
      if (!event) {
        return sendJson(res, { error: "invalid event payload" }, 400);
      }

      const directoryId = extractDirectoryId(event);
      if (!directoryId) {
        await audit("default", "scim:webhook", "scim.webhook.missing_directory_id", "scim_event", event.id, {
          eventType: event.event,
        });
        return sendJson(res, { ok: true, processed: false, reason: "missing_directory_id" });
      }

      const scimDirectory = await getScimDirectoryByProviderDirectoryId(directoryId);
      if (!scimDirectory) {
        // Unknown directory — audit against "default" and 200 so WorkOS
        // stops retrying. The directory might have been disconnected
        // here while WorkOS still had pending retries.
        await audit("default", "scim:webhook", "scim.webhook.unknown_directory", "scim_event", event.id, {
          eventType: event.event,
          directoryId,
        });
        return sendJson(res, { ok: true, processed: false, reason: "unknown_directory" });
      }

      if (scimDirectory.status === "revoked") {
        await audit(scimDirectory.orgId, "scim:webhook", "scim.webhook.directory_revoked", "scim_event", event.id, {
          eventType: event.event,
          scimDirectoryId: scimDirectory.id,
        });
        return sendJson(res, { ok: true, processed: false, reason: "directory_revoked" });
      }

      const result = await handleScimEvent({
        event,
        scimDirectory,
        deps: {
          upsertScimUserState,
          getScimUserState,
          markScimUserInactive,
          upsertScimGroupState,
          deleteScimGroupState,
          getScimGroupState,
          recordProcessedEvent,
          deleteProcessedEvent,
          upsertMembershipByEmail,
          deleteMembership,
          getAuthPolicyConfig,
          audit,
          recordScimDirectorySync,
        },
      });

      return sendJson(res, { ok: true, ...result });
    },
  },
];

/* ------------------------------ helpers ---------------------------------- */

function asScimEvent(parsed: unknown): ScimEvent | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return null;
  if (typeof o.event !== "string" || o.event.length === 0) return null;
  if (typeof o.created_at !== "string" || o.created_at.length === 0) return null;
  const data = o.data;
  if (!data || typeof data !== "object") return null;
  return { id: o.id, event: o.event, created_at: o.created_at, data: data as Record<string, unknown> };
}

function extractDirectoryId(event: ScimEvent): string | null {
  const direct = typeof event.data.directory_id === "string" ? event.data.directory_id : null;
  if (direct) return direct;
  // Group user_added/user_removed events sometimes nest the directory id
  // under `data.directory.id`. Be defensive.
  const directory = event.data.directory;
  if (directory && typeof directory === "object") {
    const d = directory as Record<string, unknown>;
    if (typeof d.id === "string" && d.id.length > 0) return d.id;
  }
  return null;
}
