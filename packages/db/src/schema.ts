/**
 * Janusly database schema — the canonical Drizzle declaration for every
 * Postgres table the system owns.
 *
 * This file is the single source of truth. Migrations under
 * `packages/db/migrations/` are generated from these declarations via
 * `pnpm --filter @janusly/db db:generate`; AGENTS.md forbids hand-rolling
 * migrations or reintroducing a runtime `CREATE TABLE IF NOT EXISTS`
 * bootstrap.
 *
 * Used by:
 * - Every Drizzle query across `packages/data`, `packages/engine`, `apps/api`.
 * - `packages/db/migrations/0000_tranquil_gravity.sql` — the initial migration
 *   was emitted from this exact shape.
 *
 * Tables:
 * - `organizations`, `users`, `org_members` — multi-tenant scope.
 * - `org_configs` — tenant-level runtime configuration overrides.
 * - `workflows`, `workflow_versions` — versioned DAG storage.
 * - `runs`, `run_nodes`, `run_events` — execution history (timeline events
 *   are paginated by `(run_id, created_at)`).
 * - `dead_letters` — DLQ rows; replayed via `POST /dlq/replay`.
 * - `routing_stats`, `workflow_improvements` — RL counters and
 *   improvement-engine bookkeeping.
 * - `usage_events` — billing telemetry (LLM calls and write-side tool usage).
 * - `credentials`, `installed_plugins` — secret references and plugin
 *   manifests.
 * - `audit_logs` — append-only mutation log (`audit()` redacts sensitive
 *   keys before insertion).
 *
 * Invariants:
 * - Every timestamp is `TIMESTAMPTZ` (the `withTimezone: true` option). Don't
 *   omit the option — the migration would suggest an `ALTER COLUMN`.
 * - Index names match the legacy `schema-management.ts` byte-for-byte so
 *   `\d+ <table>` shows the same shape after migrate as before.
 * - `org_id` is `NOT NULL` on every business table so multi-tenant scoping
 *   queries can rely on it without null guards.
 */

import { pgTable, text, jsonb, timestamp, integer, real, boolean, index, uniqueIndex, vector } from "drizzle-orm/pg-core";

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
  orgId: text("org_id").notNull(),
  email: text("email"),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
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

export const workflows = pgTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("default"),
    name: text("name").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("workflows_org_created_idx").on(table.orgId, table.createdAt.desc())],
);

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("default"),
    workflowId: text("workflow_id").notNull(),
    version: integer("version").notNull(),
    dagJson: jsonb("dag_json").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_versions_org_workflow_version_idx").on(table.orgId, table.workflowId, table.version),
    index("workflow_versions_org_workflow_created_idx").on(table.orgId, table.workflowId, table.createdAt.desc()),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("default"),
    workflowVersionId: text("workflow_version_id").notNull(),
    status: text("status").notNull(),
    inputJson: jsonb("input_json"),
    /**
     * Projected workflow output, computed once at terminal `succeeded`
     * status by `computeRunOutputs`. NULL for runs without a
     * declared `workflow.outputs` projection map, and for runs that haven't
     * reached `succeeded` yet (failed/cancelled runs never populate this).
     */
    outputJson: jsonb("output_json"),
    /**
     * Subworkflow linkage. Non-null = this run was spawned by a `subworkflow`
     * node in a parent run. Used by `notifyParentOnTerminal` to flip the
     * parent's subworkflow node when the child reaches a terminal status.
     */
    parentRunId: text("parent_run_id"),
    /** Node id within the parent that spawned this child run. Pairs with `parentRunId`. */
    parentNodeId: text("parent_node_id"),
    /**
     * OTel trace id shared across a subworkflow chain. Inherited from the
     * parent on `subworkflow` calls; generated lazily when the chain starts.
     * Column is NULL for top-level runs that aren't part of a subworkflow chain.
     */
    traceId: text("trace_id"),
    /**
     * Optional replay-mode tag. NULL for production runs; `"validation"`
     * for sandbox runs created by the recovery dialog's "Validating fix…"
     * step before the operator commits the patched workflow. Validation
     * runs are intentionally excluded from health, cluster, and recovery
     * metric rollups so they don't pollute production signals. Engine
     * executors read this through `NodeContext.dryRun` and gate
     * write-side actions (HTTP non-safe methods, tools flagged
     * `writeSide`) when set.
     */
    replayMode: text("replay_mode"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("runs_org_created_idx").on(table.orgId, table.createdAt.desc()),
    index("runs_parent_idx").on(table.parentRunId),
    index("runs_org_replay_mode_idx").on(table.orgId, table.replayMode),
  ],
);

