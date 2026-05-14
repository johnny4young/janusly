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

import { pgTable, text, jsonb, timestamp, integer, real, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

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
    configJson: jsonb("config_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("sso_connections_org_provider_idx").on(table.orgId, table.provider),
  ],
);
