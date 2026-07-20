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
 * - `packages/db/migrations/20260610175420_baseline/migration.sql` — the
 *   development baseline (pre-production squash of the first 31 migrations)
 *   was emitted from this exact shape, plus the three documented hand-edits
 *   drizzle-kit cannot generate (pgvector extension, GIN opclass, HNSW index).
 *
 * Tables:
 * - `organizations`, `users`, `org_members` — multi-tenant scope.
 * - `org_configs` — tenant-level runtime configuration overrides.
 * - `workflows`, `workflow_versions` — versioned DAG storage.
 * - `runs`, `run_nodes`, `run_events` — execution history (timeline events
 *   are paginated by `(run_id, created_at)`).
 * - `dead_letters` — DLQ rows; replayed via `POST /dlq/replay`.
 * - `recovery_impact_events`, `recovery_impact_rollups` — terminally verified
 *   recovery value and its constant-time tenant lifetime projection.
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

import { sql } from "drizzle-orm";
import { pgTable, text, jsonb, timestamp, integer, bigint, real, boolean, index, uniqueIndex, vector } from "drizzle-orm/pg-core";

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
    /**
     * Operational status. `active` is the normal state. The upstream-health
     * poller flips this to `paused_upstream_degraded` when a watched status
     * page reports a referenced component degraded, and restores it to
     * `active` on recovery. `POST /start` rejects a non-`active` workflow with
     * HTTP 409 unless the caller passes the explicit force-run flag.
     */
    status: text("status").notNull().default("active"),
    /**
     * Free-form reason for a non-`active` status (e.g. the upstream source
     * name + component that triggered the pause). Operator-visible only; NULL
     * when `status === "active"`.
     */
    pausedReason: text("paused_reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    /**
     * Soft-delete tombstone. NULL = active. `DELETE /workflows/:id` sets this
     * (instead of hard-deleting) so a deletion is recoverable via
     * `POST /workflows/:id/restore`; every list/read filters `deletedAt IS NULL`
     * so a soft-deleted workflow behaves as "not found". The `system:retention`
     * sweep hard-deletes rows soft-deleted longer than
     * `retention.deletedWorkflowsDays` (the original cascade, deferred).
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
    /**
     * Per-workflow SLO declaration. Closed-key shape validated by
     * `WorkflowSloSchema` in `@janusly/shared/src/workflow-slo`.
     * Carried forward from the previous version on every save unless
     * the save body explicitly overrides it.
     */
    sloJson: jsonb("slo_json"),
    /**
     * Optional list of `upstream_health_sources.name` values this workflow is
     * tagged with. When any referenced source reports a watched component
     * degraded, the poller auto-pauses the workflow. Carried forward from the
     * prior version on every save (same posture as `sloJson`). `null` / empty
     * = not subscribed to any upstream feed.
     */
    upstreamHealthSources: jsonb("upstream_health_sources").$type<string[]>(),
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
    /** Parent execution/provenance link; interpret it through `parentLinkKind`. */
    parentRunId: text("parent_run_id"),
    /** Parent node for an invocation or replay fork; whole-run replay lineage may leave it NULL. */
    parentNodeId: text("parent_node_id"),
    /**
     * Meaning of the parent link: `subworkflow` is an executable invocation;
     * `replay` is trace-only lineage. NULL for top-level and legacy rows.
     */
    parentLinkKind: text("parent_link_kind").$type<"subworkflow" | "replay">(),
    /** Durable lease/outbox marker for terminal child→parent delivery. */
    parentNotificationAfter: timestamp("parent_notification_after", { withTimezone: true }),
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
    /** Atomic per-run idempotency claim for Recovery Playbook validation accounting. */
    recoveryPlaybookValidationRecordedAt: timestamp("recovery_playbook_validation_recorded_at", { withTimezone: true }),
    /** Atomic per-run idempotency claim for Recovery Playbook production-use accounting. */
    recoveryPlaybookAppliedRecordedAt: timestamp("recovery_playbook_applied_recorded_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("runs_org_created_idx").on(table.orgId, table.createdAt.desc()),
    index("runs_parent_idx").on(table.parentRunId),
    index("runs_parent_notification_idx")
      .on(table.parentNotificationAfter, table.id)
      .where(sql`"parent_notification_after" IS NOT NULL`),
    index("runs_org_replay_mode_idx").on(table.orgId, table.replayMode),
    uniqueIndex("runs_redrive_idempotency_idx")
      .on(table.orgId, table.parentRunId, table.parentNodeId, table.workflowVersionId)
      .where(sql`"parent_link_kind" = 'replay' AND "replay_mode" IS NULL AND "input_json" ? 'redrive'`),
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
    /** Durable lease for the bounded-wait Redis repair sweep. */
    waitingRepairAfter: timestamp("waiting_repair_after", { withTimezone: true }),
    /**
     * Durable Postgres→BullMQ publication outbox/lease. Non-null means the
     * exact queued generation still needs publication confirmation (or a
     * failed-run guard consumed its job and restored it to `pending`).
     */
    queuePublicationRepairAfter: timestamp("queue_publication_repair_after", { withTimezone: true }),
    /** Rotates only when a new physical BullMQ delivery is required. */
    queuePublicationGeneration: integer("queue_publication_generation").notNull().default(0),
    attempts: integer("attempts").default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** DLQ replay claim carried until this node reaches terminal success. */
    recoveryDeadLetterId: text("recovery_dead_letter_id"),
    /** Operator/system actor that initiated `recoveryDeadLetterId`. */
    recoveryRequestedBy: text("recovery_requested_by"),
    /** Per-replay generation carried by the BullMQ job and CAS-checked on completion. */
    recoveryClaimToken: text("recovery_claim_token"),
    /** Active Recovery Playbook explicitly chosen for this replay generation. */
    recoveryPlaybookId: text("recovery_playbook_id"),
    /** Fresh sandbox run that attested `recoveryPlaybookId` before production replay. */
    recoveryValidationRunId: text("recovery_validation_run_id"),
    errorJson: jsonb("error_json"),
  },
  (table) => [
    uniqueIndex("run_nodes_run_node_idx").on(table.runId, table.nodeId),
    // Partial index for the stalled-node reaper's sweep
    // (`status = 'running' AND started_at < cutoff ORDER BY started_at`).
    // Tiny in practice: `running` rows are transient, while the table grows
    // one row per node per run — without it every sweep is a seq scan.
    index("run_nodes_running_started_idx")
      .on(table.startedAt)
      .where(sql`"status" = 'running'`),
    // Backs the once-per-minute bounded-wait reconciler. Unclaimed rows sort
    // first so a leased poison batch cannot starve later checkpoints; the
    // target expression covers mutually exclusive approval/timer timestamps.
    index("run_nodes_waiting_target_idx")
      .on(
        table.waitingRepairAfter.asc().nullsFirst(),
        sql`(COALESCE("state_json" #>> '{waiting,deadlineAt}', "state_json" #>> '{waiting,wakeAt}'))`,
        table.runId,
        table.nodeId,
      )
      .where(sql`"status" = 'waiting'`),
    // Backs the once-per-minute Postgres→BullMQ publication reconciler.
    // Healthy rows clear the marker immediately after Queue.add succeeds, so
    // the partial index contains only crash/failure recovery work.
    index("run_nodes_queue_publication_repair_idx")
      .on(table.queuePublicationRepairAfter, table.runId, table.nodeId)
      .where(sql`"queue_publication_repair_after" IS NOT NULL AND "status" IN ('pending', 'queued')`),
  ],
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
    // Legal-hold bypass for the retention sweep. When set in the future,
    // the row is exempt from purge until the timestamp passes (e.g. an
    // active investigation freezes its run timeline). NULL = no hold.
    holdUntil: timestamp("hold_until", { withTimezone: true }),
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
    /** Replay generation persisted before the BullMQ job becomes visible. */
    replayClaimToken: text("replay_claim_token"),
    /** Causal replay boundary; unlike replayedAt, this lands before enqueue. */
    replayClaimedAt: timestamp("replay_claimed_at", { withTimezone: true }),
    replayedAt: timestamp("replayed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("dead_letters_org_status_idx").on(table.orgId, table.status, table.createdAt.desc()),
    // Backs the recovery queue's default sorts (`newest` / `oldest`) when no
    // status filter is applied — with `status` in the middle of the index
    // above, Postgres can't produce keyset-ordered output and re-sorts the
    // org's entire DLQ per page.
    index("dead_letters_org_created_idx").on(table.orgId, table.createdAt.desc(), table.id.desc()),
    index("dead_letters_org_replay_claimed_idx").on(table.orgId, table.replayClaimedAt.desc()),
    index("dead_letters_org_run_node_created_idx").on(
      table.orgId,
      table.runId,
      table.nodeId,
      table.createdAt,
    ),
  ],
);

