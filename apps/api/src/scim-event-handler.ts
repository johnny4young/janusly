/**
 * SCIM event dispatcher — pure functions that apply a single inbound
 * WorkOS Directory Sync event to Janusly state.
 *
 * The handler runs three idempotency / safety guards in deterministic
 * order on every event, then dispatches to a per-event-type handler:
 *
 *   1. **Replay guard** — `scim_processed_events` table keyed on the
 *      WorkOS event id. INSERT … ON CONFLICT DO NOTHING; if no row was
 *      inserted, the event is a replay → skip with audit.
 *   2. **Out-of-order guard** — every event carries `created_at`. The
 *      `scim_user_state.lastEventTimestamp` of the target user must be
 *      strictly less than the incoming timestamp; otherwise skip with
 *      audit.
 *   3. **Resurrection guard** — on `dsync.user.created`, if a state
 *      row exists with `active=false` AND the incoming timestamp is
 *      not newer than the deprovision event's, reject with audit.
 *
 * The handler never throws on a guard rejection or policy reject —
 * it audits and returns `{processed: false, reason}`. Real I/O
 * failures (DB outage) bubble up so the webhook route returns 5xx
 * and WorkOS retries with exponential backoff.
 *
 * Dependencies are passed via a `deps` parameter for testability;
 * production wires them in `apps/api/src/routes/scim-routes.ts`.
 *
 * Used by:
 * - `apps/api/src/routes/scim-routes.ts` (POST /webhooks/workos/directory).
 */

import {
  type ScimDirectoryRow,
  type ScimDefaultRole,
} from "@janusly/data";

export type ScimEvent = {
  id: string;
  event: string;
  created_at: string; // ISO 8601
  data: Record<string, unknown>;
};

export type ScimHandlerDeps = {
  upsertScimUserState: (input: {
    orgId: string;
    scimDirectoryId: string;
    providerUserId: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    active: boolean;
    lastEventId: string;
    lastEventTimestamp: Date;
  }) => Promise<unknown>;
  getScimUserState: (input: {
    scimDirectoryId: string;
    providerUserId: string;
  }) => Promise<{
    id: string;
    orgId: string;
    email: string;
    active: boolean;
    lastEventTimestamp: Date | string | null;
  } | null>;
  markScimUserInactive: (input: { id: string; eventId: string; eventTimestamp: Date }) => Promise<void>;
  upsertScimGroupState: (input: {
    orgId: string;
    scimDirectoryId: string;
    providerGroupId: string;
    name: string;
  }) => Promise<unknown>;
  deleteScimGroupState: (input: { id: string }) => Promise<void>;
  getScimGroupState: (input: {
    scimDirectoryId: string;
    providerGroupId: string;
  }) => Promise<{ id: string } | null>;
  recordProcessedEvent: (input: {
    eventId: string;
    orgId: string;
    scimDirectoryId: string;
    eventType: string;
  }) => Promise<{ fresh: boolean }>;
  deleteProcessedEvent: (input: { eventId: string }) => Promise<void>;
  upsertMembershipByEmail: (input: {
    orgId: string;
    email: string;
    role: string;
    invitedBy?: string | null;
  }) => Promise<unknown>;
  /**
   * Read the `org_members` row for `(orgId, lower(email))`, or null. Used by
   * the collision guards to detect when a SCIM membership write would land on
   * an email that already belongs to a different principal (a human-invited
   * admin, or a second SCIM user already at that address) BEFORE clobbering it.
   * The production repo function returns a wider row; this narrowed shape is
   * the subset the guards need.
   */
  findMemberByEmail: (input: {
    orgId: string;
    email: string;
  }) => Promise<{ role: string; invitedBy: string | null; userId: string } | null>;
  deleteMembership: (input: { orgId: string; email: string }) => Promise<number>;
  getAuthPolicyConfig: (orgId: string) => Promise<{
    allowedEmailDomains: string[];
    mfaRequired: boolean;
    sessionTtlSeconds: number;
  }>;
  audit: (
    orgId: string,
    userId: string,
    action: string,
    targetType?: string,
    targetId?: string,
    metadata?: unknown,
  ) => Promise<void>;
  recordScimDirectorySync: (input: { id: string; orgId: string }) => Promise<void>;
  // SCIM v2 group→role mapping
  getScimGroupRoleMappingsMap: (orgId: string, scimDirectoryId: string) => Promise<Map<string, string>>;
  listScimUserGroupIds: (input: {
    orgId: string;
    scimDirectoryId: string;
    providerUserId: string;
  }) => Promise<string[]>;
  listScimUserIdsForGroup: (input: {
    orgId: string;
    scimDirectoryId: string;
    providerGroupId: string;
  }) => Promise<string[]>;
  addScimUserGroup: (input: {
    orgId: string;
    scimDirectoryId: string;
    providerUserId: string;
    providerGroupId: string;
  }) => Promise<void>;
  removeScimUserGroup: (input: {
    orgId: string;
    scimDirectoryId: string;
    providerUserId: string;
    providerGroupId: string;
  }) => Promise<void>;
  deleteScimUserGroupsForUser: (input: {
    orgId: string;
    scimDirectoryId: string;
    providerUserId: string;
  }) => Promise<void>;
  deleteScimUserGroupsForGroup: (input: {
    orgId: string;
    scimDirectoryId: string;
    providerGroupId: string;
  }) => Promise<void>;
};

