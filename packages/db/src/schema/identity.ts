/**
 * SSO, session, and SCIM identity synchronization tables.
 *
 * Re-exported through `../schema.ts`; consumers should use `@janusly/db`.
 */

import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Per-org list of email domains pre-authorized to auto-join the org on first
 * Supabase sign-in. When a user authenticates with an email whose domain
 * matches a row here AND the target org matches the principal's hint, the
 * resolver creates an `org_members` row with `defaultRole` (typically
 * `viewer`).
 *
 * Multi-tenant scope: every read carries `eq(verifiedDomains.orgId, orgId)`.
 * Unique `(orgId, domain)` so an org can't have duplicate domain rows.
 */
export const verifiedDomains = pgTable(
  "verified_domains",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    domain: text("domain").notNull(),
    defaultRole: text("default_role").notNull().default("viewer"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("verified_domains_org_domain_idx").on(table.orgId, table.domain),
  ],
);

/**
 * Per-org SSO connection metadata for enterprise identity providers
 * (currently a placeholder for WorkOS; the connection-id maps an org to its
 * IdP). The membership resolver consults this table as a JIT (just-in-time)
 * provisioning seam: a Supabase principal with no membership + no invitation
 * + no verified-domain match, when the target org has an active SSO row,
 * returns null (the resolver fails closed). The WorkOS extractor that ships
 * later runs its own JIT-provisioning code path BEFORE the resolver, so a
 * properly-authenticated SSO user gets here with a membership already
 * upserted.
 *
 * Status enum is `active | revoked`. Multi-tenant scope on every read.
 */
export const ssoConnections = pgTable(
  "sso_connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    providerConnectionId: text("provider_connection_id").notNull(),
    status: text("status").notNull().default("active"),
    /**
     * When true, the membership resolver rejects every non-SSO auth mode
     * for this org (supabase / dev-headers).
     * Service-token mode bypasses the check (infrastructure callers).
     * The dev escape hatch is `ALLOW_DEV_SSO_BYPASS=true` — without it
     * the gate fires even outside production, so staging-on-prod
     * misconfigs fail closed instead of silently bypassing.
     */
    enforcedSso: boolean("enforced_sso").notNull().default(false),
    configJson: jsonb("config_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("sso_connections_org_provider_idx").on(table.orgId, table.provider),
  ],
);

/**
 * One-time-use nonces for SSO state tokens. The `/auth/sso/start` route
 * issues an HMAC-signed state carrying a fresh nonce; the callback
 * route DELETE-and-checks the row. A row that's missing OR past
 * `expiresAt` fails the consume call and the callback fails closed.
 *
 * Pruning is not automated — expired rows are harmless (the verifier
 * checks `expiresAt > now` before honoring) and the table is small
 * (only as wide as concurrent in-flight SSO logins per org). A periodic
 * retention sweep may prune them without affecting verification.
 *
 * Multi-tenant scope: every read carries `eq(ssoStateNonces.orgId, orgId)`.
 */
export const ssoStateNonces = pgTable(
  "sso_state_nonces",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("sso_state_nonces_org_nonce_idx").on(table.orgId, table.nonce),
  ],
);

/**
 * Revocable browser sessions issued after WorkOS SSO. The signed cookie
 * carries only this row's id; identity, organization, expiry, and revocation
 * state remain server-side and are checked on every request.
 *
 * No foreign keys by the repository's orphan-tolerant policy. Revoking or
 * deleting an organization never silently rewrites historical session rows;
 * membership resolution still fails closed when the grant disappears.
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    orgId: text("org_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("auth_sessions_user_expiry_idx").on(table.userId, table.expiresAt),
  ],
);

/**
 * Per-org WorkOS-backed Directory Sync connection. One row attaches a
 * WorkOS directory id to an org so inbound SCIM webhook events can be
 * scoped to a tenant. The provider_directory_id is what WorkOS sends
 * us inside every event payload; we look it up here to derive `orgId`
 * — never trust the upstream payload's tenancy hint.
 *
 * `defaultRole` is the role applied to every SCIM-provisioned user
 * (per-group role mapping is a future v2 surface). `status = 'active'`
 * or `'revoked'`; revoked directories ignore inbound events.
 *
 * Unique on `orgId` (one directory per org for v1) AND on
 * `providerDirectoryId` (a WorkOS directory id maps to exactly one
 * Janusly org).
 */