export const runNodes = pgTable(
  "run_nodes",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    status: text("status").notNull(),
    stateJson: jsonb("state_json"),
    attempts: integer("attempts").default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorJson: jsonb("error_json"),
  },
  (table) => [uniqueIndex("run_nodes_run_node_idx").on(table.runId, table.nodeId)],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    nodeId: text("node_id"),
    type: text("type").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("run_events_run_created_idx").on(table.runId, table.createdAt)],
);

export const deadLetters = pgTable(
  "dead_letters",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("default"),
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    attempt: integer("attempt").notNull().default(1),
    workflowJson: jsonb("workflow_json").notNull(),
    nodeJson: jsonb("node_json").notNull(),
    errorJson: jsonb("error_json").notNull(),
    status: text("status").notNull().default("open"),
    replayedAt: timestamp("replayed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("dead_letters_org_status_idx").on(table.orgId, table.status, table.createdAt.desc())],
);

export const routingStats = pgTable(
  "routing_stats",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    nodeId: text("node_id").notNull(),
    pulls: integer("pulls").notNull().default(0),
    value: real("value").notNull().default(0),
    meanReward: real("mean_reward").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("routing_stats_org_node_idx").on(table.orgId, table.nodeId)],
);

export const workflowImprovements = pgTable(
  "workflow_improvements",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    baseVersion: integer("base_version"),
    newVersion: integer("new_version"),
    action: jsonb("action"),
    reason: text("reason"),
    beforeMetrics: jsonb("before_metrics"),
    afterMetrics: jsonb("after_metrics"),
    confidence: real("confidence").notNull().default(0),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("workflow_improvements_org_workflow_idx").on(table.orgId, table.workflowId, table.createdAt.desc())],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    runId: text("run_id"),
    metric: text("metric").notNull(),
    quantity: integer("quantity").notNull().default(1),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("usage_events_org_metric_idx").on(table.orgId, table.metric)],
);

export const credentials = pgTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    secretRef: text("secret_ref").notNull(),
    metadata: jsonb("metadata"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [index("credentials_org_idx").on(table.orgId)],
);

export const installedPlugins = pgTable(
  "installed_plugins",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    configJson: jsonb("config_json"),
    installedBy: text("installed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex("installed_plugins_org_plugin_idx").on(table.orgId, table.pluginId)],
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
  },
  (table) => [index("audit_logs_org_created_idx").on(table.orgId, table.createdAt.desc())],
);

/**
 * Cron-driven trigger entries for `schedule` nodes.
 *
 * One row per `(orgId, workflowVersionId, nodeId)` whose `schedule` node
 * the operator authored. The companion BullMQ repeatable job (keyed by a
 * deterministic id derived from the same triple) is the trigger; this row
 * is the persistent source of truth so cold-starts and Redis losses can
 * idempotently re-register the job.
 *
 * Multi-tenant scope: every row carries `org_id`; the unique index is
 * `(org_id, workflow_version_id, node_id)` so concurrent saves of the same
 * workflow version never duplicate. The secondary indexes support
 * per-org enabled and per-workflow lookups; worker cold-start replay is
 * the deliberate process-level scan of enabled rows across every org.
 *
 * `enabled` is the pause mechanism: re-saving the workflow with
 * `schedule.config.enabled = false` flips this flag and removes the
 * BullMQ job. `enabled = true` re-registers it.
 *
 * `lastRunAt` / `lastRunId` are bookkeeping for the operator (when did
 * the schedule last fire? which run did it spawn?). They're not load-
 * bearing for any trigger logic — the BullMQ repeatable-jobs metadata
 * is the authoritative "next fire" time.
 */
export const scheduleEntries = pgTable(
  "schedule_entries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    workflowVersionId: text("workflow_version_id").notNull(),
    nodeId: text("node_id").notNull(),
    cronExpression: text("cron_expression").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunId: text("last_run_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("schedule_entries_org_version_node_idx").on(
      table.orgId,
      table.workflowVersionId,
      table.nodeId,
    ),
    index("schedule_entries_org_enabled_idx").on(table.orgId, table.enabled),
    index("schedule_entries_org_workflow_idx").on(table.orgId, table.workflowId),
  ],
);

