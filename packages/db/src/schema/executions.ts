/**
 * Run lifecycle, runtime learning, and usage accounting tables.
 *
 * Re-exported through `../schema.ts`; consumers should use `@janusly/db`.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("default"),
    workflowVersionId: text("workflow_version_id").notNull(),
    /** Rollout assignment captured once at start; retries never recalculate it. */
    workflowRolloutId: text("workflow_rollout_id"),
    workflowRolloutVariant: text("workflow_rollout_variant").$type<"baseline" | "canary">(),
    status: text("status").notNull(),
    /**
     * Business-outcome posture, independent from technical run status.
     * NULL means no semantic detector has failed. A run may therefore be
     * technically `succeeded` while this records `semantic_violation`.
     */
    outcomeStatus: text("outcome_status").$type<
      | "semantic_violation"
      | "semantic_quarantined"
      | "semantic_recovered"
      | "semantic_accepted_loss"
    >(),
    /** Total distinct semantic detectors that have failed on this run. */
    semanticViolationCount: integer("semantic_violation_count")
      .notNull()
      .default(0),
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
    /**
     * What a validation run actually proved. `writes_skipped` means at least
     * one external mutation was deliberately omitted and must not be treated
     * as provider-verified evidence.
     */
    validationEvidenceLevel: text("validation_evidence_level"),
    /** Atomic per-run idempotency claim for Recovery Playbook validation accounting. */
    recoveryPlaybookValidationRecordedAt: timestamp("recovery_playbook_validation_recorded_at", { withTimezone: true }),
    /** Atomic per-run idempotency claim for Recovery Playbook production-use accounting. */
    recoveryPlaybookAppliedRecordedAt: timestamp("recovery_playbook_applied_recorded_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // Backs the `GET /runs` keyset (`ORDER BY created_at DESC, id DESC`) —
    // without the `id` tiebreaker Postgres cannot satisfy the sort from the
    // index and top-N re-sorts the org's ENTIRE runs on every page (O(org-runs)
    // per page). Supersedes the old (org_id, created_at) index (strict prefix).
    // `.nullsFirst()` is load-bearing: `created_at` is nullable and a plain
    // `ORDER BY created_at DESC` means NULLS FIRST, so drizzle's default
    // DESC NULLS LAST index cannot satisfy the sort and the planner re-sorts.
    index("runs_org_created_id_idx").on(
      table.orgId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("runs_parent_idx").on(table.parentRunId),
    index("runs_parent_notification_idx")
      .on(table.parentNotificationAfter, table.id)
      .where(sql`"parent_notification_after" IS NOT NULL`),
    index("runs_org_replay_mode_idx").on(table.orgId, table.replayMode),
    index("runs_rollout_idx").on(table.workflowRolloutId, table.createdAt.desc()),
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
