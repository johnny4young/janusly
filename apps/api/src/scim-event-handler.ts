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

import type { ScimDirectoryRow, ScimDefaultRole } from "@janusly/data/src/scimDirectoriesRepo";

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
};

export type ScimHandlerResult =
  | { processed: true; action: string }
  | { processed: false; reason: string };

const SCIM_ACTOR = "scim:webhook";

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
      case "dsync.group.user_removed":
        // v1: state is captured by user + group event handlers; group
        // membership transitions don't alter Janusly role yet.
        await deps.audit(orgId, SCIM_ACTOR, "scim.group.synced", "scim_event", event.id, {
          eventType: event.event,
          scimDirectoryId: scimDirectory.id,
        });
        result = { processed: true, action: "noop" };
        break;
      default:
        await deps.audit(orgId, SCIM_ACTOR, "scim.webhook.unknown_event", "scim_event", event.id, {
          eventType: event.event,
        });
        result = { processed: false, reason: "unknown_event" };
    }
  } catch (err) {
    try {
      await deps.deleteProcessedEvent({ eventId: event.id });
    } catch {
      // Best-effort release; swallow secondary failures.
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
  await deps.upsertMembershipByEmail({
    orgId,
    email: lowerEmail,
    role: scimDirectory.defaultRole,
    invitedBy: SCIM_ACTOR,
  });

  await deps.audit(orgId, SCIM_ACTOR, "scim.user.provisioned", "scim_user", providerUserId, {
    email: lowerEmail,
    role: scimDirectory.defaultRole,
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
  await deps.upsertMembershipByEmail({
    orgId,
    email: lowerEmail,
    role: scimDirectory.defaultRole,
    invitedBy: SCIM_ACTOR,
  });

  await deps.audit(orgId, SCIM_ACTOR, "scim.user.updated", "scim_user", providerUserId, {
    email: lowerEmail,
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

/* ----------------------------- group events ------------------------------ */

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