/**
 * Operator to system feedback channel for the recovery loop.
 *
 * Every time an operator acts on an AI-suggested patch in the Recovery
 * dialog (Apply / Cancel / Iterate), the dialog posts a row here. Future
 * patch suggestions for the SAME workflow read back an aggregated
 * summary of these decisions and slip it into the LLM prompt as soft
 * prior, so an approach that the operator has rejected multiple times
 * for this workflow gets deprioritized in subsequent suggestions. This
 * is the labeled signal a future eval framework can train against.
 *
 * Multi-tenant scope: every row carries `org_id`; both indexes lead with
 * `org_id` so the read-side aggregation never scans across tenants.
 *
 * `comment` is operator free-text, sanitized through `scrubSecretShapes`
 * in the data repo at write time so a leaked secret in the comment becomes
 * `[redacted]` before it lands.
 */
export const recoveryFeedback = pgTable(
  "recovery_feedback",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    deadLetterId: text("dead_letter_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    suggestionMode: text("suggestion_mode").notNull(),
    approachLabel: text("approach_label").notNull(),
    accepted: boolean("accepted").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // Read-side aggregation: list past feedback for this workflow when
    // the patch route enriches a new prompt.
    index("recovery_feedback_org_workflow_idx").on(table.orgId, table.workflowId, table.createdAt.desc()),
    // Direct DLQ-row scoping for per-row audits.
    index("recovery_feedback_org_dlq_idx").on(table.orgId, table.deadLetterId),
  ],
);

/**
 * Per-workflow AI budget overrides.
 *
 * Each row caps monthly USD spend for a single workflow within an org. The
 * org-level budget lives in `org_configs.ai.budgetMonthlyUsd`; a row here is
 * a tighter (or looser) override that wins for that workflow only.
 *
 * Multi-tenant scope: every read carries `eq(workflowBudgets.orgId, orgId)`.
 * Unique on `(orgId, workflowId)` so the upsert path is straightforward.
 *
 * Fail-soft: every read in the budget chokepoint is wrapped — a DB error
 * here returns "no budget" (allowed=true) rather than blocking the run.
 */
export const workflowBudgets = pgTable(
  "workflow_budgets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    monthlyUsd: real("monthly_usd").notNull(),
    warnPercent: integer("warn_percent").notNull().default(80),
    policy: text("policy").notNull().default("warn"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_budgets_org_workflow_idx").on(table.orgId, table.workflowId),
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
 * (only as wide as concurrent in-flight SSO logins per org). A future
 * cleanup ticket can add a periodic sweep.
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
 * Per-(directory, IdP-side group) state. v1 captures group existence
 * + membership so the data is available for future role-mapping; the
 * group's name is mirrored from the IdP. v2 will add an explicit
 * `scim_group_role_mappings` table for operator-configured role
 * overrides per group.
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
 * External MCP servers an admin has registered for an org. Each row is
 * one alias-addressable connection that workflow steps of type
 * `mcp_tool` resolve against. Two transports are supported:
 *
 *  - `stdio`: spawn a local child process via `command` + `args` and
 *    speak JSON-RPC over stdin/stdout. `command` MUST appear in
 *    `JANUSLY_MCP_ALLOWED_COMMANDS` (or the per-org override) — admins
 *    explicitly opt in to executables, not to arbitrary binaries.
 *  - `sse`: open a remote SSE connection to `url`. The URL is checked
 *    through the outbound target-policy validator before the SDK
 *    transport opens. Empty env-vars at connect time fail closed.
 *
 * `envRefs` is a closed-shape JSONB: `Record<string, { kind: "env",
 * name: string }>`. The child process / outbound HTTP receives
 * `process.env[ref.name]` resolved server-side; the connection row
 * never carries actual secret values. For stdio transport the spawn
 * env is a strict whitelist of `{ PATH, ...resolvedEnvRefs }` only —
 * no `process.env` leak so a misconfigured MCP server can't read
 * `DATABASE_URL` / `JANUSLY_RESUME_TOKEN_SECRET`.
 *
 * `status` is the discovery / health state: `pending` (just created,
 * not discovered), `active` (discovered + tools cached), `failed`
 * (discovery threw), `disabled` (admin paused).
 *
 * Multi-tenant scope: every read carries `eq(mcpConnections.orgId, orgId)`.
 * Unique on `(orgId, alias)`. Transport-shape consistency (stdio rows
 * require `command`, sse rows require `url`) is enforced in the repo's
 * `createConnection` / `updateConnection` helpers rather than via a DB
 * CHECK — matching the codebase convention of application-layer
 * validation over DB constraints.
 */
export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    alias: text("alias").notNull(),
    transport: text("transport").notNull(),
    command: text("command"),
    args: jsonb("args"),
    url: text("url"),
    envRefs: jsonb("env_refs"),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status").notNull().default("pending"),
    statusReason: text("status_reason"),
    // Admin opt-in: when true, the connection's enabled tool descriptors
    // (with their sanitised descriptions) get appended to the AI Studio's
    // system prompt at generation time so the LLM can reference them in
    // `noop` placeholders the operator promotes in the Inspector. Default
    // `false` — descriptions come from third-party MCP servers and are
    // a potential prompt-injection vector; admin must explicitly opt in.
    exposeToAi: boolean("expose_to_ai").notNull().default(false),
    lastDiscoveryAt: timestamp("last_discovery_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_connections_org_alias_idx").on(table.orgId, table.alias),
  ],
);

