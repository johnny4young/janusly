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
import { asRecord, readJson, readRawBody, sendError, sendJson } from "../http";
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
  listActiveScimUserState,
  markScimUserInactive,
  upsertScimUserState,
  deleteScimGroupState,
  getScimGroupState,
  listScimGroupState,
  SCIM_GROUP_STATE_DEFAULT_LIMIT,
  SCIM_GROUP_STATE_MAX_LIMIT,
  upsertScimGroupState,
  deleteProcessedEvent,
  recordProcessedEvent,
  deleteMembership,
  findMemberByEmail,
  upsertMembershipByEmail,
  getAuthPolicyConfig,
  // SCIM v2 group→role mapping
  listScimGroupRoleMappings,
  getScimGroupRoleMappingById,
  findScimGroupRoleMappingByGroup,
  createScimGroupRoleMapping,
  updateScimGroupRoleMapping,
  deleteScimGroupRoleMapping,
  getScimGroupRoleMappingsMap,
  listScimUserGroupIds,
  listScimUserIdsForGroup,
  addScimUserGroup,
  removeScimUserGroup,
  deleteScimUserGroupsForUser,
  deleteScimUserGroupsForGroup,
} from "@janusly/data";

import { handleScimEvent, type ScimEvent } from "../scim-event-handler";
import { resyncScimMemberRoles } from "../scim-resync";
import type { Route } from "../routes";
import { verifyWorkOsWebhookSignature } from "../workos-webhook";

const VALID_DEFAULT_ROLES: readonly ScimDefaultRole[] = ["viewer", "editor", "admin"];

function isDefaultRole(v: unknown): v is ScimDefaultRole {
  return typeof v === "string" && (VALID_DEFAULT_ROLES as readonly string[]).includes(v);
}

