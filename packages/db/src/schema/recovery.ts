/**
 * Failure, recovery case, replay, impact, alert, and supervised repair tables.
 *
 * Re-exported through `../schema.ts`; consumers should use `@janusly/db`.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Durable recovery projection independent from the DLQ-backed
 * `recovery_items` table. Semantic violations have no dead-letter identity,
 * so they use one case per `(orgId, runId, detectorId)` and retain their own
 * lifecycle without manufacturing a technical failure.
 *
 * Orphan-tolerant by design: run and workflow history may be retained or
 * purged on different schedules, while the case and its receipts remain
 * useful forensic evidence.
 */
export const recoveryCases = pgTable(
  "recovery_cases",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    runId: text("run_id").notNull(),
    workflowId: text("workflow_id"),
    workflowVersionId: text("workflow_version_id").notNull(),
    source: text("source")
      .$type<"semantic_violation">()
      .notNull(),
    detectorId: text("detector_id").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
    detectorKind: text("detector_kind")
      .$type<"expression" | "schema">()
      .notNull(),
    action: text("action")
      .$type<"observe" | "quarantine">()
      .notNull(),
    message: text("message").notNull(),
    detailsJson: jsonb("details_json"),
    state: text("state").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("recovery_cases_org_run_detector_idx").on(
      table.orgId,
      table.runId,
      table.detectorId,
    ),
    index("recovery_cases_org_state_created_idx").on(
      table.orgId,
      table.state,
      table.createdAt.desc(),
    ),
    index("recovery_cases_run_source_idx").on(
      table.runId,
      table.sourceNodeId,
    ),
  ],
);

/**
 * Append-only receipts for every durable Recovery Case transition. The
 * `(caseId, toState)` uniqueness makes the deterministic semantic-recovery
 * sequence safe to retry while preserving one receipt per reached state.
 */
export const recoveryCaseTransitions = pgTable(
  "recovery_case_transitions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    caseId: text("case_id").notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    actorKind: text("actor_kind")
      .$type<"system" | "user" | "agent">()
      .notNull(),
    actorId: text("actor_id"),
    evidenceJson: jsonb("evidence_json").notNull(),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("recovery_case_transitions_case_to_idx").on(
      table.caseId,
      table.toState,
    ),
    index("recovery_case_transitions_case_created_idx").on(
      table.caseId,
      table.occurredAt,
    ),
    index("recovery_case_transitions_org_created_idx").on(
      table.orgId,
      table.occurredAt.desc(),
    ),
  ],
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
    // Backs the status-filtered recovery-queue pages (`eq(status)` +
    // `ORDER BY created_at DESC, id DESC`). `.nullsFirst()` is load-bearing on
    // every keyset index here: `created_at` is nullable and a plain `ORDER BY
    // created_at DESC` means NULLS FIRST, so drizzle's default DESC NULLS LAST
    // cannot satisfy the sort and the planner re-sorts the org's DLQ per page.
    // A backward scan of the same index serves the `oldest` (ASC) sort.
    index("dead_letters_org_status_created_idx").on(
      table.orgId,
      table.status,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // Backs the recovery queue's default sorts (`newest` / `oldest`) when no
    // status filter is applied — with `status` in the middle of the index
    // above, Postgres can't produce keyset-ordered output and re-sorts the
    // org's entire DLQ per page.
    index("dead_letters_org_created_id_idx").on(
      table.orgId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
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
 * A named, bounded replay campaign over an immutable DLQ cohort snapshot.
 *
 * Campaigns deliberately keep counters on the parent row so progress reads
 * remain O(1); item transitions update the row in the same transaction. The
 * `nextDispatchAt` clock is a Postgres-owned repair boundary: a BullMQ publish
 * failure leaves the campaign discoverable by the scheduler instead of
 * stranding it in Redis. No foreign keys are intentional — campaign evidence
 * remains inspectable after ordinary DLQ/run retention.
 */
export const replayCampaigns = pgTable(
  "replay_campaigns",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    clusterSignature: text("cluster_signature").notNull(),
    filterJson: jsonb("filter_json").notNull().default({}),
    pacingMs: integer("pacing_ms").notNull().default(1000),
    status: text("status").notNull().default("running"),
    totalCount: integer("total_count").notNull(),
    replayedCount: integer("replayed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    cancelledCount: integer("cancelled_count").notNull().default(0),
    createdBy: text("created_by").notNull(),
    cancelledBy: text("cancelled_by"),
    nextDispatchAt: timestamp("next_dispatch_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Backs `listReplayCampaigns`' bounded `(created_at DESC, id DESC)` list;
    // NULLS FIRST + id tiebreaker so the index can serve the sort (see the
    // dead_letters keyset indexes for the rationale).
    index("replay_campaigns_org_created_id_idx").on(
      table.orgId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index("replay_campaigns_due_idx")
      .on(table.nextDispatchAt, table.id)
      .where(sql`"status" = 'running'`),
  ],
);

/**
 * Per-DLQ outcome ledger for one replay campaign.
 *
 * The claim token + timestamp form a recoverable lease. A worker crash can
 * reclaim a stale `processing` item, while the DLQ replay generation claim
 * prevents duplicate external execution. Campaign cancellation marks every
 * still-pending row cancelled; an already-processing row may finish and is
 * reported truthfully in the final counters.
 */
export const replayCampaignItems = pgTable(
  "replay_campaign_items",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    deadLetterId: text("dead_letter_id").notNull(),
    position: integer("position").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    error: text("error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("replay_campaign_items_campaign_dlq_idx").on(table.campaignId, table.deadLetterId),
    uniqueIndex("replay_campaign_items_campaign_position_idx").on(table.campaignId, table.position),
    index("replay_campaign_items_org_campaign_status_idx").on(
      table.orgId,
      table.campaignId,
      table.status,
      table.position,
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
    // the patch route enriches a new prompt. NULLS FIRST so the bounded
    // newest-first reads (`ORDER BY created_at DESC LIMIT n`) can be served
    // index-ordered (see the dead_letters keyset indexes for the rationale).
    index("recovery_feedback_org_workflow_created_idx").on(
      table.orgId,
      table.workflowId,
      table.createdAt.desc().nullsFirst(),
    ),
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
 * `status` is the source of truth for the apply race. Accepted decisions
 * first claim `validated → publishing`; `applied` is written only after the
 * production replay has an exact durable claim.
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
    // 'validation_failed' | 'publishing' | 'publish_failed' |
    // 'applied' | 'declined' | 'failed'.
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
    // Snapshot of the validation run's actual evidence strength.
    validationEvidenceLevel: text("validation_evidence_level"),
    // 'auto' / '<userId>' / 'system_decline_<reason>'; nullable until
    // decision. The audit row's userId mirrors this column.
    decisionActor: text("decision_actor"),
    // Stable idempotency receipt shared with the DLQ replay claim. A matching
    // dead_letters.replay_claim_token proves the production replay is durable.
    publicationReceipt: text("publication_receipt"),
    // Due clock for crash repair and bounded retry after publication failure.
    publicationRepairAfter: timestamp("publication_repair_after", { withTimezone: true }),
    publicationAttempts: integer("publication_attempts").notNull().default(0),
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
    index("auto_healing_runs_publication_repair_idx")
      .on(table.publicationRepairAfter, table.id)
      .where(sql`${table.publicationRepairAfter} IS NOT NULL AND ${table.status} IN ('publishing', 'publish_failed')`),
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
 * operator-click vs auto-apply can't double-apply (the same conditional-write
 * posture used by auto-healing publication claims).
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