export type ScimHandlerResult =
  | { processed: true; action: string }
  | { processed: false; reason: string };

const SCIM_ACTOR = "scim:webhook";

/**
 * Is an existing `org_members` row owned by the SCIM webhook lifecycle (vs a
 * human-invited principal)? A row provisioned by SCIM carries
 * `invited_by = "scim:webhook"`. The create-path collision guard treats a
 * SCIM-owned row at the same email as this directory's own lifecycle
 * (re-attach after a hard-delete revoke, an idempotent re-delivery, or a
 * group-event-before-create that already provisioned) and absorbs it; only a
 * human-invited row blocks. The re-key guard does NOT use this — on an email
 * change the new email should be empty, so ANY pre-existing row there is a
 * different principal and blocks.
 */
function isScimOwnedMembership(row: { invitedBy: string | null }): boolean {
  return row.invitedBy === SCIM_ACTOR;
}

/** Built-in role rank for highest-wins group→role derivation. Mirrors the
 *  `viewer < editor < admin` ordering in `apps/api/src/permissions.ts`; kept
 *  local so this pure module doesn't import the DB-touching permissions file. */
const ROLE_RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3 };

/**
 * Derive a SCIM-provisioned member's role from their IdP group memberships.
 *
 * Among the groups the user belongs to that carry a mapping, return the
 * HIGHEST-rank built-in role (`viewer < editor < admin`); when no group the
 * user is in maps to a role, return `defaultRole`. Highest-rank-wins is the
 * standard group-RBAC semantics; the `defaultRole` fallback keeps a user with
 * no mapped group exactly as the pre-v2 (flat `defaultRole`) behavior — so an
 * org that hasn't configured any mapping is byte-for-byte unchanged.
 *
 * Pure + exported for unit tests. Unknown / custom role names in the mapping
 * rank as -1 (never beat a built-in); a map containing only unknowns falls
 * through to `defaultRole`.
 */
export function deriveScimRole(
  userGroupIds: readonly string[],
  mappings: Map<string, string>,
  defaultRole: string,
): string {
  let best: string | null = null;
  let bestRank = 0; // built-in ranks start at 1, so 0 means "nothing matched"
  for (const groupId of userGroupIds) {
    const role = mappings.get(groupId);
    if (!role) continue;
    const rank = ROLE_RANK[role] ?? -1;
    if (rank > bestRank) {
      bestRank = rank;
      best = role;
    }
  }
  return best ?? defaultRole;
}

/**
 * Top-level dispatcher. Returns a structured result so the route can
 * decide HTTP status (200 always for delivered+parseable events; the
 * structured `processed` flag is informational + audit-driven).
 */