/**
 * Per-tool descriptor cached from the MCP server at discovery time.
 * One row per `(connectionId, name)`. `enabled: false` on creation —
 * the admin opts in per-tool so a 200-tool server doesn't drown the
 * UI and so prompt-injection material from third-party descriptions
 * can't reach the LLM without explicit consent.
 *
 * `inputSchema` is the JSON Schema object the MCP protocol returns;
 * the executor validates input against this before invoking. Failures
 * to discover surface as zero rows for the connection (executor
 * refuses to call without a descriptor).
 *
 * `writeSide` defaults to `true` (fail-safe). Admin marks read-side
 * tools explicitly. The runtime dry-run gate skips write-side MCP
 * tools the same way it skips write-side integration tools.
 *
 * The delete-connection route removes descriptors before deleting the
 * parent connection.
 */
export const mcpToolDescriptors = pgTable(
  "mcp_tool_descriptors",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    inputSchema: jsonb("input_schema"),
    writeSide: boolean("write_side").notNull().default(true),
    enabled: boolean("enabled").notNull().default(false),
    // Per-tool rate-limit override. NULL = use the org default
    // (`org_configs.mcp.clientRateLimitPerMin`, default 60/min). A
    // positive integer overrides the org default for this descriptor
    // only — the `mcp_client.<alias>.<toolname>` bucket inherits the
    // value at execute time. Set / cleared by admins via the existing
    // tool-flags PATCH route; audited as `mcp.tool.rate_limit_set`.
    rateLimitPerMin: integer("rate_limit_per_min"),
    // Per-tool admin opt-in flag for LLM exposure. Default `false`
    // — even when the parent connection has `expose_to_ai: true`, a
    // descriptor only surfaces in `/ai/generate-workflow`'s system
    // prompt when BOTH the connection AND the descriptor flag are
    // `true`. The fail-safe default forces the operator to review
    // each tool individually before its description (operator-
    // supplied data from a third-party MCP server) reaches the LLM.
    // Audited as `mcp.tool.expose_to_ai_set` with before/after on
    // each toggle.
    exposeToAi: boolean("expose_to_ai").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_tool_descriptors_connection_name_idx").on(table.connectionId, table.name),
  ],
);

/**
 * Org-scoped named prompt templates for the PromptOps registry.
 *
 * One row per `(orgId, name)`. The `pinned_version_id` nullable column points
 * at the `prompt_versions.id` that should be treated as the "active" version
 * when an `ai` / `agent` node references the prompt by name without an
 * explicit version. When null, the resolver falls back to the latest
 * published version (highest `version` integer).
 *
 * No foreign key to `prompt_versions` — same `workflow_versions` /
 * `workflows` posture; orphaned rows tolerated. Multi-tenant scope enforced
 * at the repo layer via `eq(prompts.orgId, orgId)` on every query.
 *
 * Adding a new prompt writes audit `prompt.created`; pinning a version
 * writes `prompt.version_pinned` with `{ from, to }` metadata.
 */