/**
 * One immutable fact per DLQ replay that reached terminal node success.
 * `deadLetterId` is the idempotency key: worker retries cannot double-count a
 * recovery. No FK is intentional — recovery evidence remains inspectable
 * after orphan-tolerant parent retention, matching the rest of the DLQ model.
 */
export const recoveryImpactEvents = pgTable(
  "recovery_impact_events",
  {
    deadLetterId: text("dead_letter_id").primaryKey(),
    orgId: text("org_id").notNull(),
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    userId: text("user_id"),
    recoveredAt: timestamp("recovered_at", { withTimezone: true }).notNull(),
    downtimeEndedMs: bigint("downtime_ended_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    index("recovery_impact_events_org_recovered_idx").on(table.orgId, table.recoveredAt.desc()),
    index("recovery_impact_events_org_user_recovered_idx").on(table.orgId, table.userId, table.recoveredAt.desc()),
  ],
);

/**
 * Constant-time lifetime projection derived atomically from
 * `recovery_impact_events`. One row per tenant; intentionally no FK so org
 * deletion retains the same operational history posture as other tables.
 */
export const recoveryImpactRollups = pgTable("recovery_impact_rollups", {
  orgId: text("org_id").primaryKey(),
  totalRecovered: integer("total_recovered").notNull().default(0),
  downtimeEndedMs: bigint("downtime_ended_ms", { mode: "number" }).notNull().default(0),
  firstRecoveredAt: timestamp("first_recovered_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    // Legal-hold bypass for the retention sweep — see `run_events.holdUntil`.
    holdUntil: timestamp("hold_until", { withTimezone: true }),
  },
  (table) => [
    index("usage_events_org_metric_idx").on(table.orgId, table.metric),
    // Composite for the billing + value-dashboard hot paths that filter
    // (orgId, metric='llm.completion', createdAt >= since). Without the
    // createdAt column, the rolling-window scan degrades once the table
    // crosses ~100k rows.
    // The generated migration must use CREATE INDEX CONCURRENTLY (hand-
    // patched — drizzle's index() builder emits the blocking variant).
    index("usage_events_org_metric_created_idx").on(
      table.orgId,
      table.metric,
      table.createdAt.desc(),
    ),
    // Bounded per-run diagnostics scan. Partial because route-level AI calls
    // without a run id remain valid usage rows but can never satisfy this read.
    index("usage_events_org_run_created_idx")
      .on(table.orgId, table.runId, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.runId} IS NOT NULL`),
  ],
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
    // Optional operator-declared expiry for the underlying secret (token /
    // webhook / DSN). Null = no expiry tracked. Only metadata — the secret
    // value itself still lives in env via `secret_ref`. Powers the
    // credential-expiry warning scan + the panel's expiry badge.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // Optimistic-concurrency token for secret-ref rotation. Millisecond
    // precision (timestamptz(3)) on purpose: the rotation route compares it
    // as an If-Match against the JS Date it round-trips through ISO, and full
    // microsecond precision would never equal a re-serialized ms-precision
    // value — so a first rotation would always look like a conflict.
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).defaultNow(),
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
    // Legal-hold bypass for the retention sweep — see `run_events.holdUntil`.
    // The retention floor on audit_logs is 365 days; a hold freezes a row
    // referenced by an active compliance investigation past that floor.
    holdUntil: timestamp("hold_until", { withTimezone: true }),
  },
  (table) => [
    index("audit_logs_org_created_idx").on(table.orgId, table.createdAt.desc()),
    // Backs the audit viewer's action-PREFIX filter
    // (`queryAuditLogs`: `action LIKE 'prefix%'`). A plain btree can't serve
    // `LIKE` under the default collation, so the migration SQL appends the
    // `text_pattern_ops` opclass to the `action` column by hand (drizzle's
    // builder can't emit an opclass — same pattern as the GIN index below).
    // Ordered (org_id, action, created_at DESC) so the org-scoped prefix
    // range scan feeds the newest-first keyset without a full-table sort.
    index("audit_logs_org_action_created_idx").on(table.orgId, table.action, table.createdAt.desc()),
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
    // The LLM's self-rated confidence (0-100) for the suggestion the
    // operator decided on. Nullable because rows written before this
    // column landed (and headless callers that omit it) carry no value;
    // the daily confidence-calibration sweep buckets only rows where this
    // is non-null, so a missing value silently drops out of the curve fit
    // rather than skewing it toward 0.
    rawConfidence: integer("raw_confidence"),
    comment: text("comment"),
    // Operator opt-in to reuse this decision as eval-dataset training
    // material. Default `false`: a row is NEVER eligible for an eval
    // example unless the operator explicitly consents at feedback time.
    // The dataset-build query filters `accepted = true AND eval_consent =
    // true`, so consent is a hard gate on top of the accept gate.
    evalConsent: boolean("eval_consent").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // Legal-hold bypass for the retention sweep — see `run_events.holdUntil`.
    holdUntil: timestamp("hold_until", { withTimezone: true }),
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
 * Durable freshness projection for the recovery-feedback loop.
 *
 * `recovery_feedback` is retention-managed, but the operator needs to know
 * when a workflow/approach stopped receiving accepted fixes even after the
 * source rows have expired. This compact one-row-per-approach projection is
 * updated atomically with every feedback decision and intentionally remains
 * orphan-tolerant like the rest of Janusly's recovery records.
 */
export const recoveryFeedbackHealth = pgTable(
  "recovery_feedback_health",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    approachLabel: text("approach_label").notNull(),
    /** Most recent accept OR reject decision for this approach. */
    feedbackLastSeen: timestamp("feedback_last_seen", { withTimezone: true }).notNull().defaultNow(),
    /** Most recent accepted fix; null when all recorded decisions were rejected. */
    acceptedFixLastSeen: timestamp("accepted_fix_last_seen", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("recovery_feedback_health_org_workflow_approach_idx").on(
      table.orgId,
      table.workflowId,
      table.approachLabel,
    ),
    index("recovery_feedback_health_org_workflow_idx").on(table.orgId, table.workflowId),
  ],
);

/**
 * Versioned operator-owned recovery procedures promoted from a proven fix.
 *
 * Playbooks intentionally remain orphan-tolerant: workflow versions and
 * workflows may be retention-purged while the audit record of what operators
 * trusted remains inspectable. Runtime use re-checks that the source workflow
 * and version are still active before returning an executable snapshot.
 */
export const recoveryPlaybooks = pgTable(
  "recovery_playbooks",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id"),
    signature: text("signature").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("draft"),
    title: text("title").notNull(),
    instructionsMarkdown: text("instructions_markdown").notNull(),
    evidenceRequirementsJson: jsonb("evidence_requirements_json").notNull(),
    sourceWorkflowVersionId: text("source_workflow_version_id").notNull(),
    approachLabel: text("approach_label").notNull().default("other"),
    successfulUses: integer("successful_uses").notNull().default(0),
    regressions: integer("regressions").notNull().default(0),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    /** Idempotency marker for terminal sandbox outcomes. */
    lastValidationRunId: text("last_validation_run_id"),
    /** Idempotency marker for production applies after a passed sandbox. */
    lastAppliedValidationRunId: text("last_applied_validation_run_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    uniqueIndex("recovery_playbooks_org_signature_version_idx").on(table.orgId, table.signature, table.version),
    uniqueIndex("recovery_playbooks_org_source_version_idx").on(table.orgId, table.sourceWorkflowVersionId),
    uniqueIndex("recovery_playbooks_one_active_match_idx")
      .on(table.orgId, table.workflowId, table.signature)
      .where(sql`"status" = 'active'`),
    index("recovery_playbooks_org_signature_status_idx").on(table.orgId, table.signature, table.status),
    index("recovery_playbooks_org_workflow_idx").on(table.orgId, table.workflowId),
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
    // Closed enum validated at the repo layer — see `MEMORY_KINDS` in
    // `packages/data/src/memory-kinds.ts` for the authoritative list.
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
    // or per-tenant overrides; the per-kind sweep deletes rows where
    // `retain_until <= now()`.
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
    // Legal-hold bypass for the org-level retention sweep (the
    // `retention.memoryEntriesDays` policy) — see `run_events.holdUntil`.
    // Distinct from `retain_until`: that drives the per-kind memory-policy
    // expiry; this freezes a row past the org's retention floor.
    holdUntil: timestamp("hold_until", { withTimezone: true }),
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

/**
 * Supervised auto-healing decision ledger.
 *
 * One row per (orgId, deadLetterId) lifecycle: a background scanner
 * picks repeated DLQ failures grouped by normalized signature, asks
 * the existing LLM patch helper for a fix, runs the fix through the
 * existing sandbox-validation gate, and parks the result here for
 * either an operator decision OR (if the org has opted into both the
 * process-level and tenant-level auto-apply flags) an automatic
 * production replay. Manual review is the default; auto-apply is the
 * separate opt-in.
 *
 * Multi-tenant scope: `orgId` leads every index. The pending-list
 * query, the loop-breaker count query, and the idempotency check are
 * all single-index lookups.
 *
 * `signature` is the normalized failure signature captured at
 * diagnose time; the loop-breaker counts prior `auto_healing_runs`
 * rows for the same `(orgId, signature)` across the configured
 * window so a patch that fails to stabilize the failure does not
 * loop forever. `validationSignature` is captured at validation
 * outcome time so the watcher's signature-changed defense can
 * compare like-for-like.
 *
 * `status` is the source of truth for the apply race — both the
 * operator decision route AND the auto-apply watcher run a CAS-style
 * `UPDATE … WHERE status = 'validated'`, so only one writer wins.
 *
 * `loopAttemptCount` is captured ONCE at diagnose time and never
 * recomputed, so the audit log can trace why a candidate was
 * declined under `loop_breaker_tripped` even after the underlying
 * count moves on.
 */
export const autoHealingRuns = pgTable(
  "auto_healing_runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    deadLetterId: text("dead_letter_id").notNull(),
    // The normalized failure signature from `normalizeErrorSignature`
    // — the loop-breaker + idempotency dimension.
    signature: text("signature").notNull(),
    // Closed enum validated at the repo layer:
    // 'diagnosed' | 'proposed' | 'validating' | 'validated' |
    // 'validation_failed' | 'applied' | 'declined' | 'failed'.
    status: text("status").notNull(),
    // The merged workflow snapshot from the apply-config or
    // apply-structural patch helper. `safePersistPayload`-wrapped at
    // insert.
    proposedPatchJson: jsonb("proposed_patch_json"),
    // The LLM's self-reported approach label (closed enum: add_retry /
    // raise_timeout / swap_secret_ref / add_approval / fix_url /
    // other). Used for grouping in the audit log + `recovery_feedback`.
    approachLabel: text("approach_label"),
    // 0–100 confidence from the suggestion envelope.
    confidence: integer("confidence"),
    // The sandbox `runs.id`; nullable until the validate step lands.
    validationRunId: text("validation_run_id"),
    // Captured at validation outcome time so the signature-changed
    // defense can compare like-for-like. Nullable when validation
    // succeeded (no error to normalize).
    validationSignature: text("validation_signature"),
    // 'auto' / '<userId>' / 'system_decline_<reason>'; nullable until
    // decision. The audit row's userId mirrors this column.
    decisionActor: text("decision_actor"),
    // Closed enum: loop_breaker_tripped / budget_exceeded /
    // validation_failed / signature_changed / auto_apply_disabled /
    // manual_review / signature_already_resolved / validation_timeout.
    declineReason: text("decline_reason"),
    // Captured once at diagnose time so the audit log can trace why
    // a candidate was declined even after the underlying count moves
    // on.
    loopAttemptCount: integer("loop_attempt_count").notNull(),
    // Open bag for future fields; `safePersistPayload`-wrapped at
    // insert.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Pending-decision list query (status='validated', recency-ordered).
    index("auto_healing_runs_org_status_created_idx").on(
      table.orgId,
      table.status,
      table.createdAt.desc(),
    ),
    // Loop-breaker count query (count rows for (orgId, signature)
    // inside the loop window).
    index("auto_healing_runs_org_signature_created_idx").on(
      table.orgId,
      table.signature,
      table.createdAt.desc(),
    ),
    // Idempotency check: "did we already auto-heal this DLQ row?"
    index("auto_healing_runs_org_dlq_idx").on(table.orgId, table.deadLetterId),
    // Partial index for the watcher / CAS hot path that filters
    // (orgId, status='validated'). The 3-col composite above covers
    // the same query but spans every status value; a partial over
    // only the validated rows is ~10× smaller and stays in
    // shared_buffers under hot load. The generated migration must
    // use CREATE INDEX CONCURRENTLY (hand-patched).
    index("auto_healing_runs_org_validated_idx")
      .on(table.orgId)
      .where(sql`${table.status} = 'validated'`),
  ],
);

/**
 * Org-scoped recovery alerting policy. Operator-declared rules that fan
 * out a signal (DLQ insert, budget block, limiter degradation, SLO breach,
 * stalled approval, failure-cluster threshold crossed) into one or more
 * channels (slack / webhook / email / github) using existing credentials.
 *
 * `trigger` is validated against the closed enum in
 * `@janusly/shared/src/alert-policy:ALERT_TRIGGERS` at the application
 * layer (NOT a DB CHECK — same posture as `mcp_connections.transport`).
 * `parameters` is per-trigger Zod-validated via the dispatch table in
 * the same shared module before insert.
 *
 * Multi-tenant scope: every read carries `eq(alertPolicies.orgId, orgId)`
 * EXCEPT for `limiter.degraded` policies which intentionally use the
 * `"system"` sentinel orgId (mirrors the `rate_limit.degraded` audit
 * convention — limiter degradation is operator-side infrastructure, not
 * tenant data).
 */
export const alertPolicies = pgTable(
  "alert_policies",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    trigger: text("trigger").notNull(),
    parameters: jsonb("parameters").notNull().default({}),
    channels: jsonb("channels").notNull(),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(900),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("alert_policies_org_name_idx").on(table.orgId, table.name),
    index("alert_policies_org_trigger_enabled_idx").on(
      table.orgId,
      table.trigger,
      table.enabled,
    ),
  ],
);

/**
 * One row per alert dispatch attempt (success OR per-channel failure). Backs
 * both the cooldown lookup (latest row per `(orgId, policyId, dedupeKey)`
 * vs `now() - cooldownSeconds`) AND the `GET /alerts/recent` operator feed.
 *
 * Suppression rows (cooldown skips) do NOT live here — they fire the
 * `alert.policy.suppressed` audit only, keeping this table compact even
 * under chatty policies.
 *
 * `dedupeKey` is computed per-trigger by `buildDedupeKey` in
 * `packages/engine/src/alerts/dedupe-key.ts`. `outcome` is the closed enum
 * `delivered | delivery_failed` validated at the Zod layer.
 */
export const alertDispatches = pgTable(
  "alert_dispatches",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    policyId: text("policy_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }).notNull().defaultNow(),
    outcome: text("outcome").notNull(),
    channelResults: jsonb("channel_results").notNull(),
    triggerPayload: jsonb("trigger_payload").notNull(),
  },
  (table) => [
    index("alert_dispatches_org_policy_dedupe_idx").on(
      table.orgId,
      table.policyId,
      table.dedupeKey,
      table.dispatchedAt.desc(),
    ),
    index("alert_dispatches_org_dispatched_idx").on(
      table.orgId,
      table.dispatchedAt.desc(),
    ),
  ],
);

/**
 * Org-scoped recovery incident — one row per open DLQ failure, the
 * operational vertebra over the Recovery Center. Tracks `owner` +
 * `severity` (p1/p2/p3/p4) + `slaTargetAt` + lifecycle `status` + append-
 * only `comments` so operators can coordinate without leaving the panel.
 *
 * Lifecycle state machine enforced at the data layer via CAS-style
 * `UPDATE … WHERE status IN (allowed_pre_states)` — concurrent
 * operator-click vs auto-apply can't double-apply (mirror of
 * `recordDecision` in `autoHealingRepo.ts`).
 *
 * Multi-tenant scope: every read carries `eq(recoveryItems.orgId, orgId)`.
 * One item per `(orgId, deadLetterId)` — the unique index makes
 * `createRecoveryItem` idempotent so cluster-apply fan-out can call it N
 * times safely.
 *
 * Closure path: either a generation-matched replay reaches terminal node
 * success (auto-close with `resolutionReason: sandbox_replay_succeeded`) or
 * the operator explicitly resolves with a closed-enum reason. Comments live in jsonb as
 * `Array<{ id, authorUserId, body, createdAt }>` and are append-only via
 * the repo helper (cap 200).
 */
export const recoveryItems = pgTable(
  "recovery_items",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    deadLetterId: text("dead_letter_id").notNull(),
    workflowId: text("workflow_id"),
    owner: text("owner"),
    severity: text("severity").notNull().default("p3"),
    status: text("status").notNull().default("open"),
    slaTargetAt: timestamp("sla_target_at", { withTimezone: true }).notNull(),
    resolutionReason: text("resolution_reason"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // Set once on the first meaningful recovery action. This is intentionally
    // independent from `updatedAt`, which also moves for passive occurrence
    // grouping and would overstate operator reaction time.
    firstActionAt: timestamp("first_action_at", { withTimezone: true }),
    comments: jsonb("comments").notNull().default([]),
    // Debounce / failure-storm grouping. The normalized error signature is
    // the match key (alongside orgId + workflowId) for collapsing repeated
    // failures into one incident; the counters track how big the storm got
    // and when it started / last fired.
    errorSignature: text("error_signature"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstOccurredAt: timestamp("first_occurred_at", { withTimezone: true }).notNull().defaultNow(),
    lastOccurredAt: timestamp("last_occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("recovery_items_org_dlq_idx").on(table.orgId, table.deadLetterId),
    index("recovery_items_org_status_sla_idx").on(
      table.orgId,
      table.status,
      table.slaTargetAt,
    ),
    index("recovery_items_org_owner_idx").on(table.orgId, table.owner),
    index("recovery_items_org_created_idx").on(table.orgId, table.createdAt),
    index("recovery_items_org_signature_first_idx").on(
      table.orgId,
      table.errorSignature,
      table.firstOccurredAt,
    ),
    // Backs the debounce lookup: find a recent open item with the same
    // (orgId, workflowId, errorSignature) to attach a new occurrence to.
    index("recovery_items_org_wf_sig_idx").on(
      table.orgId,
      table.workflowId,
      table.errorSignature,
    ),
  ],
);

/**
 * Child occurrences attached to a `recovery_items` parent during a failure
 * storm. When a new DLQ entry arrives with the same
 * `(orgId, workflowId, errorSignature)` as a still-open parent whose last
 * occurrence is within the org's debounce window, the entry is recorded
 * here instead of spawning a fresh incident — so one storm reads as one
 * incident with an occurrence count, not N identical incidents.
 *
 * Child rows have NO independent lifecycle: resolving the parent closes the
 * incident for every attached occurrence. The `id` PK + the unique index on
 * `(recoveryItemId, deadLetterId)` make the attach idempotent (a replayed
 * DLQ insert is a no-op), mirroring `recovery_items`' own
 * `onConflictDoNothing` pattern.
 *
 * Cascade posture: orphan-tolerant by design (consistent with the rest of
 * the recovery subsystem). The attachment trail is left intact for
 * forensics even after the parent resolves; rows are removed only by an
 * explicit purge, never by a parent transition.
 *
 * Multi-tenant scope on every read via `eq(recoveryItemChildren.orgId, orgId)`.
 */
export const recoveryItemChildren = pgTable(
  "recovery_item_children",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    recoveryItemId: text("recovery_item_id").notNull(),
    deadLetterId: text("dead_letter_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("recovery_item_children_item_dlq_idx").on(
      table.recoveryItemId,
      table.deadLetterId,
    ),
    index("recovery_item_children_item_occurred_idx").on(
      table.recoveryItemId,
      table.occurredAt.desc(),
    ),
    index("recovery_item_children_org_dlq_idx").on(
      table.orgId,
      table.deadLetterId,
    ),
  ],
);

/**
 * Cross-team incident handoff log — one row per
 * `(orgId, recoveryItemId, destination)` triple. Powers the
 * idempotency contract of the recovery handoff route: a second handoff
 * to the same destination doesn't duplicate (slack: cooldown no-op;
 * github: append a comment to the existing issue; linear / webhook:
 * receiver dedupes by `idempotencyKey` header).
 *
 * `externalId` captures the persistent reference the upstream system
 * returned on the first dispatch (github issueNumber, future Slack
 * threadTs, custom webhook receipt id). `externalUrl` is the
 * operator-clickable deep link rendered in the drawer after a successful
 * handoff.
 *
 * Multi-tenant scope on every read via `eq(recoveryItemHandoffs.orgId, orgId)`.
 * The unique index on `(orgId, recoveryItemId, destination)` makes
 * `upsertHandoff` safe even when two operators click "Handoff" at the
 * same moment — Postgres serialises the INSERT ON CONFLICT.
 */
export const recoveryItemHandoffs = pgTable(
  "recovery_item_handoffs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    recoveryItemId: text("recovery_item_id").notNull(),
    destination: text("destination").notNull(),
    credentialName: text("credential_name").notNull(),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    idempotencyKey: text("idempotency_key").notNull(),
    lastOutcome: text("last_outcome").notNull(),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    lastLatencyMs: integer("last_latency_ms"),
    dispatchCount: integer("dispatch_count").notNull().default(1),
    firstDispatchedAt: timestamp("first_dispatched_at", { withTimezone: true }).notNull().defaultNow(),
    lastDispatchedAt: timestamp("last_dispatched_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (table) => [
    uniqueIndex("recovery_item_handoffs_org_item_dest_idx").on(
      table.orgId,
      table.recoveryItemId,
      table.destination,
    ),
    index("recovery_item_handoffs_org_lastdispatched_idx").on(
      table.orgId,
      table.lastDispatchedAt.desc(),
    ),
  ],
);

/**
 * Per-workflow metadata layer — owners, runbook Markdown, description,
 * tags, Slack / Linear coordinates, default severity. One row per
 * `(orgId, workflowId)` triple. The unique index makes the metadata
 * upsert idempotent; the secondary index supports an "updated recently"
 * admin feed without scanning the whole table.
 *
 * Powers the "About this workflow" panel in the Recovery dialog and the
 * default-owner / default-severity integrations the recovery_item
 * subsystem consults when a row is created from a DLQ entry or reassigned.
 *
 * Multi-tenant scope on every read via `eq(workflowMetadata.orgId, orgId)`.
 * Operator-supplied content (runbookMarkdown, aiGuidanceMarkdown,
 * description) flows through the safe Markdown subset before display or is
 * scrubbed + DATA-framed before reaching an AI prompt.
 */
export const workflowMetadata = pgTable(
  "workflow_metadata",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    /** Closed array of user ids — operators who own this workflow. First entry = primary. */
    owners: jsonb("owners").$type<string[]>().notNull().default([]),
    /** Operator-supplied free-form Markdown (closed subset; 32 KiB cap enforced at write). */
    runbookMarkdown: text("runbook_markdown"),
    /** Bounded operator preferences for AI generation/recovery; never a secret or system-policy store. */
    aiGuidanceMarkdown: text("ai_guidance_markdown"),
    /** Short human-readable description. */
    description: text("description"),
    /** Operator-chosen labels (closed bounded array). */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /** Operator-chosen folder name — a single organizing home for the Flows list. Nullable = ungrouped. */
    folder: text("folder"),
    /** Slack channel reference like `#alerts-prod` — bare string, no URL construction server-side. */
    slackChannel: text("slack_channel"),
    /** Linear project URL (https://linear.app/...) OR slug. */
    linearProject: text("linear_project"),
    /** Closed-enum severity default (`p1`/`p2`/`p3`/`p4`); nullable means engine fallback applies. */
    severityDefault: text("severity_default"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_metadata_org_workflow_idx").on(table.orgId, table.workflowId),
    index("workflow_metadata_org_updated_idx").on(table.orgId, table.updatedAt.desc()),
  ],
);

/**
 * Operator-declared upstream status feeds. Each row is one status page /
 * probe the background poller fetches (through the `fetchHttpTarget` SSRF
 * chokepoint) at `checkIntervalSeconds`. A workflow opts in by listing this
 * row's `name` in `workflow_versions.upstreamHealthSources`; when a watched
 * component flips degraded the poller auto-pauses every tagged workflow and
 * auto-resumes on recovery.
 *
 * Cascade posture: orphan-tolerant (no FK). Deleting a source leaves
 * tagged-workflow references dangling — the poller simply finds no row for the
 * name and skips it (a dangling tag never pauses anything).
 */
export const upstreamHealthSources = pgTable(
  "upstream_health_sources",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("default"),
    /** Join key — workflows reference this in `upstreamHealthSources`. Unique per org. */
    name: text("name").notNull(),
    /** Closed-enum provider (`statuspage_io` / `atlassian_statuspage` / `http_probe` / `custom_feed`). */
    kind: text("kind").notNull(),
    /** Feed URL fetched through the SSRF chokepoint. */
    url: text("url").notNull(),
    /** Closed array of component display-names to watch (empty = page-level indicator). */
    expectedComponents: jsonb("expected_components").$type<string[]>().notNull().default([]),
    /** Poll cadence in seconds (clamped 30..3600 by the Zod schema). */
    checkIntervalSeconds: integer("check_interval_seconds").notNull().default(60),
    /** Whether the poller fetches this source. */
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Derived overall status from the most recent successful poll
     * (closed `UPSTREAM_COMPONENT_STATUSES` enum). NULL = never polled.
     * A poll that fails-open (unreachable feed) leaves this UNCHANGED.
     */
    lastStatus: text("last_status"),
    /** Whether the last successful poll classified the source as degraded (drives auto-pause). */
    lastDegraded: boolean("last_degraded").notNull().default(false),
    /** Timestamp of the last poll that produced a usable status. */
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** Closed-enum reason from the last fail-open poll (e.g. `unreachable`); NULL on success. */
    lastErrorReason: text("last_error_reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("upstream_health_sources_org_name_idx").on(table.orgId, table.name),
    index("upstream_health_sources_enabled_idx").on(table.enabled),
  ],
);

/**
 * Org-private reusable workflow snippets — composable node+edge fragments an
 * operator drops into a workflow being edited. ONLY custom (org-authored)
 * snippets live here; the eight built-in snippets ship in code
 * (`@janusly/shared/src/workflow-snippets.ts:BUILTIN_SNIPPETS`) and are NEVER
 * persisted. A snippet is not a runnable workflow — it has no trigger and only
 * inserts (`insertSnippet`) into an existing canvas.
 *
 * Multi-tenant scope on every read via `eq(snippets.orgId, orgId)`. `builtin`
 * is always `false` for DB rows (the column exists for shape parity with the
 * shared `SnippetDefinition`; the create route forbids `true`).
 *
 * Cascade posture: orphan-tolerant (no FK). Deleting an org leaves snippet
 * rows; re-creating the org id inherits them. `createdBy` records the author
 * for the audit trail.
 */
export const snippets = pgTable(
  "snippets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Closed `SNIPPET_CATEGORIES` enum value (`retry`/`approval`/…/`custom`). */
    category: text("category").notNull(),
    /** Operator-chosen labels (closed bounded array). */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /** Always false for DB rows; built-ins are code-only. Kept for shape parity. */
    builtin: boolean("builtin").notNull().default(false),
    /** Snippet node templates (local ids; remapped to fresh ids on insert). */
    nodesJson: jsonb("nodes_json").$type<unknown[]>().notNull().default([]),
    /** Snippet-internal edge templates (reference local node ids). */
    edgesJson: jsonb("edges_json").$type<unknown[]>().notNull().default([]),
    /** Local id of the snippet's entry node (stitch target); nullable = first node. */
    entryNodeId: text("entry_node_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("snippets_org_name_idx").on(table.orgId, table.name),
    index("snippets_org_updated_idx").on(table.orgId, table.updatedAt.desc()),
  ],
);

/**
 * Eval datasets — named, org-scoped collections of recovery decisions an
 * admin curates into a reusable regression bed for the AI patch surface.
 *
 * A dataset is built once from the eligible `recovery_feedback` rows
 * (accepted AND `eval_consent = true`) at create time; the snapshot of
 * examples lives in `eval_examples` so re-running an export is
 * deterministic and a later retention purge of `recovery_feedback`
 * doesn't silently shrink an already-published dataset.
 *
 * Multi-tenant scope: every read carries `eq(evalDatasets.orgId, orgId)`.
 *
 * Cascade posture: orphan-tolerant (no FK, per the Janusly convention).
 * Deleting a dataset hard-deletes its `eval_examples` rows in the same
 * repo call (the child rows are operationally meaningless without the
 * parent — the `workflow_versions` precedent). `sourceFeedbackId` on each
 * example references a `recovery_feedback` row that may have since been
 * purged; the example carries its own scrubbed snapshot so it survives.
 */
export const evalDatasets = pgTable(
  "eval_datasets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Optional workflow scope — when set, only that workflow's eligible feedback rows were pulled. */
    workflowId: text("workflow_id"),
    /** Count of examples captured at build time (denormalized for list views). */
    exampleCount: integer("example_count").notNull().default(0),
    /** Days the examples are retained before a future purge sweep may remove them; null = indefinite. */
    retentionDays: integer("retention_days"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("eval_datasets_org_name_idx").on(table.orgId, table.name),
    index("eval_datasets_org_created_idx").on(table.orgId, table.createdAt.desc()),
  ],
);

/**
 * Eval examples — one captured recovery decision inside a dataset.
 *
 * Each row stores a SCRUBBED input-context snapshot (the failure
 * signature + node/error context the LLM saw), the expected outcome
 * (the approach the operator accepted), the approval label, and
 * retention metadata. `scrubSecretShapes` runs over every free-text
 * field at write time (when the dataset is built) AND again at read
 * time (when the example is exported / surfaced to an LLM) — defense in
 * depth so a secret shape that slipped past the write-time pass, or one
 * introduced by a regex update between write and read, is still redacted.
 *
 * When surfaced to an LLM, examples are framed as DATA, never
 * instructions — the export/prompt composer wraps them in the same
 * suspicion-framing block `composeGenerationSystemPrompt` uses for MCP
 * tool descriptions.
 *
 * Multi-tenant scope: every read carries `eq(evalExamples.orgId, orgId)`;
 * the `datasetId` reference is always resolved through an org-scoped
 * dataset read first.
 */
export const evalExamples = pgTable(
  "eval_examples",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    datasetId: text("dataset_id").notNull(),
    /** The `recovery_feedback` row this example was distilled from (may be purged later). */
    sourceFeedbackId: text("source_feedback_id").notNull(),
    workflowId: text("workflow_id"),
    deadLetterId: text("dead_letter_id"),
    /** Scrubbed failure signature the operator was reacting to. */
    failureSignature: text("failure_signature").notNull().default(""),
    /** Scrubbed free-text input context (operator comment / failure detail). */
    inputContext: text("input_context").notNull().default(""),
    /** The approach the operator accepted — the expected outcome for an eval run. */
    expectedApproachLabel: text("expected_approach_label").notNull(),
    /** Always `true` for a built dataset (only accepted rows are eligible); kept explicit for shape clarity. */
    accepted: boolean("accepted").notNull().default(true),
    /** `"ai"` | `"fallback"` — which suggestion mode produced the accepted approach. */
    suggestionMode: text("suggestion_mode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("eval_examples_org_dataset_idx").on(table.orgId, table.datasetId),
  ],
);

/**
 * Experiments — an org-scoped A/B comparison of a CONTROL vs a CANDIDATE
 * (prompt version, model id, or both) measured against an eval dataset.
 *
 * The runner executes every `eval_examples` row in the referenced dataset
 * through BOTH sides via `LlmClient.generateText`, captures per-side
 * `costUsd` / `latencyMs` / `aiError`, scores each side with a configurable
 * scorer (string equality / JSON-schema match / LLM-as-judge with a
 * deterministic fallback), and writes the aggregate to `summary_json`.
 *
 * Promotion is RECOMMENDATION-ONLY: the harness never auto-replaces the
 * org's production prompt/model. A favourable result writes an
 * `experiment.run.promotion_suggested` audit row and stamps
 * `summary_json.recommendation` — the operator promotes manually through
 * the existing PromptOps / org-config surfaces.
 *
 * Multi-tenant scope: every read carries `eq(experiments.orgId, orgId)`.
 * The `eval_dataset_id` reference is always resolved through an org-scoped
 * dataset read first.
 *
 * Cascade posture: orphan-tolerant (no FK, per the Janusly convention).
 * Deleting the referenced dataset does NOT delete its experiments — the
 * `summary_json` snapshot stands on its own so a past comparison survives.
 */
export const experiments = pgTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    /** `prompt` | `model` | `prompt_and_model` — what the comparison varies. */
    kind: text("kind").notNull(),
    /**
     * The control side. For `prompt`/`prompt_and_model` it is a
     * `"<promptName>@<version>"` reference (or `"<promptName>"` for the
     * pinned/latest version); for `model`/`prompt_and_model` the model
     * portion is a bare model id or `"<provider>/<model>"`. The runner
     * interprets it per `kind`.
     */
    controlRef: text("control_ref").notNull(),
    /** The candidate side, same shape as `control_ref`. */
    candidateRef: text("candidate_ref").notNull(),
    /** Eval dataset whose examples drive the comparison. */
    evalDatasetId: text("eval_dataset_id").notNull(),
    /** Scorer applied to each side: `string_equality` | `json_schema` | `llm_judge`. */
    scorerKind: text("scorer_kind").notNull().default("string_equality"),
    /** `pending` → `running` → `completed` | `failed`. */
    status: text("status").notNull().default("pending"),
    /** Aggregate result — per-side score / cost / latency / error counts + recommendation. Null until completion. */
    summaryJson: jsonb("summary_json"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("experiments_org_created_idx").on(table.orgId, table.createdAt.desc()),
    index("experiments_org_dataset_idx").on(table.orgId, table.evalDatasetId),
  ],
);

/**
 * Per-`(orgId, approachLabel)` confidence calibration curve.
 *
 * LLM patch suggestions carry a self-rated `confidence` (0-100) that is
 * systematically mis-scaled — a model that says "90%" might only be
 * accepted by the operator 60% of the time. This table stores the
 * empirically-fitted correction so the recovery dialog can show a
 * calibrated number alongside the raw self-rating.
 *
 * The curve is linear in v1: `calibrated = clamp(a * raw + b, 0, 100)`,
 * where `a` (slope) and `b` (intercept) are solved by least-squares over
 * per-raw-confidence-bucket observed accept rates drawn from
 * `recovery_feedback` in a rolling 30-day window. A daily BullMQ sweep
 * recomputes one row per `(orgId, approachLabel)` that has ≥
 * `MIN_CALIBRATION_SAMPLES` accept/reject decisions in the window; below
 * the threshold the prior row is left stale (the read side treats a
 * stale-but-present row the same as absent and falls back to raw via the
 * `sampleSize` check).
 *
 * Multi-tenant scope: every read carries `eq(confidenceCalibrations.orgId,
 * orgId)`; the unique index leads with `org_id` so a tenant can never read
 * another tenant's curve. Orphan-tolerant like every other table — no FK
 * to `organizations`.
 */
export const confidenceCalibrations = pgTable(
  "confidence_calibrations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** Closed enum mirrored from the patch envelope `approachLabel` set. */
    approachLabel: text("approach_label").notNull(),
    /** Observed accept rate (0..1) over the rolling window — the headline signal. */
    acceptRate: real("accept_rate").notNull(),
    /** Total accept + reject decisions the curve was fit from. */
    sampleSize: integer("sample_size").notNull(),
    /** Linear slope `a` in `calibrated = a * raw + b`. */
    curveSlope: real("curve_slope").notNull(),
    /** Linear intercept `b` in `calibrated = a * raw + b`. */
    curveIntercept: real("curve_intercept").notNull(),
    /** When the curve was last recomputed by the daily sweep. */
    lastComputedAt: timestamp("last_computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("confidence_calibrations_org_approach_idx").on(table.orgId, table.approachLabel),
  ],
);

/**
 * Structured inbound-trigger events for the event-driven trigger node types
 * (`email_received`, `file_dropped`, `mcp_server_event`).
 *
 * One row is persisted by the API ingestion seam
 * (`apps/api/src/routes/trigger-ingest-routes.ts`) for EVERY accepted inbound
 * event BEFORE the run is spawned — the row is the DLQ-style replay anchor
 * (an operator can re-run the same normalized event) and the audit-friendly
 * record of what arrived. `status` tracks the lifecycle: `received` (row
 * written, run not yet spawned), `started` (run spawned, `runId` set),
 * `skipped` (rate-limit storm guard tripped or trigger node disabled), or
 * `failed` (run spawn threw).
 *
 * `triggerType` is one of the closed `triggerNodeTypeValues`. `payloadJson`
 * is the normalized inbound payload (the SAME shape a replay re-submits),
 * already run through `safePersistPayload` so a secret-shaped field in an
 * email body / MCP resource is redacted at rest. Attachment / object BODIES
 * are NOT stored here — they live in the object store under the
 * `orgs/<orgId>/email/...` prefix; `payloadJson` carries only their metadata
 * + object-store keys.
 *
 * Multi-tenant scope: every row carries `org_id`; the resolver binds the
 * inbound event to an org via the workflow-version row, NEVER from a claim in
 * the payload. The unique index on `(org_id, dedupe_key)` makes the seam
 * idempotent under relay retries — the same upstream message id can't spawn
 * two runs. Orphan-tolerant like every other table (no FK to
 * `workflow_versions` / `runs`).
 */
export const triggerEvents = pgTable(
  "trigger_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** One of the closed `triggerNodeTypeValues` (`email_received` / `file_dropped` / `mcp_server_event`). */
    triggerType: text("trigger_type").notNull(),
    workflowId: text("workflow_id"),
    /** The workflow version whose trigger node matched the inbound event. */
    workflowVersionId: text("workflow_version_id").notNull(),
    /** The trigger node id inside that version. */
    nodeId: text("node_id").notNull(),
    /** Lifecycle status — one of the closed `triggerEventStatusValues`, including buffered leases. */
    status: text("status").notNull().default("received"),
    /** The run this event spawned (null until `started`). */
    runId: text("run_id"),
    /** Idempotency key (e.g. email message-id, object etag) for relay-retry dedupe. */
    dedupeKey: text("dedupe_key"),
    /** Normalized inbound payload (key-redacted via `safePersistPayload`). */
    payloadJson: jsonb("payload_json").notNull(),
    /** When `status` is `skipped` / `failed`, the human-readable reason. */
    skippedReason: text("skipped_reason"),
    /** Lease token while a buffered event is being attached to exactly one run. */
    backfillClaimToken: text("backfill_claim_token"),
    /** Lease clock used to recover a claim abandoned by a crashed API process. */
    backfillClaimedAt: timestamp("backfill_claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // Per-org idempotency on the inbound dedupe key (relay retries converge).
    uniqueIndex("trigger_events_org_dedupe_idx").on(table.orgId, table.dedupeKey),
    // Operator-facing recent-event feed + replay listing, newest first.
    index("trigger_events_org_created_idx").on(table.orgId, table.createdAt.desc()),
    // Per-trigger-node lookup (replay history for one node).
    index("trigger_events_org_node_idx").on(table.orgId, table.workflowVersionId, table.nodeId),
    // Buffered-window reads: the resume backfill lists + counts a workflow's
    // `buffered` rows oldest-first. Without this the scan rides the
    // (org, createdAt) index and pays for the whole event history.
    index("trigger_events_org_workflow_status_idx").on(table.orgId, table.workflowId, table.status, table.createdAt),
    index("trigger_events_backfill_claim_idx")
      .on(table.orgId, table.workflowId, table.backfillClaimedAt)
      .where(sql`"status" = 'backfilling'`),
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
