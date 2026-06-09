/**
 * Tests for the SCIM event dispatcher. Mocked repos + audit so the
 * pure dispatch logic can be exercised without touching Postgres.
 *
 * Critical safety surfaces:
 *  - Replay guard (event_id idempotency)
 *  - Out-of-order guard (timestamp comparison)
 *  - Resurrection guard (stale create-event for deactivated user)
 *  - allowedEmailDomains policy gate at provision time
 *  - Multi-tenant scope (every action carries the directory's orgId,
 *    never the event payload's claim)
 */
import { describe, expect, it, beforeEach } from "vitest";

import { deriveScimRole, handleScimEvent, type ScimEvent, type ScimHandlerDeps } from "./scim-event-handler";
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

function fixtureUserEvent(overrides: Partial<ScimEvent> = {}): ScimEvent {
  return {
    id: "evt_user_1",
    event: "dsync.user.created",
    created_at: "2026-05-14T18:30:00Z",
    data: {
      id: "directory_user_1",
      directory_id: "directory_01",
      first_name: "Ada",
      last_name: "Lovelace",
      emails: [{ primary: true, value: "ada@example.com" }],
    },
    ...overrides,
  };
}

type Captured = {
  upsertedUserState: unknown[];
  inactiveCalls: unknown[];
  upsertedByEmail: unknown[];
  deletedMemberships: unknown[];
  upsertedGroupState: unknown[];
  deletedGroupState: unknown[];
  audits: Array<{ orgId: string; userId: string; action: string; metadata?: unknown }>;
  syncBumps: unknown[];
  processedEventIds: Set<string>;
  releasedEvents: Array<{ eventId: string; orgId: string }>;
  addedUserGroups: Array<{ providerUserId: string; providerGroupId: string }>;
  removedUserGroups: Array<{ providerUserId: string; providerGroupId: string }>;
  deletedUserGroupsForGroup: Array<{ providerGroupId: string }>;
  deletedUserGroupsForUser: Array<{ providerUserId: string }>;
  /** Live mirror of the user's group memberships, mutated by add/remove so the
   *  handler's "persist join row, THEN recompute" ordering is exercised end to
   *  end (the recompute reads `listScimUserGroupIds` after the mutation). */
  userGroupIds: Set<string>;
};

