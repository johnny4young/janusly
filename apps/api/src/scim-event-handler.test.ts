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

import { handleScimEvent, type ScimEvent, type ScimHandlerDeps } from "./scim-event-handler";
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
  releasedEventIds: string[];
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
    releasedEventIds: [],
  };

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
    deleteMembership: async (i) => {
      captured.deletedMemberships.push(i);
      return 1;
    },
    deleteProcessedEvent: async (i) => {
      captured.releasedEventIds.push(i.eventId);
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

  it("deletes group state on dsync.group.deleted", async () => {
    const { deps, captured } = makeDeps({ existingGroupState: { id: "grp_state_1" } });
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
  });

  it("treats group.user_added as a no-op state capture in v1", async () => {
    const { deps, captured } = makeDeps({});
    await handleScimEvent({
      event: {
        id: "evt_grp_add",
        event: "dsync.group.user_added",
        created_at: "2026-05-14T18:30:00Z",
        data: { directory_id: "directory_01", user_id: "u1", directory_group_id: "g1" },
      },
      scimDirectory: fixtureDirectory(),
      deps,
    });
    expect(captured.upsertedByEmail).toHaveLength(0);
    expect(captured.audits.find((a) => a.action === "scim.group.synced")).toBeDefined();
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
    expect(captured.releasedEventIds).toEqual(["evt_blip_1"]);
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
