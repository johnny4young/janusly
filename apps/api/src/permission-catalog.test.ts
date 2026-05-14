/**
 * Tests for the closed permission catalog. Asserts the invariants
 * that other parts of the codebase rely on (closure, role-default
 * mapping, admin-floor presence, unique keys).
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  assertPermissionsValid,
  isPermission,
  mandatoryAdminPermissions,
} from "./permission-catalog";

describe("PERMISSION_CATALOG", () => {
  it("ships at least the documented v1 set (19 keys after the MCP-client extension)", () => {
    expect(PERMISSION_CATALOG.length).toBeGreaterThanOrEqual(19);
  });

  it("exposes the MCP-client connection permissions in the closed catalog", () => {
    expect(isPermission("mcp.connections.read")).toBe(true);
    expect(isPermission("mcp.connections.write")).toBe(true);
  });

  it("has unique keys", () => {
    const set = new Set(PERMISSION_CATALOG.map((e) => e.key));
    expect(set.size).toBe(PERMISSION_CATALOG.length);
  });

  it("every entry has a non-empty description and defaultRoles array", () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(entry.key.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.defaultRoles)).toBe(true);
      for (const r of entry.defaultRoles) {
        expect(["viewer", "editor", "admin"]).toContain(r);
      }
    }
  });

  it("admin's default permission set is a superset of editor's, which is a superset of viewer's", () => {
    const viewer = DEFAULT_ROLE_PERMISSIONS.viewer;
    const editor = DEFAULT_ROLE_PERMISSIONS.editor;
    const admin = DEFAULT_ROLE_PERMISSIONS.admin;
    for (const p of viewer) expect(editor.has(p)).toBe(true);
    for (const p of editor) expect(admin.has(p)).toBe(true);
  });

  it("mandatoryAdminPermissions() are always granted to admin by default", () => {
    const admin = DEFAULT_ROLE_PERMISSIONS.admin;
    for (const p of mandatoryAdminPermissions()) {
      expect(admin.has(p)).toBe(true);
    }
  });
});

describe("isPermission + assertPermissionsValid", () => {
  it("isPermission accepts catalog keys and rejects unknowns", () => {
    expect(isPermission("workflows.write")).toBe(true);
    expect(isPermission("nope.invalid")).toBe(false);
    expect(isPermission(42)).toBe(false);
    expect(isPermission(null)).toBe(false);
  });

  it("assertPermissionsValid throws on unknown keys with the offender named", () => {
    expect(() => assertPermissionsValid(["workflows.write", "totally.fake"])).toThrow(/totally\.fake/);
  });

  it("assertPermissionsValid passes for empty + all-known arrays", () => {
    expect(() => assertPermissionsValid([])).not.toThrow();
    expect(() => assertPermissionsValid(["workflows.read", "runs.read"])).not.toThrow();
  });
});
