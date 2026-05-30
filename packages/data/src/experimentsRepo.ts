/**
 * Repository for the `experiments` table — org-scoped A/B comparisons of a
 * CONTROL vs a CANDIDATE (prompt version, model id, or both) measured
 * against an eval dataset.
 *
 * The route creates a row (`status: "pending"`), the runner produces a
 * summary, and `recordExperimentResult` flips the row to `completed` /
 * `failed` and stamps `summary_json` + `completed_at`. The orchestration
 * (running each example through both arms via `LlmClient.generateText`,
 * scoring, budget-gating) lives in `apps/api` + `packages/ai`; this repo
 * owns only the persistence.
 *
 * Used by:
 *  - `apps/api/src/routes/experiments-routes.ts` — create → run → record.
 *
 * Invariants:
 * - Multi-tenant scope on EVERY read/write: `eq(experiments.orgId, orgId)`.
 * - PROMOTION IS RECOMMENDATION-ONLY: this repo NEVER writes to `prompts` /
 *   `prompt_versions` / `org_configs`. The `summary_json.recommendation`
 *   field is advisory; the operator promotes through the existing surfaces.
 * - `summary_json` is sanitized by the CALLER through `safePersistPayload`
 *   (apps/api owns the engine dependency; `data` must not import `engine` —
 *   that would invert the dependency graph). The repo writes the
 *   already-safe object verbatim.
 * - Cascade posture: orphan-tolerant (no FK). Deleting the referenced eval
 *   dataset does NOT touch the experiment — the snapshot stands on its own.
 */

import { and, desc, eq } from "drizzle-orm";
import { db, experiments } from "@janusly/db";

/** Closed set of comparison kinds. */
export const EXPERIMENT_KINDS = ["prompt", "model", "prompt_and_model"] as const;
export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number];

/** Closed set of run statuses. */
export const EXPERIMENT_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export function isExperimentKind(value: unknown): value is ExperimentKind {
  return typeof value === "string" && (EXPERIMENT_KINDS as readonly string[]).includes(value);
}

export type Experiment = {
  id: string;
  orgId: string;
  name: string;
  kind: ExperimentKind;
  controlRef: string;
  candidateRef: string;
  evalDatasetId: string;
  scorerKind: string;
  status: ExperimentStatus;
  summaryJson: unknown;
  createdBy: string | null;
  createdAt: Date | null;
  completedAt: Date | null;
};

export type CreateExperimentInput = {
  orgId: string;
  name: string;
  kind: ExperimentKind;
  controlRef: string;
  candidateRef: string;
  evalDatasetId: string;
  scorerKind: string;
  createdBy: string | null;
};

function mapExperiment(row: typeof experiments.$inferSelect): Experiment {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    kind: row.kind as ExperimentKind,
    controlRef: row.controlRef,
    candidateRef: row.candidateRef,
    evalDatasetId: row.evalDatasetId,
    scorerKind: row.scorerKind,
    status: row.status as ExperimentStatus,
    summaryJson: row.summaryJson ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt ?? null,
    completedAt: row.completedAt ?? null,
  };
}

/**
 * Insert a new experiment in `running` state (the route runs the
 * comparison synchronously inside the same request, so it never lingers in
 * `pending`). Returns the persisted row.
 */
export async function createExperiment(input: CreateExperimentInput): Promise<Experiment> {
  const inserted = await db
    .insert(experiments)
    .values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      name: input.name,
      kind: input.kind,
      controlRef: input.controlRef,
      candidateRef: input.candidateRef,
      evalDatasetId: input.evalDatasetId,
      scorerKind: input.scorerKind,
      status: "running",
      createdBy: input.createdBy,
    })
    .returning();
  return mapExperiment(inserted[0]!);
}

/**
 * Flip an experiment to a terminal status and stamp its summary +
 * `completed_at`. CAS-scoped on `(orgId, id)` so a cross-org write is
 * impossible. The caller MUST have already passed `summary` through
 * `safePersistPayload` (key-redaction + size-bound) — `data` can't import
 * `engine`, so the sanitization chokepoint lives in the route.
 */
export async function recordExperimentResult(
  orgId: string,
  experimentId: string,
  status: Extract<ExperimentStatus, "completed" | "failed">,
  summary: Record<string, unknown>,
): Promise<Experiment | null> {
  const updated = await db
    .update(experiments)
    .set({ status, summaryJson: summary, completedAt: new Date() })
    .where(and(eq(experiments.orgId, orgId), eq(experiments.id, experimentId)))
    .returning();
  return updated[0] ? mapExperiment(updated[0]) : null;
}

/** List an org's experiments, newest first, bounded. */
export async function listExperiments(orgId: string, limit = 100): Promise<Experiment[]> {
  const rows = await db
    .select()
    .from(experiments)
    .where(eq(experiments.orgId, orgId))
    .orderBy(desc(experiments.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
  return rows.map(mapExperiment);
}

/** Fetch one experiment by id, org-scoped. Returns null when missing / cross-org. */
export async function getExperiment(orgId: string, experimentId: string): Promise<Experiment | null> {
  const rows = await db
    .select()
    .from(experiments)
    .where(and(eq(experiments.orgId, orgId), eq(experiments.id, experimentId)));
  return rows[0] ? mapExperiment(rows[0]) : null;
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate - see AGENTS.md "Decision engine / RL".
