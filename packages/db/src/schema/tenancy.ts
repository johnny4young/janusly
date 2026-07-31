/**
 * Tenant catalogue, membership, configuration, audit, and onboarding tables.
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

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const orgMembers = pgTable(
  "org_members",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    email: text("email"),
    role: text("role").notNull().default("viewer"),
    invitedBy: text("invited_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("org_members_org_user_idx").on(table.orgId, table.userId)],
);

export const orgConfigs = pgTable(
  "org_configs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    key: text("key").notNull(),
    valueJson: jsonb("value_json").notNull(),
    category: text("category").notNull(),
    description: text("description").notNull(),
    valueType: text("value_type").notNull(),
    source: text("source").notNull().default("tenant"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("org_configs_org_key_idx").on(table.orgId, table.key),
    index("org_configs_org_category_idx").on(table.orgId, table.category),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // Legal-hold bypass for the retention sweep — see `run_events.holdUntil`.
    // The retention floor on audit_logs is 365 days; a hold freezes a row
    // referenced by an active compliance investigation past that floor.
    holdUntil: timestamp("hold_until", { withTimezone: true }),
  },
  (table) => [
    // Backs the unfiltered `GET /audit` keyset (`ORDER BY created_at DESC,
    // id DESC`). `.nullsFirst()` is load-bearing: `created_at` is nullable and
    // a plain `ORDER BY created_at DESC` means NULLS FIRST, so drizzle's
    // default DESC NULLS LAST index cannot satisfy the sort and the planner
    // re-sorts the org's audit history on every page.
    index("audit_logs_org_created_id_idx").on(
      table.orgId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // Backs the audit viewer's action-PREFIX filter
    // (`queryAuditLogs`: `action LIKE 'prefix%'`). A plain btree can't serve
    // `LIKE` under the default collation, so the migration SQL appends the
    // `text_pattern_ops` opclass to the `action` column by hand (drizzle's
    // builder can't emit an opclass — same pattern as the GIN index below).
    // With an EXACT action match (e.g. the budget-gate dedup read) the
    // NULLS FIRST tail also serves `ORDER BY created_at DESC[, id DESC]`
    // index-ordered; a multi-action prefix range still filters via the range
    // scan and re-sorts only the bounded matches.
    index("audit_logs_org_action_created_id_idx").on(
      table.orgId,
      table.action,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // GIN over the jsonb metadata column for containment lookups
    // such as the rate-limit-degradation dedup gate
    // (`metadata @> '{"bucket":"..."}'`). jsonb_path_ops keeps the
    // index ~30% narrower than the default jsonb_ops opclass; we
    // do not need `?` / `?|` queries today. The production rollout
    // SQL must add the `jsonb_path_ops` opclass by hand — drizzle's
    // .using('gin', ...) does not emit it.
    index("audit_logs_metadata_gin_idx").using("gin", table.metadata),
  ],
);

/**
 * Pending / accepted email-based invitations to an organization.
 *
 * The membership resolver in `apps/api/src/auth.ts` reads `status = 'pending'`
 * rows on a Supabase sign-in: when the authenticated user's email matches a
 * pending row for the target org, the resolver flips the status to `accepted`
 * and creates the corresponding `org_members` row atomically. Status enum is
 * `pending | accepted | revoked` — `revoked` rows are kept for audit but
 * don't participate in resolution.
 *
 * Multi-tenant scope: every read carries `eq(invitations.orgId, orgId)`.
 * Unique `(orgId, email)` keeps the invite catalogue tidy — re-inviting an
 * email that's already invited is a no-op at the repo layer.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("viewer"),
    invitedBy: text("invited_by"),
    status: text("status").notNull().default("pending"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("invitations_org_email_idx").on(table.orgId, table.email),
  ],
);

/**
 * Per-org role catalog: built-in role overrides + custom roles.
 *
 * The default `viewer`/`editor`/`admin` triad is VIRTUAL — no row exists
 * for a built-in until an admin overrides its permission set. Custom
 * roles (`compliance`, `ops-readonly`, etc.) ALWAYS have a row.
 *
 * `inheritsFrom` is the closed built-in name the role's RANK
 * inherits from; preserves back-compat with `requireRole(min)` which
 * uses the rank ordinal (`viewer=1`, `editor=2`, `admin=3`). Custom
 * roles default to `inheritsFrom: "viewer"` (fail-closed).
 * `inheritsFrom` is immutable on built-ins (`admin` always inherits
 * from `admin`).
 *
 * `grantedPermissions` is the explicit permission set:
 *  - Built-ins: NULL means "fall back to PERMISSION_CATALOG defaults".
 *    Non-null replaces defaults entirely.
 *  - Custom roles: MUST be non-null at creation.
 *
 * Unique on `(orgId, name)`. The membership resolver consults this
 * table when `org_members.role` is not one of the 3 built-ins.
 */
export const orgRoles = pgTable(
  "org_roles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    inheritsFrom: text("inherits_from").notNull(),
    description: text("description"),
    isBuiltin: boolean("is_builtin").notNull().default(false),
    grantedPermissions: jsonb("granted_permissions"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("org_roles_org_name_idx").on(table.orgId, table.name),
  ],
);

/**
 * Onboarding progress — a thin per-`(orgId, userId)` cache backing the
 * "first recovered run" guided checklist. The row is NOT the source of
 * truth for milestone completion: `GET /onboarding` derives each milestone
 * live from durable org-state (a `credentials` row, a `succeeded` run, a
 * `dead_letters` row, a replayed/resolved DLQ row, a `workflow.pack_imported`
 * audit row). The six advanceable milestones therefore need no per-step
 * write site — they are read off existing tables.
 *
 * What this row persists:
 * - `step` — the monotonic high-water mark (one of the closed
 *   `ONBOARDING_STEPS`). It provides hysteresis: a milestone the user already
 *   reached never visually un-checks if a derived signal later regresses
 *   (e.g. a DLQ row purged by retention). Effective per-step done =
 *   derived OR high_water_index >= step_index.
 * - `status` — `active` / `skipped` / `completed`. The `completed` transition
 *   is a CAS (`UPDATE … WHERE status<>'completed' RETURNING *`) so a single
 *   `onboarding.completed` audit fires even under parallel reads.
 *
 * Orphan-tolerant (no cascade): deleting an org leaves the row; a re-created
 * org with the same id inherits the prior progress.
 */
export const onboardingProgress = pgTable(
  "onboarding_progress",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** Monotonic high-water mark — one of the closed `ONBOARDING_STEPS`. */
    step: text("step").notNull().default("org_created"),
    /** Lifecycle status — `active` / `skipped` / `completed`. */
    status: text("status").notNull().default("active"),
    /** Set when the user skips; cleared on resume. */
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    /** Set once, via CAS, when all six milestones are reached. */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * Restart epoch. When set, milestone derivation only counts org activity
     * with `created_at >= restarted_at` — so an operator can replay the whole
     * onboarding flow on the same tenant (the prior credential / pack / run /
     * failure / recovery no longer count). Null = normal (all activity counts).
     */
    restartedAt: timestamp("restarted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One onboarding row per user per org; the idempotent-create + CAS paths
    // rely on this unique index.
    uniqueIndex("onboarding_progress_org_user_idx").on(table.orgId, table.userId),
  ],
);