export const scimDirectories = pgTable(
  "scim_directories",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    providerDirectoryId: text("provider_directory_id").notNull(),
    directoryType: text("directory_type"),
    defaultRole: text("default_role").notNull().default("viewer"),
    status: text("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_directories_org_idx").on(table.orgId),
    uniqueIndex("scim_directories_provider_directory_idx").on(table.providerDirectoryId),
  ],
);

/**
 * Per-(directory, IdP-side user) state for SCIM lifecycle ops. The
 * `providerUserId` is the WorkOS `directory_user.id` (stable across
 * email changes); `email` carries the user's current address and is
 * the join key into `org_members` (which uses `lower(email)` as
 * `userId` for SCIM-provisioned rows, mirroring the legacy-orphan
 * placeholder shape invitations use today). `active=false` marks a
 * user the IdP has deprovisioned — the resurrection guard refuses to
 * re-create membership for a deactivated row with an older event
 * timestamp.
 *
 * `lastEventTimestamp` is the newest event applied to this user; the
 * out-of-order guard rejects events with `created_at <= last`.
 */
export const scimUserState = pgTable(
  "scim_user_state",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    scimDirectoryId: text("scim_directory_id").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    active: boolean("active").notNull().default(true),
    lastEventId: text("last_event_id"),
    lastEventTimestamp: timestamp("last_event_timestamp", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_user_state_directory_user_idx").on(table.scimDirectoryId, table.providerUserId),
    index("scim_user_state_org_email_idx").on(table.orgId, table.email),
  ],
);

/**
 * Per-(directory, IdP-side group) state. Captures group existence +
 * name mirrored from the IdP. Consulted (with `scim_group_role_mappings`
 * + `scim_user_groups`) to derive a member's role from their groups.
 */
export const scimGroupState = pgTable(
  "scim_group_state",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    scimDirectoryId: text("scim_directory_id").notNull(),
    providerGroupId: text("provider_group_id").notNull(),
    name: text("name").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_group_state_directory_group_idx").on(table.scimDirectoryId, table.providerGroupId),
  ],
);

/**
 * Operator-configured IdP-group → Janusly-role mapping (SCIM v2). When a
 * SCIM-provisioned user belongs to one or more mapped groups, their role
 * is the HIGHEST-rank mapped role (viewer < editor < admin); with no
 * mapped group the directory's `defaultRole` applies. `role` is a
 * built-in role name only — custom-role mapping is a future follow-up.
 * Unique per `(directory, group)`; one role per group.
 */
export const scimGroupRoleMappings = pgTable(
  "scim_group_role_mappings",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    scimDirectoryId: text("scim_directory_id").notNull(),
    providerGroupId: text("provider_group_id").notNull(),
    role: text("role").notNull(),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_group_role_mappings_directory_group_idx").on(table.scimDirectoryId, table.providerGroupId),
    index("scim_group_role_mappings_org_idx").on(table.orgId),
  ],
);

/**
 * User↔group membership mirror for SCIM v2 role derivation, maintained
 * by the `dsync.group.user_added` / `_removed` events. Keyed by the
 * WorkOS `directory_user.id` (providerUserId) + `directory_group.id`
 * (providerGroupId). No FK — orphan-tolerant like the rest of the SCIM
 * module; delete events best-effort clean these rows before re-deriving roles.
 */
export const scimUserGroups = pgTable(
  "scim_user_groups",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    scimDirectoryId: text("scim_directory_id").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    providerGroupId: text("provider_group_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("scim_user_groups_user_group_idx").on(
      table.scimDirectoryId,
      table.providerUserId,
      table.providerGroupId,
    ),
    index("scim_user_groups_directory_user_idx").on(table.scimDirectoryId, table.providerUserId),
  ],
);

/**
 * Idempotency table for SCIM webhook events. Every WorkOS event ID is
 * recorded once; `INSERT … ON CONFLICT DO NOTHING` lets the handler
 * detect replays cheaply. `processedAt` indexed for a future TTL job
 * — at enterprise scale ~10k events/day will grow this table linearly
 * forever without pruning.
 */
export const scimProcessedEvents = pgTable(
  "scim_processed_events",
  {
    eventId: text("event_id").primaryKey(),
    orgId: text("org_id").notNull(),
    scimDirectoryId: text("scim_directory_id").notNull(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("scim_processed_events_processed_at_idx").on(table.processedAt),
  ],
);