export const prompts = pgTable(
  "prompts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("default"),
    name: text("name").notNull(),
    description: text("description"),
    // Nullable. `null` = resolver uses the latest published version.
    // Set via `POST /prompts/:name/versions/:version/pin`.
    pinnedVersionId: text("pinned_version_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("prompts_org_name_idx").on(table.orgId, table.name),
    index("prompts_org_created_idx").on(table.orgId, table.createdAt.desc()),
  ],
);

/**
 * Append-only versions of each prompt. Version numbers are server-assigned
 * (auto-incremented per-prompt) and monotonically increasing — no manual
 * version setting by clients. Once published, a version is immutable; if a
 * prompt needs to change, create a new version.
 *
 * `templateText` is the raw template body with `{{var.X}}` and
 * `{{include.Y}}` substitution tokens. The resolver in
 * `packages/engine/src/prompt-resolver.ts` is the single chokepoint that
 * substitutes these — never read this column from a route handler or node
 * executor directly.
 *
 * `variables` is a JSONB array of `PromptVariable` records (declared
 * variable name, type, required flag, optional default). The resolver
 * validates the calling node's context against these declarations BEFORE
 * the LLM call so a missing-required variable surfaces without burning
 * tokens.
 *
 * Adding a new version writes audit `prompt.version_created`.
 */
export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("default"),
    promptId: text("prompt_id").notNull(),
    version: integer("version").notNull(),
    templateText: text("template_text").notNull(),
    // `PromptVariable[]` — see `packages/shared/src/prompt-variables.ts`.
    variables: jsonb("variables").notNull().default([]),
    // Closed enum: 'draft' | 'published'. v1 ships every version as
    // 'published' on create; the column is reserved for a future
    // workflow-style draft-then-publish flow.
    status: text("status").notNull().default("published"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("prompt_versions_org_prompt_version_idx").on(table.orgId, table.promptId, table.version),
    index("prompt_versions_org_prompt_created_idx").on(table.orgId, table.promptId, table.createdAt.desc()),
  ],
);

/**
 * Tenant-scoped vector memory store for the substrate.
 *
 * Persists episodic / semantic / procedural memory entries produced by
 * downstream consumers (memory-assisted recovery suggestions, agent
 * recall, etc.). Memory is off by default and gated by a two-flag
 * consent posture: a process env (`JANUSLY_MEMORY_ENABLED=true`) AND a
 * per-tenant `org_configs.memory.enabled` row. Both must be true for
 * any commit; the eligibility / retention / scrubbing rules live in the
 * canonical memory policy at `docs/memory-policy.md`.
 *
 * Embedding storage uses `pgvector`'s native `vector(N)` type — the
 * dimension is fixed at table creation (1024 = bge-m3 native size).
 * Per-row `embedding_provider` / `embedding_model` / `embedding_dimension`
 * track which model produced each vector so the operator can re-embed
 * on a future provider swap without ambiguity.
 *
 * Indexes:
 * - `memory_entries_org_kind_created_idx` (composite btree, leads with
 *   `org_id`) — recency scans within a tenant + kind.
 * - `memory_entries_org_retain_until_idx` — drives the retention sweep.
 * - The HNSW cosine index on `embedding` is emitted directly in the
 *   migration (drizzle-kit does not generate `USING hnsw` syntax).
 */
export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id"),
    runId: text("run_id"),
    // Closed enum validated at the repo layer: 'recovery_rationale' |
    // 'run_summary' | 'runbook_fragment' | 'patch_rationale'.
    kind: text("kind").notNull(),
    // Already scrubbed via `scrubSecretShapes` at commit time;
    // re-scrubbed at recall time as defense-in-depth.
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimension: integer("embedding_dimension").notNull(),
    // Bounded jsonb — `safePersistPayload` chokepoint capped at 8KB by
    // the commit helper. Never store raw node outputs here.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Populated by the commit helper from per-kind retention defaults
    // or per-tenant overrides; the retention sweep deletes rows where
    // `retain_until <= now()`.
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("memory_entries_org_kind_created_idx").on(
      table.orgId,
      table.kind,
      table.createdAt.desc(),
    ),
    index("memory_entries_org_retain_until_idx").on(table.orgId, table.retainUntil),
  ],
);
