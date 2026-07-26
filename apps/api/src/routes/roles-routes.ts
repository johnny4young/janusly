/**
 * Role + permission grants admin CRUD.
 *
 * Surfaces:
 *   - `GET /org/permissions/catalog` (viewer) — the full closed
 *     catalog with descriptions + default-role mappings; the UI
 *     renders its checkbox grid from this.
 *   - `GET /org/roles` (viewer) — every role known to this org
 *     (built-ins with overrides + custom roles), each with its
 *     effective permission set.
 *   - `POST /org/roles` (admin) — create a custom role. Name allowlist
 *     `^[a-z0-9_-]{1,32}$`, never a built-in. `inheritsFrom` closed
 *     enum (defaults to `viewer` — fail-closed). `grantedPermissions`
 *     validated against the catalog.
 *   - `POST /org/roles/:name` (admin) — update permissions or metadata
 *     on a built-in OR custom role. `inheritsFrom` is immutable on
 *     built-ins. Admin built-in saves coerce the mandatory floor
 *     (`org.permissions.write` + `members.write`).
 *   - `DELETE /org/roles/:name` (admin) — delete a custom role.
 *     Built-ins return 400; roles with active members return 409 with
 *     the count.
 *
 * Multi-tenant scope on every read/write. Five audit actions:
 * `org.permissions.override_set`, `org.permissions.override_cleared`,
 * `org.role.created`, `org.role.updated`, `org.role.deleted`.
 */

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { errorEnvelope } from "../error-codes";
import { asRecord, readJson, sendError, sendJson } from "../http";
import {
  countMembersInRole,
  createOrgRole,
  deleteOrgRole,
  getOrgRole,
  listOrgRoles,
  updateOrgRole,
  type OrgRoleRow,
} from "@janusly/data";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  isPermission,
  mandatoryAdminPermissions,
  type Permission,
} from "../permission-catalog";
import { isRole, type Role } from "../permissions";
import type { Route } from "../routes";

const VALID_INHERITS_FROM: readonly Role[] = ["viewer", "editor", "admin"];
const ROLE_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

function isValidRoleName(name: unknown): name is string {
  return typeof name === "string" && ROLE_NAME_PATTERN.test(name);
}

function isInheritsFrom(v: unknown): v is Role {
  return isRole(v);
}

/**
 * Detect Postgres unique-constraint violations (errcode 23505), traversing
 * the Drizzle / pg driver `cause` chain. Used to handle the "two concurrent
 * admin overrides race on the same built-in name" case cleanly.
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: string }).code;
  if (code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) return isUniqueConstraintError(cause);
  return false;
}

function parsePermissionsArray(value: unknown): { ok: true; permissions: Permission[] } | { ok: false; bad: string } {
  if (!Array.isArray(value)) return { ok: false, bad: "grantedPermissions must be an array" };
  const out: Permission[] = [];
  for (const v of value) {
    if (!isPermission(v)) return { ok: false, bad: `unknown permission: ${String(v)}` };
    if (!out.includes(v)) out.push(v);
  }
  return { ok: true, permissions: out };
}

/**
 * Apply the admin floor: when the role being saved is the built-in
 * `admin`, force-include `org.permissions.write` + `members.write`
 * so the admin can't lock themselves out of the role-management
 * surface. Returns the merged set + the list of permissions that
 * were added by the coercion (so the audit row carries it).
 */
function coerceAdminFloor(roleName: string, permissions: Permission[]): { permissions: Permission[]; coerced: Permission[] } {
  if (roleName !== "admin") return { permissions, coerced: [] };
  const required = mandatoryAdminPermissions();
  const coerced: Permission[] = [];
  const merged = [...permissions];
  for (const r of required) {
    if (!merged.includes(r)) {
      merged.push(r);
      coerced.push(r);
    }
  }
  return { permissions: merged, coerced };
}

function effectivePermissionsForRow(row: OrgRoleRow | null, builtinFallback: Role | null): Permission[] {
  if (row && row.grantedPermissions !== null) {
    return row.grantedPermissions.filter(isPermission);
  }
  if (builtinFallback) {
    return Array.from(DEFAULT_ROLE_PERMISSIONS[builtinFallback]);
  }
  return [];
}

type RoleListEntry = {
  name: string;
  isBuiltin: boolean;
  inheritsFrom: Role;
  description: string | null;
  grantedPermissions: Permission[];
  isOverride: boolean;
};

