/**
 * Repository for `eval_datasets` + `eval_examples` — the surface that
 * turns operator-approved recovery decisions into a reusable regression
 * bed for the AI patch surface.
 *
 * An admin creates a dataset; the create call pulls every ELIGIBLE
 * `recovery_feedback` row (accepted AND `eval_consent = true`) within an
 * optional workflow scope, distills each into a scrubbed `eval_examples`
 * row, and snapshots the count onto the dataset. The snapshot is taken
 * once at build time so a later retention purge of `recovery_feedback`
 * doesn't silently shrink an already-published dataset.
 *
 * Used by:
 *  - `apps/api/src/routes/eval-datasets-routes.ts` — admin CRUD + JSONL
 *    export (resolve → build/export → audit → respond).
 *
 * Invariants:
 *  - Multi-tenant scope on EVERY read/write: `eq(evalDatasets.orgId,
 *    orgId)` / `eq(evalExamples.orgId, orgId)`. A `datasetId` is always
 *    resolved through an org-scoped dataset read first.
 *  - OPT-IN GATE: `buildExamplesFromFeedback` filters
 *    `accepted = true AND eval_consent = true`. A row WITHOUT explicit
 *    consent is NEVER eligible, even if accepted.
 *  - Secret-shape scrubbing runs at WRITE time (here, when the example
 *    is built) AND again at READ time (in `@janusly/shared`'s
 *    `toEvalExampleJsonlRow` / `composeEvalExamplePrompt`) — defense in
 *    depth so a shape that slipped the first pass, or one introduced by
 *    a regex update, is still redacted before it leaves the process.
 *  - Cascade posture: orphan-tolerant elsewhere, but `deleteDataset`
 *    HARD-deletes the dataset's `eval_examples` rows in the same call —
 *    the child rows are meaningless without the parent (the
 *    `workflow_versions` precedent). `sourceFeedbackId` may reference a
 *    purged `recovery_feedback` row; the example carries its own
 *    scrubbed snapshot so it survives.
 */

import { and, desc, eq } from "drizzle-orm";
import { db, deadLetters, evalDatasets, evalExamples, recoveryFeedback } from "@janusly/db";
import { normalizeErrorSignature, scrubSecretShapes } from "@janusly/shared/src/error-signature";
import type { EvalExample } from "@janusly/shared/src/eval-dataset";

/** Hard cap on examples pulled into a single dataset build, to bound the write + the export size. */
export const MAX_EXAMPLES_PER_DATASET = 1_000;

/** Belt-and-braces ceiling on a scrubbed free-text field at write time. */
const FIELD_WRITE_CAP = 2_000;

/** Allowed retention-day range; null = indefinite. Mirrors the org retention catalog bounds. */
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3_650;

export type EvalDataset = {
  id: string;
  orgId: string;
  name: string;
  description: string;
  workflowId: string | null;
  exampleCount: number;
  retentionDays: number | null;
  createdBy: string | null;
  createdAt: Date | null;
};

export type CreateEvalDatasetInput = {
  orgId: string;
  name: string;
  description?: string | null;
  /** When set, only this workflow's eligible feedback rows are pulled. */
  workflowId?: string | null;
  retentionDays?: number | null;
  createdBy: string | null;
};

export type CreateEvalDatasetResult = {
  dataset: EvalDataset;
  /** Number of eligible feedback rows distilled into examples. */
  exampleCount: number;
};

function mapDataset(row: typeof evalDatasets.$inferSelect): EvalDataset {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    description: row.description,
    workflowId: row.workflowId ?? null,
    exampleCount: row.exampleCount,
    retentionDays: row.retentionDays ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt ?? null,
  };
}

function mapExample(row: typeof evalExamples.$inferSelect): EvalExample {
  return {
    id: row.id,
    datasetId: row.datasetId,
    sourceFeedbackId: row.sourceFeedbackId,
    workflowId: row.workflowId ?? null,
    deadLetterId: row.deadLetterId ?? null,
    failureSignature: row.failureSignature,
    inputContext: row.inputContext,
    expectedApproachLabel: row.expectedApproachLabel,
    accepted: row.accepted,
    suggestionMode: row.suggestionMode,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
  };
}