function makeDeps(input: {
  existingState?: {
    id: string;
    orgId: string;
    email: string;
    active: boolean;
    lastEventTimestamp: Date | string | null;
  };
  existingGroupState?: { id: string };
  allowedDomains?: string[];
  processedEventIds?: Set<string>;
  /** Seed group memberships for the (single) user under test. */
  userGroupIds?: string[];
  /** providerGroupId → providerUserIds for group-deletion recompute. */
  groupUserIdsForGroup?: Record<string, string[]>;
  /** providerGroupId → built-in role mapping for the directory. */
  groupRoleMappings?: Record<string, string>;
  /** Seed pre-existing org_members rows keyed by lowercased email, so the
   *  collision guards see a row at the target email. Default: no rows. */
  existingMemberByEmail?: Record<string, { role: string; invitedBy: string | null; userId: string }>;
}): { deps: ScimHandlerDeps; captured: Captured } {
  const captured: Captured = {
    upsertedUserState: [],
    inactiveCalls: [],
    upsertedByEmail: [],
    deletedMemberships: [],
    upsertedGroupState: [],
    deletedGroupState: [],
    audits: [],
    syncBumps: [],
    processedEventIds: input.processedEventIds ?? new Set(),
    releasedEvents: [],
    addedUserGroups: [],
    removedUserGroups: [],
    deletedUserGroupsForGroup: [],
    deletedUserGroupsForUser: [],
    userGroupIds: new Set(input.userGroupIds ?? []),
  };
  const mappings = new Map(Object.entries(input.groupRoleMappings ?? {}));

  const deps: ScimHandlerDeps = {
    upsertScimUserState: async (i) => {
      captured.upsertedUserState.push(i);
      return null;
    },
    getScimUserState: async () => input.existingState ?? null,
    markScimUserInactive: async (i) => {
      captured.inactiveCalls.push(i);
    },
    upsertScimGroupState: async (i) => {
      captured.upsertedGroupState.push(i);
      return null;
    },
    deleteScimGroupState: async (i) => {
      captured.deletedGroupState.push(i);
    },
    getScimGroupState: async () => input.existingGroupState ?? null,
    recordProcessedEvent: async (i) => {
      if (captured.processedEventIds.has(i.eventId)) return { fresh: false };
      captured.processedEventIds.add(i.eventId);
      return { fresh: true };
    },
    upsertMembershipByEmail: async (i) => {
      captured.upsertedByEmail.push(i);
      return null;
    },
    findMemberByEmail: async (i) => input.existingMemberByEmail?.[i.email.toLowerCase()] ?? null,
    deleteMembership: async (i) => {
      captured.deletedMemberships.push(i);
      return 1;
    },
    deleteProcessedEvent: async (i) => {
      captured.releasedEvents.push(i);
    },
    getAuthPolicyConfig: async () => ({
      allowedEmailDomains: input.allowedDomains ?? [],
      mfaRequired: false,
      sessionTtlSeconds: 28800,
    }),
    audit: async (orgId, userId, action, _t, _id, metadata) => {
      captured.audits.push({ orgId, userId, action, metadata });
    },
    recordScimDirectorySync: async (i) => {
      captured.syncBumps.push(i);
    },
    getScimGroupRoleMappingsMap: async () => new Map(mappings),
    listScimUserGroupIds: async () => [...captured.userGroupIds],
    listScimUserIdsForGroup: async (i) => input.groupUserIdsForGroup?.[i.providerGroupId] ?? [],
    addScimUserGroup: async (i) => {
      captured.addedUserGroups.push({ providerUserId: i.providerUserId, providerGroupId: i.providerGroupId });
      captured.userGroupIds.add(i.providerGroupId);
    },
    removeScimUserGroup: async (i) => {
      captured.removedUserGroups.push({ providerUserId: i.providerUserId, providerGroupId: i.providerGroupId });
      captured.userGroupIds.delete(i.providerGroupId);
    },
    deleteScimUserGroupsForGroup: async (i) => {
      captured.deletedUserGroupsForGroup.push({ providerGroupId: i.providerGroupId });
      captured.userGroupIds.delete(i.providerGroupId);
    },
    deleteScimUserGroupsForUser: async (i) => {
      captured.deletedUserGroupsForUser.push({ providerUserId: i.providerUserId });
      captured.userGroupIds.clear();
    },
  };

  return { deps, captured };
}