export async function handleScimEvent(input: {
  event: ScimEvent;
  scimDirectory: ScimDirectoryRow;
  deps: ScimHandlerDeps;
}): Promise<ScimHandlerResult> {
  const { event, scimDirectory, deps } = input;
  const orgId = scimDirectory.orgId;

  // Replay guard
  const recorded = await deps.recordProcessedEvent({
    eventId: event.id,
    orgId,
    scimDirectoryId: scimDirectory.id,
    eventType: event.event,
  });
  if (!recorded.fresh) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.event_replayed", "scim_event", event.id, {
      eventType: event.event,
      scimDirectoryId: scimDirectory.id,
    });
    return { processed: false, reason: "event_replayed" };
  }

  const eventTimestamp = parseEventTimestamp(event.created_at);
  if (!eventTimestamp) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.malformed_timestamp", "scim_event", event.id, {
      eventType: event.event,
    });
    return { processed: false, reason: "malformed_timestamp" };
  }

  // We've claimed the event id. If dispatch THROWS (real I/O failure
  // — DB outage, repo crash), release the claim so WorkOS' next retry
  // can re-process; without this, a transient blip would silently
  // lose the event because the next delivery would see `fresh: false`
  // and skip. Best-effort: a release failure is tolerated (the worst
  // case matches the pre-release state).
  let result: ScimHandlerResult;
  try {
    switch (event.event) {
      case "dsync.user.created":
        result = await handleUserCreated({ event, eventTimestamp, scimDirectory, deps });
        break;
      case "dsync.user.updated":
        result = await handleUserUpdated({ event, eventTimestamp, scimDirectory, deps });
        break;
      case "dsync.user.deleted":
        result = await handleUserDeleted({ event, eventTimestamp, scimDirectory, deps });
        break;
      case "dsync.group.created":
      case "dsync.group.updated":
        result = await handleGroupUpsert({ event, scimDirectory, deps });
        break;
      case "dsync.group.deleted":
        result = await handleGroupDeleted({ event, scimDirectory, deps });
        break;
      case "dsync.group.user_added":
        result = await handleGroupUserAdded({ event, scimDirectory, deps });
        break;
      case "dsync.group.user_removed":
        result = await handleGroupUserRemoved({ event, scimDirectory, deps });
        break;
      default:
        await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.unknown_event", "scim_event", event.id, {
          eventType: event.event,
        });
        result = { processed: false, reason: "unknown_event" };
    }
  } catch (err) {
    try {
      // Invariant (AGENTS.md "SCIM directory sync"): release the dedup
      // claim on handler throws so WorkOS retries are not mistaken for
      // already-processed events after a transient DB failure.
      await deps.deleteProcessedEvent({ eventId: event.id });
    } catch {
      // Secondary release failure swallowed; original error rethrows below.
    }
    throw err;
  }

  if (result.processed) {
    await deps.recordScimDirectorySync({ id: scimDirectory.id, orgId });
  }
  return result;
}

/* ---------------------------- user.created ------------------------------- */

