/**
 * Tests for the new permission-resolution helpers in `permissions.ts`.
 * Mocks `@janusly/db` (for `org_members`) and `@janusly/data/src/orgRolesRepo`
 * so the dispatch logic can be exercised in isolation from Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOrgRoleMock = vi.fn();
vi.mock("@janusly/data/src/orgRolesRepo", () => ({
  getOrgRole: (...args: unknown[]) => getOrgRoleMock(...args),
}));

const memberRowsMock = vi.fn();
vi.mock("@janusly/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => memberRowsMock(),
      }),
    }),
  },
  orgMembers: {} as Record<string, unknown>,
}));

beforeEach(() => {
  vi.resetModules();
  getOrgRoleMock.mockReset();
  memberRowsMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadModule() {
  return import("./permissions");
}

describe("resolveMemberRole", () => {
  it("returns built-in role + self-inheritance when the member row carries a built-in name", async () => {
    memberRowsMock.mockReturnValue(Promise.resolve([{ role: "editor" }]));
    const { resolveMemberRole } = await loadModule();
    const result = await resolveMemberRole("org-1", "user-1");
    expect(result).toEqual({ name: "editor", inheritsFrom: "editor" });
  });

  it("consults org_roles when the member row carries a custom role name", async () => {
    memberRowsMock.mockReturnValue(Promise.resolve([{ role: "compliance" }]));
    getOrgRoleMock.mockResolvedValueOnce({
      orgId: "org-1",
      name: "compliance",
      inheritsFrom: "viewer",
      isBuiltin: false,
      grantedPermissions: ["audit.read"],
    });
    const { resolveMemberRole } = await loadModule();
    const result = await resolveMemberRole("org-1", "user-1");
    expect(result).toEqual({ name: "compliance", inheritsFrom: "viewer" });
  });

  it("returns null for a deleted custom role still on a member row (defensive)", async () => {
    memberRowsMock.mockReturnValue(Promise.resolve([{ role: "stale_role" }]));
    getOrgRoleMock.mockResolvedValueOnce(null);
    const { resolveMemberRole } = await loadModule();
    const result = await resolveMemberRole("org-1", "user-1");
    expect(result).toBeNull();
  });

  it("dev-headers mode falls back to admin when there's no member row", async () => {
    memberRowsMock.mockReturnValue(Promise.resolve([]));
    const { resolveMemberRole } = await loadModule();
    const result = await resolveMemberRole("org-1", "user-1", "dev-headers");
    expect(result).toEqual({ name: "admin", inheritsFrom: "admin" });
  });
});

describe("getEffectivePermissions", () => {
  it("returns the override set verbatim when org_roles has non-null grantedPermissions", async () => {
    getOrgRoleMock.mockResolvedValueOnce({
      orgId: "org-1",
      name: "editor",
      inheritsFrom: "editor",
      isBuiltin: true,
      grantedPermissions: ["workflows.read"], // intentionally smaller than defaults
    });
    const { getEffectivePermissions } = await loadModule();
    const set = await getEffectivePermissions("org-1", "editor");
    expect(set.has("workflows.read")).toBe(true);
    expect(set.has("dlq.replay")).toBe(false); // dropped by override
  });

  it("falls back to catalog defaults when no override row exists for a built-in", async () => {
    getOrgRoleMock.mockResolvedValueOnce(null);
    const { getEffectivePermissions } = await loadModule();
    const set = await getEffectivePermissions("org-1", "editor");
    expect(set.has("workflows.write")).toBe(true);
    expect(set.has("members.write")).toBe(false);
  });

  it("returns empty set (fail-closed) for an unknown role with no row", async () => {
    getOrgRoleMock.mockResolvedValueOnce(null);
    const { getEffectivePermissions } = await loadModule();
    const set = await getEffectivePermissions("org-1", "compliance");
    expect(set.size).toBe(0);
  });

  it("filters out catalog-unknown permissions in stored override JSONB (defensive)", async () => {
    getOrgRoleMock.mockResolvedValueOnce({
      orgId: "org-1",
      name: "editor",
      inheritsFrom: "editor",
      isBuiltin: true,
      grantedPermissions: ["workflows.write", "totally.invalid"],
    });
    const { getEffectivePermissions } = await loadModule();
    const set = await getEffectivePermissions("org-1", "editor");
    expect(set.has("workflows.write")).toBe(true);
    expect(set.has("totally.invalid" as never)).toBe(false);
  });
});

describe("requirePermission", () => {
  it("passes when the user's effective set includes the permission", async () => {
    memberRowsMock.mockReturnValue(Promise.resolve([{ role: "editor" }]));
    getOrgRoleMock.mockResolvedValueOnce(null); // no override → use defaults
    const { requirePermission } = await loadModule();
    await expect(requirePermission("org-1", "u-1", "workflows.write")).resolves.toBeDefined();
  });

  it("rejects 403 when the user's role isn't found", async () => {
    memberRowsMock.mockReturnValue(Promise.resolve([]));
    const { requirePermission } = await loadModule();
    await expect(requirePermission("org-1", "u-1", "workflows.write")).rejects.toThrow(/Forbidden/);
  });

  it("rejects 403 when an override removed the permission from the user's role", async () => {
    memberRowsMock.mockReturnValue(Promise.resolve([{ role: "editor" }]));
    getOrgRoleMock.mockResolvedValueOnce({
      orgId: "org-1",
      name: "editor",
      inheritsFrom: "editor",
      isBuiltin: true,
      grantedPermissions: ["workflows.read"], // dropped workflows.write
    });
    const { requirePermission } = await loadModule();
    await expect(requirePermission("org-1", "u-1", "workflows.write")).rejects.toThrow(/Forbidden/);
  });
});

describe("requireRole (custom-role-aware)", () => {
  it("rejects requireRole('editor') for a compliance user with inheritsFrom: viewer", async () => {
    memberRowsMock.mockReturnValue(Promise.resolve([{ role: "compliance" }]));
    getOrgRoleMock.mockResolvedValueOnce({
      orgId: "org-1",
      name: "compliance",
      inheritsFrom: "viewer",
      isBuiltin: false,
      grantedPermissions: ["audit.read"],
    });
    const { requireRole } = await loadModule();
    await expect(requireRole("org-1", "u-1", "editor")).rejects.toThrow(/Forbidden/);
  });

  it("passes requireRole('editor') for a release-manager user with inheritsFrom: editor", async () => {
    memberRowsMock.mockReturnValue(Promise.resolve([{ role: "release-manager" }]));
    getOrgRoleMock.mockResolvedValueOnce({
      orgId: "org-1",
      name: "release-manager",
      inheritsFrom: "editor",
      isBuiltin: false,
      grantedPermissions: ["workflows.write"],
    });
    const { requireRole } = await loadModule();
    await expect(requireRole("org-1", "u-1", "editor")).resolves.toBe("editor");
  });
});
