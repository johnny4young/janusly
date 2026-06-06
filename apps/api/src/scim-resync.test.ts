/**
 * Tests for the pure bulk SCIM role re-sync orchestrator. Repos are
 * injected so the derivation + per-user write loop is exercised without
 * Postgres.
 */
import { describe, expect, it } from "vitest";

import { resyncScimMemberRoles, type ScimResyncDeps } from "./scim-resync";
import type { ScimDirectoryRow } from "@janusly/data/src/scimDirectoriesRepo";

function fixtureDirectory(overrides: Partial<ScimDirectoryRow> = {}): ScimDirectoryRow {
  return {
    id: "scim_dir_test",
    orgId: "org-A",
    providerDirectoryId: "directory_01",
    directoryType: "okta_scim",
    defaultRole: "viewer",
    status: "active",
    lastSyncedAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

type Captured = { upserts: Array<{ email: string; role: string }> };

function makeDeps(input: {
  members?: Array<{ providerUserId: string; email: string }>;
  /** providerGroupId → role mapping for the directory. */
  mappings?: Record<string, string>;
  /** providerUserId → the group ids they belong to. */
  userGroups?: Record<string, string[]>;
  /** lowercased email → current org_members role (null = no row). */
  currentRoles?: Record<string, string | null>;
  throwForUserId?: string;
}): { deps: ScimResyncDeps; captured: Captured } {
  const captured: Captured = { upserts: [] };
  const mappings = new Map(Object.entries(input.mappings ?? {}));
  const deps: ScimResyncDeps = {
    listActiveScimUserState: async () => input.members ?? [],
    getScimGroupRoleMappingsMap: async () => new Map(mappings),
    listScimUserGroupIds: async ({ providerUserId }) => {
      if (providerUserId === input.throwForUserId) throw new Error("simulated read fault");
      return input.userGroups?.[providerUserId] ?? [];
    },
    findMemberByEmail: async ({ email }) => {
      const role = input.currentRoles?.[email.toLowerCase()];
      return role === undefined || role === null ? null : { role };
    },
    upsertMembershipByEmail: async (i) => {
      captured.upserts.push({ email: i.email, role: i.role });
      return null;
    },
  };
  return { deps, captured };
}

describe("resyncScimMemberRoles", () => {
  it("returns 0/0 when there are no active members", async () => {
    const { deps, captured } = makeDeps({ members: [] });
    const result = await resyncScimMemberRoles({ scimDirectory: fixtureDirectory(), deps });
    expect(result.membersResynced).toBe(0);
    expect(result.membersChanged).toBe(0);
    expect(result.capped).toBe(false);
    expect(captured.upserts).toHaveLength(0);
  });

  it("re-derives a mapped member and counts the role change", async () => {
    const { deps, captured } = makeDeps({
      members: [{ providerUserId: "u1", email: "Ada@Example.com" }],
      mappings: { g1: "admin" },
      userGroups: { u1: ["g1"] },
      currentRoles: { "ada@example.com": "viewer" },
    });
    const result = await resyncScimMemberRoles({ scimDirectory: fixtureDirectory(), deps });
    expect(result.membersResynced).toBe(1);
    expect(result.membersChanged).toBe(1);
    expect(result.changes).toEqual([
      { providerUserId: "u1", email: "ada@example.com", from: "viewer", to: "admin" },
    ]);
    // Email lowercased on the write; no invitedBy passed.
    expect(captured.upserts).toEqual([{ email: "ada@example.com", role: "admin" }]);
  });

  it("does NOT count a member whose derived role already matches", async () => {
    const { deps } = makeDeps({
      members: [{ providerUserId: "u1", email: "ada@example.com" }],
      mappings: { g1: "editor" },
      userGroups: { u1: ["g1"] },
      currentRoles: { "ada@example.com": "editor" },
    });
    const result = await resyncScimMemberRoles({ scimDirectory: fixtureDirectory(), deps });
    expect(result.membersResynced).toBe(1);
    expect(result.membersChanged).toBe(0);
    expect(result.changes).toHaveLength(0);
  });

  it("falls back to the directory defaultRole for an unmapped member", async () => {
    const { deps, captured } = makeDeps({
      members: [{ providerUserId: "u1", email: "ada@example.com" }],
      mappings: { g1: "admin" }, // user is NOT in g1
      userGroups: { u1: ["g9"] },
      currentRoles: { "ada@example.com": "admin" }, // was admin, should drop to editor (default)
    });
    const result = await resyncScimMemberRoles({
      scimDirectory: fixtureDirectory({ defaultRole: "editor" }),
      deps,
    });
    expect(result.membersChanged).toBe(1);
    expect(captured.upserts[0]).toEqual({ email: "ada@example.com", role: "editor" });
  });

  it("treats a member with no org_members row as a change (self-heal, from null)", async () => {
    const { deps } = makeDeps({
      members: [{ providerUserId: "u1", email: "ada@example.com" }],
      mappings: { g1: "admin" },
      userGroups: { u1: ["g1"] },
      currentRoles: {}, // no current row
    });
    const result = await resyncScimMemberRoles({ scimDirectory: fixtureDirectory(), deps });
    expect(result.membersChanged).toBe(1);
    expect(result.changes[0]).toMatchObject({ from: null, to: "admin" });
  });

  it("does NOT flag capped when the active-member count exactly fills the cap", async () => {
    // Reader over-fetches cap+1; exactly `cap` rows come back → not truncated.
    const { deps } = makeDeps({
      members: [
        { providerUserId: "u1", email: "a@example.com" },
        { providerUserId: "u2", email: "b@example.com" },
      ],
    });
    const result = await resyncScimMemberRoles({ scimDirectory: fixtureDirectory(), deps, cap: 2 });
    expect(result.capped).toBe(false);
    expect(result.membersResynced).toBe(2);
  });

  it("flags capped and truncates to the cap when MORE members than the cap exist", async () => {
    // cap+1 (3) rows come back for cap=2 → truncated: process the first 2, flag capped.
    const { deps, captured } = makeDeps({
      members: [
        { providerUserId: "u1", email: "a@example.com" },
        { providerUserId: "u2", email: "b@example.com" },
        { providerUserId: "u3", email: "c@example.com" },
      ],
    });
    const result = await resyncScimMemberRoles({ scimDirectory: fixtureDirectory(), deps, cap: 2 });
    expect(result.capped).toBe(true);
    expect(result.membersResynced).toBe(2);
    // The 3rd member is left for a follow-up sweep — not written.
    expect(captured.upserts.map((u) => u.email)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("isolates a per-member fault into the skipped tally and keeps sweeping", async () => {
    const { deps, captured } = makeDeps({
      members: [
        { providerUserId: "u1", email: "a@example.com" },
        { providerUserId: "u2", email: "b@example.com" },
      ],
      mappings: { g1: "admin" },
      userGroups: { u2: ["g1"] },
      currentRoles: { "b@example.com": "viewer" },
      throwForUserId: "u1",
    });
    const result = await resyncScimMemberRoles({ scimDirectory: fixtureDirectory(), deps });
    expect(result.skipped).toBe(1);
    expect(result.membersResynced).toBe(1); // only u2 succeeded
    expect(result.membersChanged).toBe(1);
    expect(captured.upserts).toEqual([{ email: "b@example.com", role: "admin" }]);
  });
});
