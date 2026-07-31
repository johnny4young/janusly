/**
 * Workflow authoring, versioning, rollout, scheduling, and trigger tables.
 *
 * Re-exported through `../schema.ts`; consumers should use `@janusly/db`.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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
  (table) => [
    // Backs the Flows list keyset (`ORDER BY created_at DESC, id DESC`) —
    // without the `id` tiebreaker Postgres re-sorts the org's workflows on
    // every page. Supersedes the old (org_id, created_at) index (strict prefix).
    // `.nullsFirst()` is load-bearing: `created_at` is nullable and a plain
    // `ORDER BY created_at DESC` means NULLS FIRST, so drizzle's default
    // DESC NULLS LAST index cannot satisfy the sort and the planner re-sorts.
    index("workflows_org_created_id_idx").on(
      table.orgId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // Backs the Trash list keyset (`ORDER BY deleted_at DESC, id DESC`) and
    // the `system:retention` tombstone sweep; partial, so it only holds
    // soft-deleted rows. NULLS FIRST for the same sort-matching reason above.
    index("workflows_org_deleted_idx")
      .on(table.orgId, table.deletedAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`"deleted_at" IS NOT NULL`),
  ],
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

/**
 * Durable deployment decision between one baseline and one newer canary.
 *
 * One partial unique index permits at most one active rollout per workflow.
 * Historical rows remain inspectable after promotion, rollback, or operator
 * cancellation. No foreign keys: workflow/version history is intentionally
 * orphan-tolerant and retention owns eventual cleanup.
 */
export const workflowRollouts = pgTable(
  "workflow_rollouts",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    baselineVersionId: text("baseline_version_id").notNull(),
    canaryVersionId: text("canary_version_id").notNull(),
    trafficPercent: integer("traffic_percent").notNull(),
    minimumSampleSize: integer("minimum_sample_size").notNull(),
    minimumSuccessRatePercent: integer("minimum_success_rate_percent").notNull(),
    status: text("status")
      .$type<"active" | "promoted" | "rolled_back" | "cancelled">()
      .notNull()
      .default("active"),
    baselineSucceeded: integer("baseline_succeeded").notNull().default(0),
    baselineFailed: integer("baseline_failed").notNull().default(0),
    canarySucceeded: integer("canary_succeeded").notNull().default(0),
    canaryFailed: integer("canary_failed").notNull().default(0),
    rolledBackReason: text("rolled_back_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastOutcomeAt: timestamp("last_outcome_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("workflow_rollouts_one_active_idx")
      .on(table.orgId, table.workflowId)
      .where(sql`status = 'active'`),
    index("workflow_rollouts_org_workflow_created_idx")
      .on(table.orgId, table.workflowId, table.createdAt.desc()),
  ],
);

/**
 * Immutable pre-deployment evidence for one baseline/candidate version pair.
 *
 * The comparison replays deterministic Recovery Contract fixtures only; it
 * never executes a workflow node. A receipt is valid only for the exact
 * version ids, dataset evaluator version, and fixture digest captured here.
 * Repeating the same deterministic comparison converges on the unique row.
 *
 * Orphan-tolerant: workflow/version retention may remove the source snapshots,
 * while this receipt remains useful audit evidence.
 */
export const workflowRecoveryQualifications = pgTable(
  "workflow_recovery_qualifications",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    baselineVersionId: text("baseline_version_id").notNull(),
    candidateVersionId: text("candidate_version_id").notNull(),
    datasetVersion: text("dataset_version").notNull(),
    datasetDigest: text("dataset_digest").notNull(),
    mode: text("mode").$type<"bootstrap" | "compare">().notNull(),
    status: text("status").$type<"passed" | "failed">().notNull(),
    summaryJson: jsonb("summary_json").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workflow_recovery_qualifications_exact_idx").on(
      table.orgId,
      table.workflowId,
      table.baselineVersionId,
      table.candidateVersionId,
      table.datasetVersion,
      table.datasetDigest,
    ),
    index("workflow_recovery_qualifications_pair_idx").on(
      table.orgId,
      table.workflowId,
      table.baselineVersionId,
      table.candidateVersionId,
      table.createdAt.desc(),
    ),
  ],
);

/**
 * Idempotency receipt for terminal rollout evidence.
 *
 * One run contributes at most one outcome across worker retries and repair
 * sweeps. Rows are operationally meaningless without their rollout aggregate,
 * but remain orphan-tolerant to match workflow history's no-FK posture.
 */
export const workflowRolloutOutcomes = pgTable(
  "workflow_rollout_outcomes",
  {
    runId: text("run_id").primaryKey(),
    orgId: text("org_id").notNull(),
    rolloutId: text("rollout_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    variant: text("variant").$type<"baseline" | "canary">().notNull(),
    status: text("status").$type<"succeeded" | "failed" | "cancelled">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("workflow_rollout_outcomes_rollout_created_idx")
      .on(table.rolloutId, table.createdAt),
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
 * Structured inbound-trigger events for the event-driven trigger node types
 * (`webhook_received`, `email_received`, `file_dropped`, `mcp_server_event`).
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
    /** One of the closed event-driven `triggerNodeTypeValues`. */
    triggerType: text("trigger_type").notNull(),
    workflowId: text("workflow_id"),
    /** The workflow version whose trigger node matched the inbound event. */
    workflowVersionId: text("workflow_version_id").notNull(),
    /** Canary deployment captured when the event was first accepted. */
    workflowRolloutId: text("workflow_rollout_id"),
    /** Stable deployment variant; retries and buffered backfill never recalculate it. */
    workflowRolloutVariant: text("workflow_rollout_variant").$type<"baseline" | "canary">(),
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
    // Backs `listTriggerEvents`' newest-first keyset. NULLS FIRST because
    // `createdAt` is nullable (see the dead_letters keyset indexes); the id
    // tiebreaker is ready for the day the keyset gains its id tie-break
    // (today it paginates on `createdAt` alone).
    index("trigger_events_org_created_id_idx").on(
      table.orgId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
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
