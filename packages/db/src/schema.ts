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
 * - `workflows`, `workflow_versions` — versioned DAG storage.
 * - `runs`, `run_nodes`, `run_events` — execution history (timeline events
 *   are paginated by `(run_id, created_at)`).
 * - `dead_letters` — DLQ rows; replayed via `POST /dlq/replay`.
 * - `routing_stats`, `workflow_improvements` — RL counters and
 *   improvement-engine bookkeeping.
 * - `usage_events` — billing telemetry (one row per LLM call through the shared LLM recorder).
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

import { pgTable, text, jsonb, timestamp, integer, real, index, uniqueIndex } from "drizzle-orm/pg-core";

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
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("runs_org_created_idx").on(table.orgId, table.createdAt.desc()),
    index("runs_parent_idx").on(table.parentRunId),
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
