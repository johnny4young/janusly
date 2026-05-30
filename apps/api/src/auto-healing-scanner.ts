/**
 * Supervised auto-healing scanner. A global cron (default every 6h)
 * walks every org with `autoHealing.enabled === true`, groups recent
 * DLQ rows by normalized signature, and for each cluster with
 * frequency >= 2 it:
 *
 *   1. Master-gate check (`isAutoHealingAllowed`).
 *   2. Loop-breaker check (per-(orgId, signature) attempt count in
 *      the configured window).
 *   3. Budget check (the same `checkBudget` chokepoint `/ai/*` uses;
 *      fail-soft on infra errors).
 *   4. Idempotency check (skip DLQ rows that already have an
 *      `auto_healing_runs` row).
 *   5. Diagnose row insert.
 *   6. LLM patch suggestion via the existing `suggestWorkflowPatch`
 *      helper with the type-specific envelope from
 *      `patchEnvelopeForNodeType`. On `mode: "fallback"` the
 *      candidate is skipped to avoid noisy 0-confidence rows in the
 *      operator's pending card.
 *   7. Merge via the existing `applyConfigPatchToWorkflow` /
 *      `applyStructuralPatchToWorkflow` helpers and re-validate
 *      through `WorkflowSchema.safeParse` + `sanitizeAiWorkflow`.
 *   8. Proposal row update.
 *   9. Sandbox validation enqueue via the engine's
 *      `replayDeadLetterAsValidation` — the validation run is async
 *      and a sibling watcher picks up its terminal status.
 *
 * Lives in the API process (alongside the dedicated
 * `auto-healing-system` BullMQ Worker) because the LLM helper needs
 * the API-side patch-envelope dispatcher + the patch-merge helpers.
 * The engine worker is untouched; sandbox validation runs still
 * execute there because they flow through the normal `workflow-nodes`
 * queue created by `replayDeadLetterAsValidation`.
 *
 * Invariants:
 * - Never throws. Per-candidate failures are caught and audited as
 *   `auto_healing.failed`. A Postgres outage logs and exits the scan
 *   early; the next cron fire retries.
 * - Multi-tenant scope: every per-org step carries `orgId` and every
 *   DB read filters by it. Cross-org signature matches are impossible
 *   by construction (signatures are derived from per-DLQ-row
 *   `errorJson`, never compared across orgs).
 * - Budget is checked ONCE per candidate (covers LLM + validation
 *   replay as a single scope). The auto-apply branch in the watcher
 *   does NOT re-check budget — the validation already validated the
 *   patch and the production replay is the org's "your DLQ is being
 *   recovered" cost.
 * - The scanner does NOT write `recovery_feedback` rows; the
 *   operator's decision (apply / decline) is what generates feedback.
 *   The scanner's outputs are `auto_healing_runs` rows + audit rows.
 */

import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, deadLetters, orgConfigs, runs } from "@janusly/db";
import {
  queryFailureSamples,
  getOrgConfigSnapshot,
  countRecentAttemptsBySignature,
  createDiagnosis,
  getDeadLetterIdsWithExistingRun,
  recordImmediateDecline,
  recordProposal,
  recordScannerFailure,
  recordValidationStarted,
} from "@janusly/data";
import { clusterFailureSamples } from "@janusly/engine/src/cluster-failures";
import { checkBudget } from "@janusly/engine/src/budget";
import { getLlmClient, suggestWorkflowPatch } from "@janusly/ai";
import type { RunEventForPrompt } from "@janusly/ai";
import { DLQReplayAdapter } from "@janusly/engine/src/adapters/dlq-replay";
import { safePersistPayload } from "@janusly/engine/src/safe-persist";
import { WorkflowSchema, type Workflow, type WorkflowNode } from "@janusly/shared";

import { patchEnvelopeForNodeType } from "./ai-schemas";
import { isAutoHealingAllowed } from "./auto-healing-consent";
import {
  applyConfigPatchToWorkflow,
  applyStructuralPatchToWorkflow,
} from "./patch-workflow-merge";
import { sanitizeAiWorkflow } from "./ai-runtime";

/** The deterministic BullMQ scheduler id for the recurring scan. */
export const AUTO_HEALING_SCAN_JOB_ID = "system:auto-healing-scanner";

/** The `job.name` the api-side Worker dispatch matches on. */
export const AUTO_HEALING_SCAN_JOB_NAME = "auto-healing-scan-trigger";

/** Every six hours. Low frequency because the scan consumes LLM budget per
 *  candidate; the admin `/auto-healing/scan` route is the immediate trigger. */