describe("handleScimEvent — replay guard", () => {
  it("skips a duplicate event id with audit and no state changes", async () => {
    const seen = new Set(["evt_dup"]);
    const { deps, captured } = makeDeps({ processedEventIds: seen });
    const result = await handleScimEvent({
      event: fixtureUserEvent({ id: "evt_dup" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "event_replayed" });
    expect(captured.upsertedUserState).toHaveLength(0);
    expect(captured.upsertedByEmail).toHaveLength(0);
    expect(captured.audits.map((a) => a.action)).toEqual(["scim.webhook.event_replayed"]);
  });
});

describe("handleScimEvent — user.created", () => {
  let deps: ScimHandlerDeps;
  let captured: Captured;
  beforeEach(() => {
    ({ deps, captured } = makeDeps({}));
  });

  it("provisions a fresh user — org_members + scim_user_state + audit", async () => {
    const result = await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory({ defaultRole: "editor" }),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "provisioned" });
    expect(captured.upsertedUserState).toHaveLength(1);
    expect(captured.upsertedUserState[0]).toMatchObject({
      orgId: "org-A",
      providerUserId: "directory_user_1",
      email: "ada@example.com",
      active: true,
    });
    expect(captured.upsertedByEmail).toHaveLength(1);
    expect(captured.upsertedByEmail[0]).toMatchObject({
      orgId: "org-A",
      email: "ada@example.com",
      role: "editor",
    });
    expect(captured.audits.find((a) => a.action === "scim.user.provisioned")).toBeDefined();
  });

  it("accepts WorkOS' normalized top-level email field", async () => {
    const result = await handleScimEvent({
      event: fixtureUserEvent({
        data: {
          id: "directory_user_1",
          directory_id: "directory_01",
          email: "lela.block@example.com",
          first_name: "Lela",
          last_name: "Block",
          custom_attributes: {
            emails: [{ primary: true, value: "custom@example.com" }],
          },
        },
      }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "provisioned" });
    expect(captured.upsertedByEmail[0]).toMatchObject({ email: "lela.block@example.com" });
  });

  it("falls back to custom_attributes.emails when top-level email is absent", async () => {
    const result = await handleScimEvent({
      event: fixtureUserEvent({
        data: {
          id: "directory_user_1",
          directory_id: "directory_01",
          first_name: "Lela",
          last_name: "Block",
          custom_attributes: {
            emails: [{ primary: true, value: "custom@example.com" }],
          },
        },
      }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "provisioned" });
    expect(captured.upsertedByEmail[0]).toMatchObject({ email: "custom@example.com" });
  });

  it("uses the directory's defaultRole, not the event payload's claim", async () => {
    await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory({ defaultRole: "admin" }),
      deps,
    });
    expect(captured.upsertedByEmail[0]).toMatchObject({ role: "admin" });
  });

  it("rejects malformed payload missing provider user id", async () => {
    const result = await handleScimEvent({
      event: fixtureUserEvent({ data: { directory_id: "directory_01", emails: [{ primary: true, value: "a@b.com" }] } }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result.processed).toBe(false);
    expect(captured.audits.some((a) => a.action === "scim.webhook.malformed_payload")).toBe(true);
  });

  it("rejects malformed timestamp", async () => {
    const result = await handleScimEvent({
      event: fixtureUserEvent({ created_at: "not-a-date" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result.processed).toBe(false);
    expect(captured.audits.some((a) => a.action === "scim.webhook.malformed_timestamp")).toBe(true);
  });

  it("refuses to overwrite a human-invited row at the same email (provision collision)", async () => {
    const { deps, captured } = makeDeps({
      existingMemberByEmail: {
        "ada@example.com": { role: "admin", invitedBy: "user_admin", userId: "user_admin" },
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory({ defaultRole: "viewer" }),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "provision_collision" });
    // The human's row is never touched, and no SCIM state is advanced.
    expect(captured.upsertedByEmail).toHaveLength(0);
    expect(captured.upsertedUserState).toHaveLength(0);
    const collision = captured.audits.find((a) => a.action === "scim.user.provision_collision");
    expect(collision).toBeDefined();
    expect(collision?.metadata).toMatchObject({ email: "ada@example.com", conflictingRole: "admin" });
  });

  it("absorbs a SCIM-owned row at the same email (re-attach / idempotent re-delivery)", async () => {
    const { deps, captured } = makeDeps({
      existingMemberByEmail: {
        "ada@example.com": { role: "viewer", invitedBy: "scim:webhook", userId: "ada@example.com" },
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory({ defaultRole: "editor" }),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "provisioned" });
    // SCIM-owned row is this directory's own lifecycle → proceed and re-derive.
    expect(captured.upsertedByEmail[0]).toMatchObject({ email: "ada@example.com", role: "editor" });
    expect(captured.audits.some((a) => a.action === "scim.user.provision_collision")).toBe(false);
  });
});

describe("handleScimEvent — resurrection guard", () => {
  it("blocks a stale user.created event for a deactivated user", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: false,
        lastEventTimestamp: "2026-05-15T00:00:00Z", // deactivated AFTER the incoming event
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent({ created_at: "2026-05-14T18:30:00Z" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "resurrection_blocked" });
    expect(captured.upsertedUserState).toHaveLength(0);
    expect(captured.upsertedByEmail).toHaveLength(0);
    expect(captured.audits.find((a) => a.action === "scim.user.resurrection_blocked")).toBeDefined();
  });

  it("allows genuine reactivation with a NEWER timestamp", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: false,
        lastEventTimestamp: "2026-05-10T00:00:00Z", // deactivated BEFORE the incoming event
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent({ created_at: "2026-05-14T18:30:00Z" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result.processed).toBe(true);
    expect(captured.upsertedByEmail).toHaveLength(1);
    const audit = captured.audits.find((a) => a.action === "scim.user.provisioned");
    expect(audit).toBeDefined();
    expect((audit?.metadata as { reactivated: boolean }).reactivated).toBe(true);
  });
});

describe("handleScimEvent — out-of-order guard", () => {
  it("skips a user.updated with timestamp <= lastEventTimestamp", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: true,
        lastEventTimestamp: "2026-05-15T00:00:00Z",
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent({ event: "dsync.user.updated", created_at: "2026-05-14T18:30:00Z" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "out_of_order" });
    expect(captured.upsertedUserState).toHaveLength(0);
    expect(captured.audits.find((a) => a.action === "scim.webhook.out_of_order")).toBeDefined();
  });

  it("skips an active user.created with timestamp <= lastEventTimestamp", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: true,
        lastEventTimestamp: "2026-05-15T00:00:00Z",
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent({ created_at: "2026-05-14T18:30:00Z" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "out_of_order" });
  });
});

describe("handleScimEvent — allowedEmailDomains policy gate", () => {
  it("rejects provisioning when the email's domain isn't in the allow-list", async () => {
    const { deps, captured } = makeDeps({ allowedDomains: ["acme.com"] });
    const result = await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "domain_not_allowed" });
    expect(captured.upsertedByEmail).toHaveLength(0);
    expect(captured.audits.find((a) => a.action === "scim.user.provision_rejected")).toBeDefined();
  });

  it("allows provisioning when the domain matches", async () => {
    const { deps, captured } = makeDeps({ allowedDomains: ["example.com"] });
    const result = await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result.processed).toBe(true);
    expect(captured.upsertedByEmail).toHaveLength(1);
  });

  it("allows provisioning when the allow-list is empty (no restriction)", async () => {
    const { deps } = makeDeps({ allowedDomains: [] });
    const result = await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result.processed).toBe(true);
  });
});