function clampWrite(value: string): string {
  const scrubbed = scrubSecretShapes(value);
  return scrubbed.length > FIELD_WRITE_CAP ? scrubbed.slice(0, FIELD_WRITE_CAP) : scrubbed;
}

function clampRetention(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  const int = Math.trunc(value);
  if (int < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  if (int > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS;
  return int;
}

/**
 * The raw eligible-feedback shape the example builder consumes. One row
 * per `recovery_feedback` join `dead_letters` (LEFT join — the DLQ row
 * may be gone, in which case the failure signature is derived from the
 * comment alone).
 */
type EligibleFeedbackRow = {
  feedbackId: string;
  workflowId: string;
  deadLetterId: string;
  approachLabel: string;
  suggestionMode: string;
  comment: string | null;
  errorJson: unknown;
  nodeJson: unknown;
};

/**
 * Pull eligible recovery-feedback rows for an org (optionally scoped to a
 * workflow). ELIGIBILITY = `accepted = true AND eval_consent = true`.
 * LEFT-joins `dead_letters` (org-scoped) so the builder can derive the
 * failure signature; an orphaned feedback row (DLQ purged) still yields an
 * example with an empty signature.
 *
 * Exported for direct testing of the opt-in gate.
 */
export async function queryEligibleFeedbackForEval(
  orgId: string,
  workflowId: string | null,
): Promise<EligibleFeedbackRow[]> {
  const conditions = [
    eq(recoveryFeedback.orgId, orgId),
    eq(recoveryFeedback.accepted, true),
    eq(recoveryFeedback.evalConsent, true),
  ];
  if (workflowId) conditions.push(eq(recoveryFeedback.workflowId, workflowId));

  const rows = await db
    .select({
      feedbackId: recoveryFeedback.id,
      workflowId: recoveryFeedback.workflowId,
      deadLetterId: recoveryFeedback.deadLetterId,
      approachLabel: recoveryFeedback.approachLabel,
      suggestionMode: recoveryFeedback.suggestionMode,
      comment: recoveryFeedback.comment,
      errorJson: deadLetters.errorJson,
      nodeJson: deadLetters.nodeJson,
    })
    .from(recoveryFeedback)
    // Org-scoped LEFT join: match the DLQ row only within the same tenant
    // so a corrupt `dead_letter_id` can't pull a foreign org's failure.
    .leftJoin(
      deadLetters,
      and(eq(deadLetters.id, recoveryFeedback.deadLetterId), eq(deadLetters.orgId, orgId)),
    )
    .where(and(...conditions))
    .orderBy(desc(recoveryFeedback.createdAt))
    .limit(MAX_EXAMPLES_PER_DATASET);

  return rows;
}

/** Derive the scrubbed failure signature for one eligible feedback row. */
function deriveSignature(row: EligibleFeedbackRow): string {
  try {
    const node = row.nodeJson as { type?: unknown; config?: { tool?: unknown } } | null;
    const nodeType = typeof node?.type === "string" ? node.type : undefined;
    const toolName = typeof node?.config?.tool === "string" ? node.config.tool : undefined;
    // `normalizeErrorSignature` already scrubs its output; clampWrite is a
    // second pass + length bound.
    return clampWrite(normalizeErrorSignature(row.errorJson, { nodeType, toolName }).signature);
  } catch {
    return "";
  }
}

/**
 * Create a dataset and snapshot its examples in one transaction. Pulls
 * eligible feedback (consent gate enforced in
 * `queryEligibleFeedbackForEval`), distills each into a scrubbed example,
 * and writes the denormalized count onto the dataset row.
 *
 * Throws on a duplicate `(orgId, name)` (the unique index) — the route
 * maps that to a 409.
 */
export async function createEvalDataset(input: CreateEvalDatasetInput): Promise<CreateEvalDatasetResult> {
  const workflowId = input.workflowId ?? null;
  const eligible = await queryEligibleFeedbackForEval(input.orgId, workflowId);

  const datasetId = crypto.randomUUID();
  const retentionDays = clampRetention(input.retentionDays);
  const description = input.description ? clampWrite(input.description) : "";

  const exampleRows = eligible.map((row) => ({
    id: crypto.randomUUID(),
    orgId: input.orgId,
    datasetId,
    sourceFeedbackId: row.feedbackId,
    workflowId: row.workflowId,
    deadLetterId: row.deadLetterId,
    failureSignature: deriveSignature(row),
    // The operator comment is the captured input context. Scrubbed +
    // length-bounded at write time; re-scrubbed at read time downstream.
    inputContext: row.comment ? clampWrite(row.comment) : "",
    expectedApproachLabel: row.approachLabel,
    accepted: true,
    suggestionMode: row.suggestionMode,
  }));

  const datasetRow = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(evalDatasets)
      .values({
        id: datasetId,
        orgId: input.orgId,
        name: input.name,
        description,
        workflowId,
        exampleCount: exampleRows.length,
        retentionDays,
        createdBy: input.createdBy,
      })
      .returning();
    if (exampleRows.length > 0) {
      await tx.insert(evalExamples).values(exampleRows);
    }
    return inserted[0]!;
  });

  return { dataset: mapDataset(datasetRow), exampleCount: exampleRows.length };
}