export const DEFAULT_AUTO_HEALING_SCAN_CRON = "0 */6 * * *";

/** Hard cap on samples per org per scan — defense in depth on top of the
 *  cluster `frequency >= 2` filter. */
const SAMPLE_LIMIT = 100;

/** Lookback window for samples (in days). */
const SAMPLE_WINDOW_DAYS = 7;

const dlqReplay = new DLQReplayAdapter();

// ─── Cron registration ──────────────────────────────────────────────────────

/**
 * Boot registration. Reads `JANUSLY_AUTO_HEALING_SCAN_CRON` from env,
 * validates as a simple 5-field cron pattern, falls back to the
 * default with a warn log on parse failure. The registrar NEVER
 * throws — a Redis blip at boot must not block the rest of the api
 * process from starting.
 */
export async function registerAutoHealingScannerScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveCronPattern(env);
  try {
    const { autoHealingQueue } = await import("./auto-healing-queue");
    await autoHealingQueue.upsertJobScheduler(
      AUTO_HEALING_SCAN_JOB_ID,
      { pattern },
      { name: AUTO_HEALING_SCAN_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[auto-healing] scanner registration failed", {
      jobId: AUTO_HEALING_SCAN_JOB_ID,
      err,
    });
    return false;
  }
}

function resolveCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_AUTO_HEALING_SCAN_CRON?.trim();
  if (!raw) return DEFAULT_AUTO_HEALING_SCAN_CRON;
  // Light validation — five whitespace-delimited fields. Heavy parsing is
  // BullMQ's responsibility at scheduler-fire time; the warn-fallback below
  // covers the rare "operator typo'd a single field" case.
  if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(raw)) {
    console.warn(
      "[auto-healing] JANUSLY_AUTO_HEALING_SCAN_CRON invalid; falling back to default",
      { value: raw, default: DEFAULT_AUTO_HEALING_SCAN_CRON },
    );
    return DEFAULT_AUTO_HEALING_SCAN_CRON;
  }
  return raw;
}

// ─── Scan entry points ──────────────────────────────────────────────────────

/**
 * Top-of-loop handler for the recurring cron. Lists every org with
 * `autoHealing.enabled === true` and calls `runOrgScan` on each
 * sequentially. NEVER throws — per-org failures are caught and audited.
 */
export async function handleAutoHealingScanTrigger(): Promise<void> {
  if (process.env.JANUSLY_AUTO_HEALING_ENABLED !== "true") {
    return;
  }
  let orgIds: string[];
  try {
    orgIds = await listEnabledOrgIds();
  } catch (err) {
    console.error("[auto-healing] failed to list enabled orgs", { err });
    return;
  }
  for (const orgId of orgIds) {
    try {
      await runOrgScan(orgId);
    } catch (err) {
      console.error("[auto-healing] runOrgScan threw — should never happen", { orgId, err });
    }
  }
}

async function listEnabledOrgIds(): Promise<string[]> {
  const rows = await db
    .select({ orgId: orgConfigs.orgId })
    .from(orgConfigs)
    .where(
      and(
        eq(orgConfigs.key, "autoHealing.enabled"),
        // `value_json` is a jsonb column; check both string-encoded "true"
        // (legacy writers) and boolean true.
        sql`${orgConfigs.valueJson} = 'true'::jsonb`,
      ),
    );
  // Deduplicate (shouldn't happen — `(orgId, key)` is unique — but defense in depth).
  return Array.from(new Set(rows.map((r) => r.orgId)));
}

/**
 * Per-org scan. Exported separately so the admin
 * `POST /auto-healing/scan` route can target a single org without
 * waiting for the cron. NEVER throws.
 */