describe("handleScimEvent — user.updated", () => {
  it("updates an existing user's name without changing role", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: true,
        lastEventTimestamp: "2026-05-10T00:00:00Z",
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent({
        id: "evt_upd_1",
        event: "dsync.user.updated",
        created_at: "2026-05-14T18:30:00Z",
      }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "updated" });
    expect(captured.upsertedByEmail).toHaveLength(1);
    expect(captured.upsertedByEmail[0]).toMatchObject({ email: "ada@example.com" });
  });

  it("handles email change by deleting the old email's membership then upserting the new one", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "old@example.com",
        active: true,
        lastEventTimestamp: "2026-05-10T00:00:00Z",
      },
    });
    await handleScimEvent({
      event: fixtureUserEvent({
        id: "evt_upd_2",
        event: "dsync.user.updated",
        created_at: "2026-05-14T18:30:00Z",
        data: {
          id: "directory_user_1",
          directory_id: "directory_01",
          first_name: "Ada",
          last_name: "Lovelace",
          emails: [{ primary: true, value: "new@example.com" }],
        },
      }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(captured.deletedMemberships).toHaveLength(1);
    expect(captured.deletedMemberships[0]).toMatchObject({ email: "old@example.com" });
    expect(captured.upsertedByEmail[0]).toMatchObject({ email: "new@example.com" });
  });

  it("refuses a re-key onto an email that already has a membership (rekey collision)", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "old@example.com",
        active: true,
        lastEventTimestamp: "2026-05-10T00:00:00Z",
      },
      // The NEW email is already occupied (here by another SCIM principal — any
      // owner blocks on a re-key, since the new email should be empty).
      existingMemberByEmail: {
        "new@example.com": { role: "admin", invitedBy: "scim:webhook", userId: "new@example.com" },
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent({
        id: "evt_upd_collide",
        event: "dsync.user.updated",
        created_at: "2026-05-14T18:30:00Z",
        data: {
          id: "directory_user_1",
          directory_id: "directory_01",
          first_name: "Ada",
          last_name: "Lovelace",
          emails: [{ primary: true, value: "new@example.com" }],
        },
      }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "rekey_collision" });
    // The old membership is NOT deleted, the occupied email is NOT overwritten,
    // and no SCIM state is advanced — both principals stay intact.
    expect(captured.deletedMemberships).toHaveLength(0);
    expect(captured.upsertedByEmail).toHaveLength(0);
    expect(captured.upsertedUserState).toHaveLength(0);
    const collision = captured.audits.find((a) => a.action === "scim.user.rekey_collision");
    expect(collision).toBeDefined();
    expect(collision?.metadata).toMatchObject({ fromEmail: "old@example.com", toEmail: "new@example.com" });
  });

  it("refuses to revive a deactivated user via update event", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: false,
        lastEventTimestamp: "2026-05-10T00:00:00Z",
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent({ id: "evt_upd_3", event: "dsync.user.updated", created_at: "2026-05-14T18:30:00Z" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "resurrection_blocked" });
    expect(captured.upsertedByEmail).toHaveLength(0);
  });
});