async function handleUserCreated(input: {
  event: ScimEvent;
  eventTimestamp: Date;
  scimDirectory: ScimDirectoryRow;
  deps: ScimHandlerDeps;
}): Promise<ScimHandlerResult> {
  const { event, eventTimestamp, scimDirectory, deps } = input;
  const orgId = scimDirectory.orgId;

  const providerUserId = stringField(event.data, "id");
  const email = primaryEmail(event.data);
  if (!providerUserId || !email) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.malformed_payload", "scim_event", event.id, {
      eventType: event.event,
      missingFields: !providerUserId ? "id" : "email",
    });
    return { processed: false, reason: "malformed_payload" };
  }

  // Resurrection guard
  const existing = await deps.getScimUserState({
    scimDirectoryId: scimDirectory.id,
    providerUserId,
  });
  if (existing && !existing.active) {
    const lastTs = coerceTimestamp(existing.lastEventTimestamp);
    if (lastTs && eventTimestamp <= lastTs) {
      await deps.audit(orgId, SCIM_ACTOR, "scim.user.resurrection_blocked", "scim_user", providerUserId, {
        email,
        scimDirectoryId: scimDirectory.id,
        eventId: event.id,
        incomingTimestamp: eventTimestamp.toISOString(),
        lastEventTimestamp: lastTs.toISOString(),
      });
      return { processed: false, reason: "resurrection_blocked" };
    }
  }

  // Out-of-order guard
  if (existing) {
    const lastTs = coerceTimestamp(existing.lastEventTimestamp);
    if (lastTs && eventTimestamp <= lastTs && existing.active) {
      await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.out_of_order", "scim_event", event.id, {
        eventType: event.event,
        providerUserId,
        incomingTimestamp: eventTimestamp.toISOString(),
        lastEventTimestamp: lastTs.toISOString(),
      });
      return { processed: false, reason: "out_of_order" };
    }
  }

  // allowedEmailDomains policy gate
  const policy = await deps.getAuthPolicyConfig(orgId);
  if (policy.allowedEmailDomains.length > 0) {
    const allow = policy.allowedEmailDomains.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    if (allow.length > 0 && !allow.includes(domain)) {
      await deps.audit(orgId, SCIM_ACTOR, "scim.user.provision_rejected", "scim_user", providerUserId, {
        email,
        domain,
        scimDirectoryId: scimDirectory.id,
        reason: "domain_not_allowed",
        allowedDomains: allow,
      });
      return { processed: false, reason: "domain_not_allowed" };
    }
  }

  const wasReactivation = existing != null && !existing.active;
  const lowerEmail = email.toLowerCase();

  // Collision guard: refuse to overwrite a membership that belongs to a
  // DIFFERENT (human-invited) principal. When a directory is first attached,
  // SCIM can provision a user at an email a human admin already invited (e.g.
  // the founder made themselves admin); silently upserting would downgrade
  // them to the SCIM-derived role and reassign invited_by. A SCIM-owned row at
  // the same email is this directory's own lifecycle and is safe to absorb
  // (re-attach / idempotent re-delivery / group-before-create), so only a
  // human-invited row blocks. Returns BEFORE any state/membership write so the
  // existing principal is left fully intact; the operator resolves via the
  // audit trail. (A genuine reactivation has no row — deprovision deleted it.)
  const existingMember = await deps.findMemberByEmail({ orgId, email: lowerEmail });
  if (existingMember && !isScimOwnedMembership(existingMember)) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.user.provision_collision", "scim_user", providerUserId, {
      email: lowerEmail,
      conflictingRole: existingMember.role,
      conflictingInvitedBy: existingMember.invitedBy,
      scimDirectoryId: scimDirectory.id,
      eventId: event.id,
    });
    return { processed: false, reason: "provision_collision" };
  }

  await deps.upsertScimUserState({
    orgId,
    scimDirectoryId: scimDirectory.id,
    providerUserId,
    email: lowerEmail,
    firstName: stringField(event.data, "first_name") ?? null,
    lastName: stringField(event.data, "last_name") ?? null,
    active: true,
    lastEventId: event.id,
    lastEventTimestamp: eventTimestamp,
  });
  // Derive the role from the user's group memberships. When a group event
  // arrived before this create (the membership join row already exists),
  // derivation picks it up here; with no mapped group it returns
  // `defaultRole`, byte-for-byte the pre-v2 flat-role behavior.
  const role = await resolveDerivedRole({
    orgId,
    scimDirectoryId: scimDirectory.id,
    providerUserId,
    defaultRole: scimDirectory.defaultRole,
    deps,
  });
  await deps.upsertMembershipByEmail({
    orgId,
    email: lowerEmail,
    role,
    invitedBy: SCIM_ACTOR,
  });

  await deps.audit(orgId, SCIM_ACTOR, "scim.user.provisioned", "scim_user", providerUserId, {
    email: lowerEmail,
    role,
    scimDirectoryId: scimDirectory.id,
    eventId: event.id,
    reactivated: wasReactivation,
  });
  return { processed: true, action: "provisioned" };
}

/* ---------------------------- user.updated ------------------------------- */