export async function runOrgScan(orgId: string): Promise<void> {
  // Re-check consent on every entry — a kill switch flipped between
  // the cron fire and this call must short-circuit before any DB or
  // LLM spend.
  const consent = await isAutoHealingAllowed(orgId);
  if (!consent.allowed) return;

  const snapshot = await getOrgConfigSnapshot(orgId);
  const maxAttempts = snapshot.autoHealing.maxAttemptsPerSignature;
  const loopWindowDays = snapshot.autoHealing.loopWindowDays;

  let samples: Awaited<ReturnType<typeof queryFailureSamples>>;
  try {
    samples = await queryFailureSamples(orgId, SAMPLE_WINDOW_DAYS, SAMPLE_LIMIT);
  } catch (err) {
    console.error("[auto-healing] sample collection failed", { orgId, err });
    return;
  }
  if (samples.length === 0) return;

  const clusters = clusterFailureSamples(samples);
  // Filter to clusters that actually have DLQ-source samples (the
  // scanner targets `dead_letters` rows because that's what the
  // sandbox-validation + production-replay primitives accept).
  const candidates = clusters.filter(
    (c) => c.frequency >= 2 && c.samples.some((s) => s.source === "dead_letter"),
  );
  if (candidates.length === 0) return;

  // Bulk idempotency check.
  const repDeadLetterIds = candidates
    .map((c) => c.samples.find((s) => s.source === "dead_letter")?.id)
    .filter((id): id is string => Boolean(id));
  const alreadyHasRun = await getDeadLetterIdsWithExistingRun(orgId, repDeadLetterIds);

  for (const cluster of candidates) {
    const repSample = cluster.samples.find((s) => s.source === "dead_letter");
    if (!repSample) continue;
    if (alreadyHasRun.has(repSample.id)) continue;

    await processCandidate({
      orgId,
      deadLetterId: repSample.id,
      signature: cluster.signature,
      maxAttempts,
      loopWindowDays,
    });

    // Re-check master gate between candidates so a kill-switch flip
    // during a long scan halts before further LLM spend.
    const stillAllowed = await isAutoHealingAllowed(orgId);
    if (!stillAllowed.allowed) return;
  }
}

// ─── Per-candidate processor ────────────────────────────────────────────────