/** List an org's datasets, newest first, bounded. */
export async function listEvalDatasets(orgId: string, limit = 100): Promise<EvalDataset[]> {
  const rows = await db
    .select()
    .from(evalDatasets)
    .where(eq(evalDatasets.orgId, orgId))
    .orderBy(desc(evalDatasets.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
  return rows.map(mapDataset);
}

/** Find a dataset by name within an org (for the up-front duplicate-name 409). */
export async function findEvalDatasetByName(orgId: string, name: string): Promise<EvalDataset | null> {
  const rows = await db
    .select()
    .from(evalDatasets)
    .where(and(eq(evalDatasets.orgId, orgId), eq(evalDatasets.name, name)));
  return rows[0] ? mapDataset(rows[0]) : null;
}

/** Fetch one dataset by id, org-scoped. Returns null when missing / cross-org. */
export async function getEvalDataset(orgId: string, datasetId: string): Promise<EvalDataset | null> {
  const rows = await db
    .select()
    .from(evalDatasets)
    .where(and(eq(evalDatasets.orgId, orgId), eq(evalDatasets.id, datasetId)));
  return rows[0] ? mapDataset(rows[0]) : null;
}

/**
 * Fetch a dataset's examples, org-scoped, bounded. Examples carry the
 * write-time-scrubbed snapshot; callers re-scrub at read time via the
 * shared serializer/composer before exposing the data.
 */
export async function listEvalExamples(orgId: string, datasetId: string): Promise<EvalExample[]> {
  const rows = await db
    .select()
    .from(evalExamples)
    .where(and(eq(evalExamples.orgId, orgId), eq(evalExamples.datasetId, datasetId)))
    .orderBy(desc(evalExamples.createdAt))
    .limit(MAX_EXAMPLES_PER_DATASET);
  return rows.map(mapExample);
}

/**
 * Hard-delete a dataset AND its examples (org-scoped). Returns false when
 * the dataset doesn't exist for this org (the route 404s). Children are
 * removed first so a partial failure can't orphan example rows under a
 * still-present parent.
 */
export async function deleteEvalDataset(orgId: string, datasetId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: evalDatasets.id })
      .from(evalDatasets)
      .where(and(eq(evalDatasets.orgId, orgId), eq(evalDatasets.id, datasetId)));
    if (existing.length === 0) return false;

    await tx
      .delete(evalExamples)
      .where(and(eq(evalExamples.orgId, orgId), eq(evalExamples.datasetId, datasetId)));
    await tx
      .delete(evalDatasets)
      .where(and(eq(evalDatasets.orgId, orgId), eq(evalDatasets.id, datasetId)));
    return true;
  });
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate - see AGENTS.md "Decision engine / RL".