async function handleUserUpdated(input: {
  event: ScimEvent;
  eventTimestamp: Date;
  scimDirectory: ScimDirectoryRow;
  deps: ScimHandlerDeps;
}): Promise<ScimHandlerResult> {
  const { event, eventTimestamp, scimDirectory, deps } = input;
  const orgId = scimDirectory.orgId;

  const providerUserId = stringField(event.data, "id");
  const email = primaryEmail(event.data);
  if (!providerUserId || !email) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.malformed_payload", "scim_event", event.id, {
      eventType: event.event,
    });
    return { processed: false, reason: "malformed_payload" };
  }

  const existing = await deps.getScimUserState({
    scimDirectoryId: scimDirectory.id,
    providerUserId,
  });

  // Out-of-order guard
  if (existing) {
    const lastTs = coerceTimestamp(existing.lastEventTimestamp);
    if (lastTs && eventTimestamp <= lastTs) {
      await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.out_of_order", "scim_event", event.id, {
        eventType: event.event,
        providerUserId,
        incomingTimestamp: eventTimestamp.toISOString(),
        lastEventTimestamp: lastTs.toISOString(),
      });
      return { processed: false, reason: "out_of_order" };
    }
  }

  // If state doesn't exist yet, treat update like create (defensive)
  if (!existing) {
    return handleUserCreated({ event, eventTimestamp, scimDirectory, deps });
  }

  // Disallow reviving a deprovisioned user via UPDATE.
  if (!existing.active) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.user.resurrection_blocked", "scim_user", providerUserId, {
      email,
      scimDirectoryId: scimDirectory.id,
      eventId: event.id,
      reason: "update_while_inactive",
    });
    return { processed: false, reason: "resurrection_blocked" };
  }

  const lowerEmail = email.toLowerCase();
  const oldEmail = existing.email.toLowerCase();

  // If the email changed, the org_members row needs to be re-keyed
  // (`userId = lower(email)` for SCIM-provisioned rows). DELETE the
  // old row then INSERT the new one via upsertMembership.
  if (lowerEmail !== oldEmail) {
    // Collision guard: on a re-key the NEW email should be empty. ANY
    // pre-existing row there belongs to a different principal — a human-invited
    // admin, OR a second SCIM user already at that address — and re-keying onto
    // it would clobber their membership. Refuse, audit, and leave this user on
    // their current email (no delete, no overwrite, no state advance) so both
    // principals stay intact; the operator resolves via the audit trail.
    const targetMember = await deps.findMemberByEmail({ orgId, email: lowerEmail });
    if (targetMember) {
      await deps.audit(orgId, SCIM_ACTOR, "scim.user.rekey_collision", "scim_user", providerUserId, {
        fromEmail: oldEmail,
        toEmail: lowerEmail,
        conflictingRole: targetMember.role,
        conflictingInvitedBy: targetMember.invitedBy,
        scimDirectoryId: scimDirectory.id,
        eventId: event.id,
      });
      return { processed: false, reason: "rekey_collision" };
    }
    await deps.deleteMembership({ orgId, email: oldEmail });
  }

  await deps.upsertScimUserState({
    orgId,
    scimDirectoryId: scimDirectory.id,
    providerUserId,
    email: lowerEmail,
    firstName: stringField(event.data, "first_name") ?? null,
    lastName: stringField(event.data, "last_name") ?? null,
    active: true,
    lastEventId: event.id,
    lastEventTimestamp: eventTimestamp,
  });
  // Re-derive the role on every update so a re-key (email change) or a
  // mapping configured since the last sync is reflected; no mapped group
  // → `defaultRole` (pre-v2 behavior).
  const role = await resolveDerivedRole({
    orgId,
    scimDirectoryId: scimDirectory.id,
    providerUserId,
    defaultRole: scimDirectory.defaultRole,
    deps,
  });
  await deps.upsertMembershipByEmail({
    orgId,
    email: lowerEmail,
    role,
    invitedBy: SCIM_ACTOR,
  });

  await deps.audit(orgId, SCIM_ACTOR, "scim.user.updated", "scim_user", providerUserId, {
    email: lowerEmail,
    role,
    previousEmail: oldEmail === lowerEmail ? undefined : oldEmail,
    scimDirectoryId: scimDirectory.id,
    eventId: event.id,
  });
  return { processed: true, action: "updated" };
}