async function buildRoleList(orgId: string): Promise<RoleListEntry[]> {
  const rows = await listOrgRoles(orgId);
  const byName = new Map<string, OrgRoleRow>();
  for (const r of rows) byName.set(r.name, r);

  const out: RoleListEntry[] = [];

  // Built-ins always appear, with or without an override row
  for (const builtin of VALID_INHERITS_FROM) {
    const row = byName.get(builtin) ?? null;
    const grantedPermissions = effectivePermissionsForRow(row, builtin);
    out.push({
      name: builtin,
      isBuiltin: true,
      inheritsFrom: builtin,
      description: row?.description ?? null,
      grantedPermissions,
      isOverride: row !== null && row.grantedPermissions !== null,
    });
    byName.delete(builtin);
  }
  // Custom roles
  for (const row of byName.values()) {
    if (!isRole(row.inheritsFrom)) continue;
    out.push({
      name: row.name,
      isBuiltin: false,
      inheritsFrom: row.inheritsFrom,
      description: row.description,
      grantedPermissions: effectivePermissionsForRow(row, null),
      isOverride: false,
    });
  }
  return out;
}

export const rolesRoutes: Route[] = [
  // === Catalog ===
  {
    method: "GET",
    match: "/org/permissions/catalog",
    role: "viewer",
    permission: "members.read",
    handler: async ({ res }) => {
      return sendJson(res, {
        catalog: PERMISSION_CATALOG.map((e) => ({
          key: e.key,
          category: e.category,
          description: e.description,
          defaultRoles: e.defaultRoles,
        })),
        mandatoryAdminPermissions: mandatoryAdminPermissions(),
      });
    },
  },

  // === Roles list ===
  {
    method: "GET",
    match: "/org/roles",
    role: "viewer",
    permission: "members.read",
    handler: async ({ res, auth }) => {
      const roles = await buildRoleList(auth.orgId);
      return sendJson(res, { roles });
    },
  },

  // === Create custom role ===
  {
    method: "POST",
    match: "/org/roles",
    role: "admin",
    permission: "org.permissions.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
      if (!isValidRoleName(name)) {
        return sendError(res, "roles_name_invalid", "name must match /^[a-z0-9_-]{1,32}$/", 400);
      }
      if (isRole(name)) {
        return sendError(res, "roles_builtin_name", "cannot create a custom role with a built-in name; use POST /org/roles/:name to override a built-in", 400);
      }
      const inheritsFrom: Role = isInheritsFrom(body.inheritsFrom) ? body.inheritsFrom : "viewer";
      const parsed = parsePermissionsArray(body.grantedPermissions);
      if (!parsed.ok) return sendError(res, "roles_permissions_invalid", parsed.bad, 400);

      const existing = await getOrgRole({ orgId: auth.orgId, name });
      if (existing) {
        return sendError(res, "role_already_exists", "role with this name already exists", 409, { name });
      }

      const description = typeof body.description === "string" ? body.description.slice(0, 240) : null;
      const created = await createOrgRole({
        orgId: auth.orgId,
        name,
        inheritsFrom,
        description,
        isBuiltin: false,
        grantedPermissions: parsed.permissions,
        createdBy: auth.userId,
      });
      await auditAction(auth, "org.role.created", { targetType: "org_role", targetId: created.id, metadata: {
        name,
        inheritsFrom,
        grantedPermissions: parsed.permissions,
      } });
      return sendJson(res, created);
    },
  },

  // === Update role (built-in override or custom edit) ===
  {
    method: "POST",
    match: (url) => /^\/org\/roles\/[^/]+$/.test(url),
    role: "admin",
    permission: "org.permissions.write",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/org\/roles\/([^/?]+)/);
      const name = match?.[1] ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
      if (!name) return sendError(res, "roles_name_required", "role name is required", 400);

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const isBuiltinTarget = isRole(name);
      const existing = await getOrgRole({ orgId: auth.orgId, name });

      // Built-ins: row may not exist yet — create one on first override.
      // Custom: row MUST exist.
      if (!isBuiltinTarget && !existing) {
        return sendError(res, "role_not_found", "role not found", 404);
      }

      // Validate `inheritsFrom` — immutable on built-ins
      let inheritsFrom: Role | undefined;
      if (body.inheritsFrom !== undefined) {
        if (isBuiltinTarget) {
          return sendError(res, "roles_inherits_immutable", "inheritsFrom is immutable on built-in roles", 400);
        }
        if (!isInheritsFrom(body.inheritsFrom)) {
          return sendError(res, "roles_inherits_invalid", "inheritsFrom must be one of viewer | editor | admin", 400);
        }
        inheritsFrom = body.inheritsFrom;
      }

      // Validate permissions if supplied
      let permissions: Permission[] | undefined;
      let coercedFloor: Permission[] = [];
      if (body.grantedPermissions !== undefined) {
        const parsed = parsePermissionsArray(body.grantedPermissions);
        if (!parsed.ok) return sendError(res, "roles_permissions_invalid", parsed.bad, 400);
        const floored = coerceAdminFloor(name, parsed.permissions);
        permissions = floored.permissions;
        coercedFloor = floored.coerced;
      }

      const description = body.description !== undefined
        ? (typeof body.description === "string" ? body.description.slice(0, 240) : null)
        : undefined;

      if (permissions === undefined && inheritsFrom === undefined && description === undefined) {
        return sendError(res, "roles_no_updatable_fields", "no updatable fields provided", 400);
      }

      let savedRow: OrgRoleRow | null;
      if (!existing) {
        // First-time built-in override: insert a row with `isBuiltin: true`.
        // Concurrent admin requests can both pass the `!existing` check
        // and race on the unique `(orgId, name)` index; the loser catches
        // the 23505 and falls through to the update path so the admin
        // sees a clean success instead of a 5xx.
        try {
          savedRow = await createOrgRole({
            orgId: auth.orgId,
            name,
            inheritsFrom: name as Role, // built-in inherits from itself
            description: description ?? null,
            isBuiltin: true,
            grantedPermissions: permissions ?? null,
            createdBy: auth.userId,
          });
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            savedRow = await updateOrgRole({
              orgId: auth.orgId,
              name,
              grantedPermissions: permissions,
              description,
              updatedBy: auth.userId,
            });
          } else {
            throw err;
          }
        }
      } else {
        savedRow = await updateOrgRole({
          orgId: auth.orgId,
          name,
          grantedPermissions: permissions,
          description,
          inheritsFrom,
          updatedBy: auth.userId,
        });
      }

      const action = isBuiltinTarget ? "org.permissions.override_set" : "org.role.updated";
      // For custom-role updates that change `inheritsFrom`, capture
      // the previous value too — the rank change affects every member
      // holding that role across all 37 rank-gated routes, and a
      // compliance reviewer reading the log alone shouldn't have to
      // join against earlier `org.role.created` rows to know the
      // delta.
      const previousInheritsFrom = existing && !isBuiltinTarget && inheritsFrom !== undefined && inheritsFrom !== existing.inheritsFrom
        ? existing.inheritsFrom
        : undefined;
      await auditAction(auth, action, { targetType: "org_role", targetId: savedRow?.id ?? "", metadata: {
        name,
        grantedPermissions: permissions,
        inheritsFrom,
        previousInheritsFrom,
        description: description ?? undefined,
        coerced: coercedFloor.length > 0 ? coercedFloor : undefined,
      } });
      return sendJson(res, savedRow);
    },
  },

  // === Delete role (custom only) ===
  {
    method: "DELETE",
    match: (url) => /^\/org\/roles\/[^/]+$/.test(url),
    role: "admin",
    permission: "org.permissions.write",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/org\/roles\/([^/?]+)/);
      const name = match?.[1] ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
      if (!name) return sendError(res, "roles_name_required", "role name is required", 400);

      if (isRole(name)) {
        // Built-in name: this DELETE means "revert to defaults", not "delete the role".
        const existing = await getOrgRole({ orgId: auth.orgId, name });
        if (!existing) {
          return sendError(res, "roles_override_not_found", "no override exists for this built-in role", 404);
        }
        await deleteOrgRole({ orgId: auth.orgId, name });
        await auditAction(auth, "org.permissions.override_cleared", { targetType: "org_role", targetId: existing.id, metadata: { name } });
        return sendJson(res, { ok: true, reverted: true });
      }

      const existing = await getOrgRole({ orgId: auth.orgId, name });
      if (!existing) return sendError(res, "role_not_found", "role not found", 404);

      const membersAffected = await countMembersInRole({ orgId: auth.orgId, roleName: name });
      if (membersAffected > 0) {
        return sendJson(
          res,
          {
            ...errorEnvelope("role_in_use", "cannot delete a role with active members", { membersAffected }),
            // Top-level `membersAffected` preserved for back-compat with existing
            // clients that read it outside `params`. New clients use `tApiError`
            // which reads from `params`.
            membersAffected,
          },
          409,
        );
      }
      await deleteOrgRole({ orgId: auth.orgId, name });
      await auditAction(auth, "org.role.deleted", { targetType: "org_role", targetId: existing.id, metadata: {
        name,
        inheritsFrom: existing.inheritsFrom,
      } });
      return sendJson(res, { ok: true });
    },
  },
];