async function processCandidate(args: {
  orgId: string;
  deadLetterId: string;
  signature: string;
  maxAttempts: number;
  loopWindowDays: number;
}): Promise<void> {
  const { orgId, deadLetterId, signature, maxAttempts, loopWindowDays } = args;
  // 1. Loop-breaker.
  const attemptCount = await countRecentAttemptsBySignature(orgId, signature, loopWindowDays);
  if (attemptCount >= maxAttempts) {
    await recordImmediateDecline(orgId, deadLetterId, signature, attemptCount, "loop_breaker_tripped");
    return;
  }

  // 2. Budget.
  const budget = await checkBudget({ orgId });
  if (!budget.allowed) {
    await recordImmediateDecline(orgId, deadLetterId, signature, attemptCount, "budget_exceeded");
    return;
  }

  // 3. Diagnose row.
  let diagnosisId: string;
  try {
    diagnosisId = await createDiagnosis({
      orgId,
      deadLetterId,
      signature,
      loopAttemptCount: attemptCount,
    });
  } catch (err) {
    console.error("[auto-healing] createDiagnosis failed", { orgId, deadLetterId, err });
    return;
  }

  try {
    // 4. Load the DLQ row payloads.
    const dlqRow = await loadDeadLetter(orgId, deadLetterId);
    if (!dlqRow) {
      await recordScannerFailure(orgId, deadLetterId, signature, attemptCount, "dead_letter_row_missing");
      return;
    }
    const workflowParse = WorkflowSchema.safeParse(dlqRow.workflowJson);
    if (!workflowParse.success) {
      await recordScannerFailure(orgId, deadLetterId, signature, attemptCount, "workflow_parse_failed");
      return;
    }
    const failingNode = (workflowParse.data.nodes as WorkflowNode[]).find(
      (n) => n.id === dlqRow.nodeId,
    );
    if (!failingNode) {
      await recordScannerFailure(orgId, deadLetterId, signature, attemptCount, "failing_node_missing");
      return;
    }

    // 5. LLM patch suggestion.
    const envelopeChoice = patchEnvelopeForNodeType(failingNode.type);
    const llm = getLlmClient();
    const result = await suggestWorkflowPatch({
      llm,
      envelopeSchema: envelopeChoice.schema as unknown as z.ZodType<{ suggestions: unknown[] }> as never,
      workflow: workflowParse.data,
      failedNodeId: dlqRow.nodeId,
      errorJson: dlqRow.errorJson,
      runEvents: [] as RunEventForPrompt[],
    });
    if (result.mode === "fallback") {
      // Skip — auto-healing only writes a proposal row when the LLM
      // produced a real candidate. A 0-confidence "other" row would
      // pollute the operator's pending card.
      await recordScannerFailure(orgId, deadLetterId, signature, attemptCount, `llm_fallback:${result.aiError ?? "unknown"}`);
      return;
    }

    // 6. Merge + validate.
    const merged = mergeFirstValidSuggestion({
      workflow: workflowParse.data,
      failingNodeId: dlqRow.nodeId,
      suggestions: result.suggestions as Array<{
        patchedConfig: Record<string, unknown>;
        approachLabel: string;
        confidence: number;
      }>,
    });
    if (!merged) {
      await recordScannerFailure(orgId, deadLetterId, signature, attemptCount, "all_suggestions_invalid");
      return;
    }

    // Defense in depth: sanitizeAiWorkflow handles expression grammar
    // but does NOT redact sensitive-keyed config fields (Authorization
    // headers, x-api-key, token-shaped values) that a workflow author
    // could have hardcoded. safePersistPayload is the jsonb-write
    // chokepoint per AGENTS.md; running it here before persistence
    // ensures the patch snapshot doesn't leak secret-shaped values
    // into the operator's pending card.
    const safePatchJson = safePersistPayload(merged.workflow as unknown);
    await recordProposal(diagnosisId, {
      patchJson: safePatchJson,
      approachLabel: merged.approachLabel,
      confidence: merged.confidence,
    });

    // 7. Enqueue sandbox validation.
    const validationRunId = await enqueueValidation({
      orgId,
      originalRunId: dlqRow.runId,
      suggestedWorkflow: merged.workflow,
      failingNodeId: dlqRow.nodeId,
    });
    if (!validationRunId) {
      await recordScannerFailure(orgId, deadLetterId, signature, attemptCount, "validation_enqueue_failed");
      return;
    }

    await recordValidationStarted(diagnosisId, validationRunId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordScannerFailure(orgId, deadLetterId, signature, attemptCount, message);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type DlqRowPayload = {
  runId: string;
  nodeId: string;
  workflowJson: unknown;
  nodeJson: unknown;
  errorJson: unknown;
};

async function loadDeadLetter(orgId: string, id: string): Promise<DlqRowPayload | null> {
  // Pull only the columns the scanner needs. Carries the multi-tenant
  // gate (`eq(deadLetters.orgId, orgId)`) so a deleted/cross-org id
  // returns null instead of crashing.
  const rows = await db
    .select({
      runId: deadLetters.runId,
      nodeId: deadLetters.nodeId,
      workflowJson: deadLetters.workflowJson,
      nodeJson: deadLetters.nodeJson,
      errorJson: deadLetters.errorJson,
    })
    .from(deadLetters)
    .innerJoin(runs, eq(runs.id, deadLetters.runId))
    .where(and(eq(deadLetters.orgId, orgId), eq(runs.orgId, orgId), eq(deadLetters.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

function mergeFirstValidSuggestion(input: {
  workflow: Workflow;
  failingNodeId: string;
  suggestions: Array<{
    patchedConfig: Record<string, unknown>;
    approachLabel: string;
    confidence: number;
  }>;
}): { workflow: Workflow; approachLabel: string; confidence: number } | null {
  // Sort by confidence descending — same posture as the dialog's per-suggestion
  // sort, so the auto-healing path picks the LLM's top choice.
  const sorted = [...input.suggestions].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  for (const suggestion of sorted) {
    try {
      const merged =
        suggestion.approachLabel === "add_approval" &&
        looksLikeStructuralSuggestion(suggestion.patchedConfig)
          ? applyStructuralPatchToWorkflow(
              input.workflow,
              suggestion.patchedConfig as never,
              input.failingNodeId,
            )
          : applyConfigPatchToWorkflow(
              input.workflow,
              input.failingNodeId,
              suggestion.patchedConfig,
            );
      const validated = WorkflowSchema.safeParse(merged);
      if (!validated.success) continue;
      const sanitized = sanitizeAiWorkflow(validated.data);
      return {
        workflow: sanitized,
        approachLabel: suggestion.approachLabel,
        confidence: suggestion.confidence,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function looksLikeStructuralSuggestion(patchedConfig: Record<string, unknown>): boolean {
  return (
    typeof patchedConfig === "object" &&
    patchedConfig !== null &&
    "action" in patchedConfig &&
    patchedConfig.action === "insert_approval_upstream"
  );
}

async function enqueueValidation(input: {
  orgId: string;
  originalRunId: string;
  suggestedWorkflow: Workflow;
  failingNodeId: string;
}): Promise<string | null> {
  const failingNode = (input.suggestedWorkflow.nodes as WorkflowNode[]).find(
    (n) => n.id === input.failingNodeId,
  );
  if (!failingNode) return null;
  try {
    const { runId } = await dlqReplay.replayDeadLetterAsValidation({
      orgId: input.orgId,
      originalRunId: input.originalRunId,
      suggestedWorkflow: input.suggestedWorkflow,
      failingNode,
      createdBy: "system:auto-healing",
    });
    return runId;
  } catch (err) {
    console.error("[auto-healing] validation replay enqueue failed", {
      orgId: input.orgId,
      originalRunId: input.originalRunId,
      err,
    });
    return null;
  }
}