/* ---------------------------- user.deleted ------------------------------- */

async function handleUserDeleted(input: {
  event: ScimEvent;
  eventTimestamp: Date;
  scimDirectory: ScimDirectoryRow;
  deps: ScimHandlerDeps;
}): Promise<ScimHandlerResult> {
  const { event, eventTimestamp, scimDirectory, deps } = input;
  const orgId = scimDirectory.orgId;

  const providerUserId = stringField(event.data, "id");
  if (!providerUserId) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.malformed_payload", "scim_event", event.id, {
      eventType: event.event,
    });
    return { processed: false, reason: "malformed_payload" };
  }

  const existing = await deps.getScimUserState({
    scimDirectoryId: scimDirectory.id,
    providerUserId,
  });
  if (!existing) {
    // A delete for an unknown user can arrive after one or more early
    // group-membership events. Clear those orphan join rows so a later,
    // genuine user.created event cannot inherit stale groups from the old
    // lifecycle. This is safe before the out-of-order guard because there is
    // no user state timestamp to compare against.
    await deps.deleteScimUserGroupsForUser({ orgId, scimDirectoryId: scimDirectory.id, providerUserId });
    await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.unknown_user", "scim_event", event.id, {
      eventType: event.event,
      providerUserId,
    });
    return { processed: false, reason: "unknown_user" };
  }

  // Out-of-order guard
  const lastTs = coerceTimestamp(existing.lastEventTimestamp);
  if (lastTs && eventTimestamp <= lastTs) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.out_of_order", "scim_event", event.id, {
      eventType: event.event,
      providerUserId,
      incomingTimestamp: eventTimestamp.toISOString(),
      lastEventTimestamp: lastTs.toISOString(),
    });
    return { processed: false, reason: "out_of_order" };
  }

  await deps.deleteMembership({ orgId, email: existing.email });
  await deps.deleteScimUserGroupsForUser({ orgId, scimDirectoryId: scimDirectory.id, providerUserId });
  await deps.markScimUserInactive({
    id: existing.id,
    eventId: event.id,
    eventTimestamp,
  });

  await deps.audit(orgId, SCIM_ACTOR, "scim.user.deprovisioned", "scim_user", providerUserId, {
    email: existing.email,
    scimDirectoryId: scimDirectory.id,
    eventId: event.id,
  });
  return { processed: true, action: "deprovisioned" };
}

/* ------------------------ role derivation (v2) --------------------------- */

/** Load the user's current groups + the directory's mappings and derive the
 *  member role (highest-rank mapped role, else `defaultRole`). */
async function resolveDerivedRole(input: {
  orgId: string;
  scimDirectoryId: string;
  providerUserId: string;
  defaultRole: string;
  deps: ScimHandlerDeps;
}): Promise<string> {
  const [groupIds, mappings] = await Promise.all([
    input.deps.listScimUserGroupIds({
      orgId: input.orgId,
      scimDirectoryId: input.scimDirectoryId,
      providerUserId: input.providerUserId,
    }),
    input.deps.getScimGroupRoleMappingsMap(input.orgId, input.scimDirectoryId),
  ]);
  return deriveScimRole(groupIds, mappings, input.defaultRole);
}

/**
 * Recompute a member's role after a group-membership change and write the
 * `org_members` row. When no active `scim_user_state` exists for the user
 * (a group event arriving before the user is provisioned, or a deprovisioned
 * user) the join row is already persisted by the caller — a later user
 * create/update will derive the role — so we only audit the membership
 * change and skip the membership write.
 */