describe("handleScimEvent — user.deleted", () => {
  it("deprovisions an existing user — deleteMembership + markScimUserInactive + audit", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: true,
        lastEventTimestamp: "2026-05-10T00:00:00Z",
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent({ id: "evt_del_1", event: "dsync.user.deleted", created_at: "2026-05-14T18:30:00Z" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "deprovisioned" });
    expect(captured.deletedMemberships).toHaveLength(1);
    expect(captured.deletedUserGroupsForUser).toEqual([{ providerUserId: "directory_user_1" }]);
    expect(captured.inactiveCalls).toHaveLength(1);
    expect(captured.audits.find((a) => a.action === "scim.user.deprovisioned")).toBeDefined();
  });

  it("ignores unknown user with audit", async () => {
    const { deps, captured } = makeDeps({}); // no existing state
    const result = await handleScimEvent({
      event: fixtureUserEvent({ id: "evt_del_2", event: "dsync.user.deleted" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "unknown_user" });
    expect(captured.deletedUserGroupsForUser).toEqual([{ providerUserId: "directory_user_1" }]);
    expect(captured.audits.find((a) => a.action === "scim.webhook.unknown_user")).toBeDefined();
  });

  it("respects out-of-order guard on delete", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: true,
        lastEventTimestamp: "2026-05-15T00:00:00Z",
      },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent({ id: "evt_del_3", event: "dsync.user.deleted", created_at: "2026-05-14T18:30:00Z" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "out_of_order" });
    expect(captured.deletedMemberships).toHaveLength(0);
    expect(captured.deletedUserGroupsForUser).toHaveLength(0);
  });
});

