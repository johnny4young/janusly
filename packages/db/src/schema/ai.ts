/**
 * PromptOps, memory, evaluation, experiment, and calibration tables.
 *
 * Re-exported through `../schema.ts`; consumers should use `@janusly/db`.
 */

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
  vector,
} from "drizzle-orm/pg-core";

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
    // Backs `listPrompts`' bounded newest-first read. NULLS FIRST because
    // `createdAt` is nullable (see the dead_letters keyset indexes); the id
    // tiebreaker is ready for the deferred cursor pagination.
    index("prompts_org_created_id_idx").on(
      table.orgId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
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