async function recomputeMemberRole(input: {
  event: ScimEvent;
  scimDirectory: ScimDirectoryRow;
  deps: ScimHandlerDeps;
  providerUserId: string;
  providerGroupId: string;
  change: "added" | "removed";
}): Promise<void> {
  const { event, scimDirectory, deps, providerUserId, providerGroupId, change } = input;
  const orgId = scimDirectory.orgId;
  const userState = await deps.getScimUserState({ scimDirectoryId: scimDirectory.id, providerUserId });
  if (!userState || !userState.active) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.group.membership_changed", "scim_user", providerUserId, {
      eventType: event.event,
      change,
      providerGroupId,
      scimDirectoryId: scimDirectory.id,
      roleRecomputed: false,
    });
    return;
  }
  const derivedRole = await resolveDerivedRole({
    orgId,
    scimDirectoryId: scimDirectory.id,
    providerUserId,
    defaultRole: scimDirectory.defaultRole,
    deps,
  });
  const lowerEmail = userState.email.toLowerCase();
  await deps.upsertMembershipByEmail({ orgId, email: lowerEmail, role: derivedRole, invitedBy: SCIM_ACTOR });
  await deps.audit(orgId, SCIM_ACTOR, "scim.group.membership_changed", "scim_user", providerUserId, {
    eventType: event.event,
    change,
    providerGroupId,
    scimDirectoryId: scimDirectory.id,
    email: lowerEmail,
    derivedRole,
    roleRecomputed: true,
  });
}

/* ----------------------------- group events ------------------------------ */

// Membership events rely on the top-level event-id replay guard for
// idempotency (an exact replay never reaches these handlers) and on the
// idempotent `scim_user_groups` join (ON CONFLICT DO NOTHING). They do NOT
// carry a per-membership out-of-order guard the way the user handlers do —
// the join table has no `lastEventTimestamp`, so the derived role reflects
// whatever join rows currently exist (eventual consistency). The blast
// radius of a reordered add/remove pair is a stale role one rank off until
// the next membership event corrects it; it can never escalate a user
// beyond an admin-configured mapping, so this is an accepted v1 posture.

async function handleGroupUserAdded(input: {
  event: ScimEvent;
  scimDirectory: ScimDirectoryRow;
  deps: ScimHandlerDeps;
}): Promise<ScimHandlerResult> {
  const { event, scimDirectory, deps } = input;
  const orgId = scimDirectory.orgId;
  const providerUserId = stringField(event.data, "user_id");
  const providerGroupId = stringField(event.data, "directory_group_id");
  if (!providerUserId || !providerGroupId) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.malformed_payload", "scim_event", event.id, {
      eventType: event.event,
    });
    return { processed: false, reason: "malformed_payload" };
  }
  // Persist the membership FIRST so the recompute sees the new group.
  await deps.addScimUserGroup({ orgId, scimDirectoryId: scimDirectory.id, providerUserId, providerGroupId });
  await recomputeMemberRole({ event, scimDirectory, deps, providerUserId, providerGroupId, change: "added" });
  return { processed: true, action: "group_membership_added" };
}

async function handleGroupUserRemoved(input: {
  event: ScimEvent;
  scimDirectory: ScimDirectoryRow;
  deps: ScimHandlerDeps;
}): Promise<ScimHandlerResult> {
  const { event, scimDirectory, deps } = input;
  const orgId = scimDirectory.orgId;
  const providerUserId = stringField(event.data, "user_id");
  const providerGroupId = stringField(event.data, "directory_group_id");
  if (!providerUserId || !providerGroupId) {
    await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.malformed_payload", "scim_event", event.id, {
      eventType: event.event,
    });
    return { processed: false, reason: "malformed_payload" };
  }
  // Drop the membership FIRST so the recompute excludes the removed group
  // (a removal may lower the role back toward `defaultRole`).
  await deps.removeScimUserGroup({ orgId, scimDirectoryId: scimDirectory.id, providerUserId, providerGroupId });
  await recomputeMemberRole({ event, scimDirectory, deps, providerUserId, providerGroupId, change: "removed" });
  return { processed: true, action: "group_membership_removed" };
}