describe("handleScimEvent — group events", () => {
  it("upserts group state on dsync.group.created", async () => {
    const { deps, captured } = makeDeps({});
    const result = await handleScimEvent({
      event: {
        id: "evt_grp_1",
        event: "dsync.group.created",
        created_at: "2026-05-14T18:30:00Z",
        data: { id: "directory_group_1", directory_id: "directory_01", name: "Engineering" },
      },
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result.processed).toBe(true);
    expect(captured.upsertedGroupState).toHaveLength(1);
    expect(captured.audits.find((a) => a.action === "scim.group.synced")).toBeDefined();
  });

  it("deletes group state, cleans join rows, and recomputes affected active users", async () => {
    const { deps, captured } = makeDeps({
      existingGroupState: { id: "grp_state_1" },
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: true,
        lastEventTimestamp: "2026-05-10T00:00:00Z",
      },
      userGroupIds: ["directory_group_1"],
      groupUserIdsForGroup: { directory_group_1: ["directory_user_1"] },
      groupRoleMappings: { directory_group_1: "admin" },
    });
    const result = await handleScimEvent({
      event: {
        id: "evt_grp_2",
        event: "dsync.group.deleted",
        created_at: "2026-05-14T18:30:00Z",
        data: { id: "directory_group_1", directory_id: "directory_01" },
      },
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result.processed).toBe(true);
    expect(captured.deletedGroupState).toHaveLength(1);
    expect(captured.deletedUserGroupsForGroup).toEqual([{ providerGroupId: "directory_group_1" }]);
    expect(captured.upsertedByEmail[0]).toMatchObject({ email: "ada@example.com", role: "viewer" });
    const audit = captured.audits.find((a) => a.action === "scim.group.membership_changed");
    expect((audit?.metadata as { roleRecomputed: boolean; providerGroupId: string }).roleRecomputed).toBe(true);
  });
});

describe("deriveScimRole (pure)", () => {
  it("returns defaultRole when the user has no groups", () => {
    expect(deriveScimRole([], new Map(), "viewer")).toBe("viewer");
  });

  it("returns defaultRole when no group the user is in maps to a role", () => {
    expect(deriveScimRole(["g1", "g2"], new Map([["g3", "admin"]]), "editor")).toBe("editor");
  });

  it("returns the single mapped role for a single mapped group", () => {
    expect(deriveScimRole(["g1"], new Map([["g1", "editor"]]), "viewer")).toBe("editor");
  });

  it("picks the HIGHEST-rank role across multiple mapped groups", () => {
    const mappings = new Map([
      ["g1", "viewer"],
      ["g2", "admin"],
      ["g3", "editor"],
    ]);
    expect(deriveScimRole(["g1", "g2", "g3"], mappings, "viewer")).toBe("admin");
  });

  it("ignores unknown / custom role names (rank -1, never beats a built-in)", () => {
    const mappings = new Map([
      ["g1", "billing-admin"], // custom role — unknown to the built-in rank table
      ["g2", "editor"],
    ]);
    expect(deriveScimRole(["g1", "g2"], mappings, "viewer")).toBe("editor");
  });

  it("falls through to defaultRole when the only mapped group is an unknown role", () => {
    expect(deriveScimRole(["g1"], new Map([["g1", "billing-admin"]]), "viewer")).toBe("viewer");
  });
});

describe("handleScimEvent — group→role derivation", () => {
  it("provisions a user at the derived role when a pre-existing membership maps to a higher role", async () => {
    // Group-before-user ordering: the join row already exists (g1) and maps to
    // admin; the create derives admin instead of the directory's defaultRole.
    const { deps, captured } = makeDeps({
      userGroupIds: ["g1"],
      groupRoleMappings: { g1: "admin" },
    });
    const result = await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory({ defaultRole: "viewer" }),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "provisioned" });
    expect(captured.upsertedByEmail[0]).toMatchObject({ role: "admin" });
    const audit = captured.audits.find((a) => a.action === "scim.user.provisioned");
    expect((audit?.metadata as { role: string }).role).toBe("admin");
  });

  it("provisions at defaultRole when the user's groups map to nothing", async () => {
    const { deps, captured } = makeDeps({
      userGroupIds: ["g9"],
      groupRoleMappings: { g1: "admin" },
    });
    await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory({ defaultRole: "editor" }),
      deps,
    });
    expect(captured.upsertedByEmail[0]).toMatchObject({ role: "editor" });
  });

  it("group.user_added persists the join row then recomputes the member role", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: true,
        lastEventTimestamp: "2026-05-10T00:00:00Z",
      },
      groupRoleMappings: { g1: "admin" },
    });
    const result = await handleScimEvent({
      event: {
        id: "evt_grp_add",
        event: "dsync.group.user_added",
        created_at: "2026-05-14T18:30:00Z",
        data: { directory_id: "directory_01", user_id: "directory_user_1", directory_group_id: "g1" },
      },
      scimDirectory: fixtureDirectory({ defaultRole: "viewer" }),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "group_membership_added" });
    // Join row persisted FIRST...
    expect(captured.addedUserGroups).toEqual([{ providerUserId: "directory_user_1", providerGroupId: "g1" }]);
    // ...then the role recomputed to the mapped admin.
    expect(captured.upsertedByEmail[0]).toMatchObject({ email: "ada@example.com", role: "admin" });
    const audit = captured.audits.find((a) => a.action === "scim.group.membership_changed");
    expect((audit?.metadata as { roleRecomputed: boolean }).roleRecomputed).toBe(true);
  });

  it("group.user_removed drops the join row then lowers the role back toward defaultRole", async () => {
    const { deps, captured } = makeDeps({
      existingState: {
        id: "state_1",
        orgId: "org-A",
        email: "ada@example.com",
        active: true,
        lastEventTimestamp: "2026-05-10T00:00:00Z",
      },
      userGroupIds: ["g1"], // currently in the admin-mapped group
      groupRoleMappings: { g1: "admin" },
    });
    const result = await handleScimEvent({
      event: {
        id: "evt_grp_rm",
        event: "dsync.group.user_removed",
        created_at: "2026-05-14T18:30:00Z",
        data: { directory_id: "directory_01", user_id: "directory_user_1", directory_group_id: "g1" },
      },
      scimDirectory: fixtureDirectory({ defaultRole: "viewer" }),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "group_membership_removed" });
    expect(captured.removedUserGroups).toEqual([{ providerUserId: "directory_user_1", providerGroupId: "g1" }]);
    // After removing the only admin group, derivation falls back to defaultRole.
    expect(captured.upsertedByEmail[0]).toMatchObject({ email: "ada@example.com", role: "viewer" });
  });

  it("group.user_added before the user is provisioned records the join but skips the membership write", async () => {
    // No existing user_state → recompute audits roleRecomputed:false and does
    // NOT write org_members; the later user.created derives the role.
    const { deps, captured } = makeDeps({
      groupRoleMappings: { g1: "admin" },
    });
    const result = await handleScimEvent({
      event: {
        id: "evt_grp_add_early",
        event: "dsync.group.user_added",
        created_at: "2026-05-14T18:30:00Z",
        data: { directory_id: "directory_01", user_id: "directory_user_1", directory_group_id: "g1" },
      },
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: true, action: "group_membership_added" });
    expect(captured.addedUserGroups).toHaveLength(1);
    expect(captured.upsertedByEmail).toHaveLength(0);
    const audit = captured.audits.find((a) => a.action === "scim.group.membership_changed");
    expect((audit?.metadata as { roleRecomputed: boolean }).roleRecomputed).toBe(false);
  });

  it("rejects a membership event missing user_id / directory_group_id", async () => {
    const { deps, captured } = makeDeps({});
    const result = await handleScimEvent({
      event: {
        id: "evt_grp_bad",
        event: "dsync.group.user_added",
        created_at: "2026-05-14T18:30:00Z",
        data: { directory_id: "directory_01", user_id: "directory_user_1" }, // missing directory_group_id
      },
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "malformed_payload" });
    expect(captured.addedUserGroups).toHaveLength(0);
    expect(captured.audits.find((a) => a.action === "scim.webhook.malformed_payload")).toBeDefined();
  });
});