function parseScimGroupListLimit(rawUrl: string | undefined): number {
  const url = new URL(rawUrl ?? "", "http://localhost");
  const limitParam = Number(url.searchParams.get("limit"));
  return Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, SCIM_GROUP_STATE_MAX_LIMIT)
    : SCIM_GROUP_STATE_DEFAULT_LIMIT;
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
        return sendError(res, "scim_provider_directory_id_required", "providerDirectoryId is required (e.g. directory_…)", 400);
      }
      const defaultRole: ScimDefaultRole = isDefaultRole(body.defaultRole) ? body.defaultRole : "viewer";
      const directoryType = typeof body.directoryType === "string" && body.directoryType.length > 0
        ? body.directoryType
        : undefined;

      const existing = await getScimDirectoryByOrgId(auth.orgId);
      if (existing) {
        return sendError(res, "scim_directory_already_attached", "SCIM directory already attached for this org", 409);
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
      if (!id) return sendError(res, "scim_directory_id_required", "directory id is required", 400);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const updates: { defaultRole?: ScimDefaultRole } = {};
      if (body.defaultRole !== undefined) {
        if (!isDefaultRole(body.defaultRole)) {
          return sendError(res, "scim_default_role_invalid", "defaultRole must be viewer | editor | admin", 400);
        }
        updates.defaultRole = body.defaultRole;
      }
      if (body.status !== undefined) {
        return sendError(res, "scim_directory_status_immutable", "use DELETE /org/scim/directories/:id to revoke a directory", 400);
      }
      if (updates.defaultRole === undefined) {
        return sendError(res, "scim_no_updatable_fields", "no updatable fields provided", 400);
      }
      const existing = await getScimDirectoryById({ id, orgId: auth.orgId });
      if (!existing) return sendError(res, "scim_directory_not_found", "SCIM directory not found", 404);
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
      if (!id) return sendError(res, "scim_directory_id_required", "directory id is required", 400);
      const existing = await getScimDirectoryById({ id, orgId: auth.orgId });
      if (!existing) return sendError(res, "scim_directory_not_found", "SCIM directory not found", 404);
      await revokeScimDirectory({ id, orgId: auth.orgId });
      await auditAction(auth, "org.scim.directory_revoked", { targetType: "scim_directory", targetId: id });
      return sendJson(res, { ok: true });
    },
  },

  // === Synced groups (read-only; backs the group→role mapping picker) ===
  {
    method: "GET",
    // Predicate (not an exact string) so the optional `?limit=` query is
    // honoured: the dispatcher matches against the raw `req.url` including
    // the query string, so an exact-string match would 404 on `?limit=…`.
    match: (url) => url === "/org/scim/groups" || url.startsWith("/org/scim/groups?"),
    role: "viewer",
    handler: async ({ req, res, auth }) => {
      const directory = await getScimDirectoryByOrgId(auth.orgId);
      if (!directory) return sendJson(res, []);
      const rows = await listScimGroupState(auth.orgId, directory.id, parseScimGroupListLimit(req.url));
      return sendJson(res, rows);
    },
  },

  // === Admin CRUD on scim_group_role_mappings (SCIM v2) ===
  {
    method: "GET",
    match: "/org/scim/group-role-mappings",
    role: "viewer",
    handler: async ({ res, auth }) => {
      const directory = await getScimDirectoryByOrgId(auth.orgId);
      if (!directory) return sendJson(res, []);
      const rows = await listScimGroupRoleMappings(auth.orgId, directory.id);
      return sendJson(res, rows);
    },
  },
  {
    method: "POST",
    match: "/org/scim/group-role-mappings",
    role: "admin",
    handler: async ({ req, res, auth }) => {
      // Read the request body before any await on DB I/O so the stream's
      // data/end events aren't missed (matches the directory POST ordering).
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const directory = await getScimDirectoryByOrgId(auth.orgId);
      if (!directory) {
        return sendError(res, "scim_directory_required_for_mappings", "attach a SCIM directory before configuring group role mappings", 409);
      }
      const providerGroupId = typeof body.providerGroupId === "string" ? body.providerGroupId.trim() : "";
      if (!providerGroupId) {
        return sendError(res, "scim_provider_group_id_required", "providerGroupId is required (e.g. directory_group_…)", 400);
      }
      if (!isDefaultRole(body.role)) {
        return sendError(res, "scim_role_invalid", "role must be viewer | editor | admin", 400);
      }
      const role = body.role;
      // The group must exist in this directory's synced state — guards against
      // typo'd / cross-directory group ids that would silently never match.
      const group = await getScimGroupState({ scimDirectoryId: directory.id, providerGroupId });
      if (!group) {
        return sendError(res, "scim_unknown_provider_group_id", "unknown providerGroupId for this directory", 404);
      }
      const dup = await findScimGroupRoleMappingByGroup({
        orgId: auth.orgId,
        scimDirectoryId: directory.id,
        providerGroupId,
      });
      if (dup) {
        return sendError(res, "scim_group_role_mapping_exists", "a mapping for this group already exists; update it instead", 409);
      }
      const row = await createScimGroupRoleMapping({
        orgId: auth.orgId,
        scimDirectoryId: directory.id,
        providerGroupId,
        role,
        createdBy: auth.userId,
      });
      await auditAction(auth, "org.scim.group_role_mapping_created", {
        targetType: "scim_group_role_mapping",
        targetId: row.id,
        metadata: { providerGroupId, role, scimDirectoryId: directory.id },
      });
      return sendJson(res, row);
    },
  },
  {
    method: "POST",
    match: (url) => /^\/org\/scim\/group-role-mappings\/[^/]+$/.test(url),
    role: "admin",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/org\/scim\/group-role-mappings\/([^/?]+)/);
      const id = match?.[1];
      if (!id) return sendError(res, "scim_mapping_id_required", "mapping id is required", 400);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (!isDefaultRole(body.role)) {
        return sendError(res, "scim_role_invalid", "role must be viewer | editor | admin", 400);
      }
      const role = body.role;
      const existing = await getScimGroupRoleMappingById({ id, orgId: auth.orgId });
      if (!existing) return sendError(res, "scim_group_role_mapping_not_found", "group role mapping not found", 404);
      const updated = await updateScimGroupRoleMapping({ id, orgId: auth.orgId, role, updatedBy: auth.userId });
      if (!updated) return sendError(res, "scim_group_role_mapping_not_found", "group role mapping not found", 404);
      await auditAction(auth, "org.scim.group_role_mapping_updated", {
        targetType: "scim_group_role_mapping",
        targetId: id,
        metadata: {
          providerGroupId: existing.providerGroupId,
          before: existing.role,
          after: role,
          scimDirectoryId: existing.scimDirectoryId,
        },
      });
      return sendJson(res, updated);
    },
  },
  {
    method: "DELETE",
    match: (url) => /^\/org\/scim\/group-role-mappings\/[^/]+$/.test(url),
    role: "admin",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/org\/scim\/group-role-mappings\/([^/?]+)/);
      const id = match?.[1];
      if (!id) return sendError(res, "scim_mapping_id_required", "mapping id is required", 400);
      const existing = await getScimGroupRoleMappingById({ id, orgId: auth.orgId });
      if (!existing) return sendError(res, "scim_group_role_mapping_not_found", "group role mapping not found", 404);
      await deleteScimGroupRoleMapping({ id, orgId: auth.orgId });
      await auditAction(auth, "org.scim.group_role_mapping_deleted", {
        targetType: "scim_group_role_mapping",
        targetId: id,
        metadata: {
          providerGroupId: existing.providerGroupId,
          role: existing.role,
          scimDirectoryId: existing.scimDirectoryId,
        },
      });
      return sendJson(res, { ok: true });
    },
  },

  // === Bulk role re-sync (apply current mappings to every active member) ===
  {
    method: "POST",
    match: "/org/scim/resync",
    role: "admin",
    handler: async ({ res, auth }) => {
      const directory = await getScimDirectoryByOrgId(auth.orgId);
      if (!directory) {
        return sendError(res, "scim_directory_required_for_resync", "attach a SCIM directory before re-syncing roles", 409);
      }
      const result = await resyncScimMemberRoles({
        scimDirectory: directory,
        deps: {
          listActiveScimUserState,
          getScimGroupRoleMappingsMap,
          listScimUserGroupIds,
          findMemberByEmail,
          upsertMembershipByEmail,
        },
      });
      await auditAction(auth, "org.scim.resynced", {
        targetType: "scim_directory",
        targetId: directory.id,
        metadata: {
          membersResynced: result.membersResynced,
          membersChanged: result.membersChanged,
          skipped: result.skipped,
          capped: result.capped,
          scimDirectoryId: directory.id,
        },
      });
      return sendJson(res, result);
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
        return sendError(res, "scim_invalid_signature", "invalid signature", 401);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return sendError(res, "scim_invalid_json", "invalid JSON", 400);
      }

      const event = asScimEvent(parsed);
      if (!event) {
        return sendError(res, "scim_invalid_event_payload", "invalid event payload", 400);
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
          findMemberByEmail,
          deleteMembership,
          getAuthPolicyConfig,
          audit,
          recordScimDirectorySync,
          getScimGroupRoleMappingsMap,
          listScimUserGroupIds,
          listScimUserIdsForGroup,
          addScimUserGroup,
          removeScimUserGroup,
          deleteScimUserGroupsForUser,
          deleteScimUserGroupsForGroup,
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