async function handleGroupUpsert(input: {
  event: ScimEvent;
  scimDirectory: ScimDirectoryRow;
  deps: ScimHandlerDeps;
}): Promise<ScimHandlerResult> {
  const { event, scimDirectory, deps } = input;
  const providerGroupId = stringField(event.data, "id");
  const name = stringField(event.data, "name");
  if (!providerGroupId || !name) {
    await deps.audit(scimDirectory.orgId, SCIM_ACTOR, "scim.webhook.malformed_payload", "scim_event", event.id, {
      eventType: event.event,
    });
    return { processed: false, reason: "malformed_payload" };
  }
  await deps.upsertScimGroupState({
    orgId: scimDirectory.orgId,
    scimDirectoryId: scimDirectory.id,
    providerGroupId,
    name,
  });
  await deps.audit(scimDirectory.orgId, SCIM_ACTOR, "scim.group.synced", "scim_group", providerGroupId, {
    eventType: event.event,
    name,
    scimDirectoryId: scimDirectory.id,
  });
  return { processed: true, action: "group_synced" };
}

async function handleGroupDeleted(input: {
  event: ScimEvent;
  scimDirectory: ScimDirectoryRow;
  deps: ScimHandlerDeps;
}): Promise<ScimHandlerResult> {
  const { event, scimDirectory, deps } = input;
  const providerGroupId = stringField(event.data, "id");
  if (!providerGroupId) {
    await deps.audit(scimDirectory.orgId, SCIM_ACTOR, "scim.webhook.malformed_payload", "scim_event", event.id, {
      eventType: event.event,
    });
    return { processed: false, reason: "malformed_payload" };
  }
  const existing = await deps.getScimGroupState({
    scimDirectoryId: scimDirectory.id,
    providerGroupId,
  });
  if (existing) await deps.deleteScimGroupState({ id: existing.id });
  // Capture affected users before deleting the join rows, then recompute after
  // cleanup so active members immediately lose roles derived from the deleted
  // group. Orphan-tolerant by design (no FK) — users without active state only
  // receive a roleRecomputed:false audit from the recompute helper.
  const affectedUserIds = await deps.listScimUserIdsForGroup({
    orgId: scimDirectory.orgId,
    scimDirectoryId: scimDirectory.id,
    providerGroupId,
  });
  await deps.deleteScimUserGroupsForGroup({
    orgId: scimDirectory.orgId,
    scimDirectoryId: scimDirectory.id,
    providerGroupId,
  });
  for (const providerUserId of affectedUserIds) {
    await recomputeMemberRole({ event, scimDirectory, deps, providerUserId, providerGroupId, change: "removed" });
  }
  await deps.audit(scimDirectory.orgId, SCIM_ACTOR, "scim.group.synced", "scim_group", providerGroupId, {
    eventType: event.event,
    deleted: true,
    scimDirectoryId: scimDirectory.id,
  });
  return { processed: true, action: "group_deleted" };
}

/* ------------------------------ helpers ---------------------------------- */

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function primaryEmail(data: Record<string, unknown>): string | undefined {
  const directEmail = stringField(data, "email");
  if (directEmail) return directEmail;

  const emails = data.emails;
  const fromEmails = primaryEmailFromArray(emails);
  if (fromEmails) return fromEmails;

  const customAttributes = data.custom_attributes;
  if (customAttributes && typeof customAttributes === "object") {
    return primaryEmailFromArray((customAttributes as Record<string, unknown>).emails);
  }

  return undefined;
}

function primaryEmailFromArray(emails: unknown): string | undefined {
  if (!Array.isArray(emails)) return undefined;
  const primary = emails.find((e) => {
    if (!e || typeof e !== "object") return false;
    const o = e as Record<string, unknown>;
    return o.primary === true && typeof o.value === "string";
  });
  if (primary && typeof (primary as { value: unknown }).value === "string") {
    return (primary as { value: string }).value;
  }
  // Fall back to first email if no `primary: true` flag
  const first = emails.find((e) => e && typeof e === "object" && typeof (e as { value: unknown }).value === "string");
  return first ? (first as { value: string }).value : undefined;
}

function parseEventTimestamp(s: string): Date | null {
  const t = new Date(s);
  return Number.isFinite(t.getTime()) ? t : null;
}

function coerceTimestamp(t: Date | string | null): Date | null {
  if (!t) return null;
  if (t instanceof Date) return t;
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Re-export the role enum so route handlers can reuse it without
// importing the repo module.
export type { ScimDefaultRole };