describe("handleScimEvent — unknown event", () => {
  it("audits and returns processed:false", async () => {
    const { deps, captured } = makeDeps({});
    const result = await handleScimEvent({
      event: {
        id: "evt_unknown",
        event: "dsync.something.new",
        created_at: "2026-05-14T18:30:00Z",
        data: { directory_id: "directory_01" },
      },
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(result).toEqual({ processed: false, reason: "unknown_event" });
    expect(captured.audits.find((a) => a.action === "scim.webhook.unknown_event")).toBeDefined();
  });
});

describe("handleScimEvent — multi-tenant", () => {
  it("always audits with the directory's orgId, never the payload's", async () => {
    const { deps, captured } = makeDeps({});
    await handleScimEvent({
      event: fixtureUserEvent({ data: { id: "directory_user_1", directory_id: "directory_01", emails: [{ primary: true, value: "a@b.com" }], org_id_in_payload: "org-EVIL" } }),
      scimDirectory: fixtureDirectory({ orgId: "org-LEGITIMATE" }),
      deps,
    });
    expect(captured.audits.every((a) => a.orgId === "org-LEGITIMATE")).toBe(true);
    expect(captured.upsertedByEmail[0]).toMatchObject({ orgId: "org-LEGITIMATE" });
  });
});

describe("handleScimEvent — sync timestamp", () => {
  it("bumps the directory's lastSyncedAt only on processed events", async () => {
    const { deps, captured } = makeDeps({});
    await handleScimEvent({
      event: fixtureUserEvent(),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(captured.syncBumps).toHaveLength(1);
  });

  it("does NOT bump sync timestamp on rejected events", async () => {
    const seen = new Set(["evt_dup"]);
    const { deps, captured } = makeDeps({ processedEventIds: seen });
    await handleScimEvent({
      event: fixtureUserEvent({ id: "evt_dup" }),
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(captured.syncBumps).toHaveLength(0);
  });
});

describe("handleScimEvent — release dedup claim on throw", () => {
  it("releases the processed-event row when a downstream repo throws so retries can re-process", async () => {
    const { deps, captured } = makeDeps({});
    // Inject a throw into the membership upsert (a realistic
    // DB-blip surface).
    deps.upsertMembershipByEmail = async () => {
      throw new Error("simulated DB outage");
    };
    await expect(handleScimEvent({
      event: fixtureUserEvent({ id: "evt_blip_1" }),
      scimDirectory: fixtureDirectory(),
      deps,
    })).rejects.toThrow(/DB outage/);
    // The release is a tenant-scoped write: it must carry the directory's
    // orgId, not just the event id (defense-in-depth on the dedup table).
    expect(captured.releasedEvents).toEqual([{ eventId: "evt_blip_1", orgId: "org-A" }]);
  });

  it("tolerates a release failure without masking the original error", async () => {
    const { deps } = makeDeps({});
    deps.upsertMembershipByEmail = async () => {
      throw new Error("primary failure");
    };
    deps.deleteProcessedEvent = async () => {
      throw new Error("release also failed");
    };
    await expect(handleScimEvent({
      event: fixtureUserEvent({ id: "evt_blip_2" }),
      scimDirectory: fixtureDirectory(),
      deps,
    })).rejects.toThrow(/primary failure/);
  });
});
