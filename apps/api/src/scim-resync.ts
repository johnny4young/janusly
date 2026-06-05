/**
 * Bulk SCIM role re-sync — applies the CURRENT group→role mappings to every
 * active member of a directory on demand, instead of waiting for each user's
 * next inbound SCIM event to lazily re-derive their role.
 *
 * Pure orchestrator: all I/O is injected via `ScimResyncDeps` so the logic is
 * unit-testable without Postgres (mirrors `handleScimEvent`). It reuses the
 * exported `deriveScimRole` — the SAME derivation the webhook handlers run —
 * so a re-sync only ever writes the role the next event would have produced;
 * it never invents a new authority path (the IdP group membership + the
 * admin-configured mapping remain the grant). Per-user failures are isolated
 * (counted in `skipped`) so one bad row doesn't abort the whole sweep.
 *
 * Used by `apps/api/src/routes/scim-routes.ts` (POST /org/scim/resync).
 */

import { SCIM_RESYNC_MAX_MEMBERS, type ScimDirectoryRow } from "@janusly/data";
import { deriveScimRole } from "./scim-event-handler";

/** One member whose role changed during a re-sync sweep. `from` is null when
 *  the member had no `org_members` row yet (re-sync self-heals it). */
export type ScimResyncChange = {
  providerUserId: string;
  email: string;
  from: string | null;
  to: string;
};

/**
 * Outcome of a bulk re-sync. `membersResynced` is every active member the
 * sweep wrote (idempotent — most writes are no-ops); `membersChanged` is the
 * subset whose role actually moved; `skipped` counts per-user failures the
 * sweep tolerated; `capped` is true when the active-member count hit the cap
 * (a larger directory needs a queue-backed sweep — a follow-up).
 */
export type ScimResyncResult = {
  membersResynced: number;
  membersChanged: number;
  skipped: number;
  capped: boolean;
  changes: ScimResyncChange[];
};

/** Injected I/O surface — every reader is org/directory-scoped at the call site. */
export type ScimResyncDeps = {
  listActiveScimUserState: (
    orgId: string,
    scimDirectoryId: string,
  ) => Promise<Array<{ providerUserId: string; email: string }>>;
  getScimGroupRoleMappingsMap: (orgId: string, scimDirectoryId: string) => Promise<Map<string, string>>;
  listScimUserGroupIds: (input: {
    orgId: string;
    scimDirectoryId: string;
    providerUserId: string;
  }) => Promise<string[]>;
  findMemberByEmail: (input: { orgId: string; email: string }) => Promise<{ role: string } | null>;
  upsertMembershipByEmail: (input: {
    orgId: string;
    email: string;
    role: string;
    invitedBy?: string | null;
  }) => Promise<unknown>;
};

/**
 * Re-derive and re-write the role of every active member of `scimDirectory`
 * from the current group→role mappings. Fetches the mappings map ONCE and
 * reuses it across members. Does NOT pass `invitedBy` to the membership
 * upsert so the original provisioning actor is preserved on the row.
 */
export async function resyncScimMemberRoles(input: {
  scimDirectory: ScimDirectoryRow;
  deps: ScimResyncDeps;
  /** Override the cap used to compute the `capped` flag (defaults to the repo
   *  cap). The underlying reader applies its own hard `.limit`. */
  cap?: number;
}): Promise<ScimResyncResult> {
  const { scimDirectory, deps } = input;
  const orgId = scimDirectory.orgId;
  const cap = input.cap ?? SCIM_RESYNC_MAX_MEMBERS;

  const [members, mappings] = await Promise.all([
    deps.listActiveScimUserState(orgId, scimDirectory.id),
    deps.getScimGroupRoleMappingsMap(orgId, scimDirectory.id),
  ]);

  const result: ScimResyncResult = {
    membersResynced: 0,
    membersChanged: 0,
    skipped: 0,
    capped: members.length >= cap,
    changes: [],
  };

  for (const member of members) {
    try {
      const lowerEmail = member.email.toLowerCase();
      const groupIds = await deps.listScimUserGroupIds({
        orgId,
        scimDirectoryId: scimDirectory.id,
        providerUserId: member.providerUserId,
      });
      const newRole = deriveScimRole(groupIds, mappings, scimDirectory.defaultRole);
      const current = (await deps.findMemberByEmail({ orgId, email: lowerEmail }))?.role ?? null;
      // Idempotent: re-writes the same role most of the time. `invitedBy`
      // intentionally omitted so the original provisioning actor survives.
      await deps.upsertMembershipByEmail({ orgId, email: lowerEmail, role: newRole });
      result.membersResynced += 1;
      if (current !== newRole) {
        result.membersChanged += 1;
        result.changes.push({ providerUserId: member.providerUserId, email: lowerEmail, from: current, to: newRole });
      }
    } catch {
      // Per-user blip (a read/write fault) is isolated — skip and keep
      // sweeping; the operator can re-run. Mirrors the SCIM module's
      // orphan-tolerant posture.
      result.skipped += 1;
    }
  }

  return result;
}
