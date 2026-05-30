/**
 * Evidence assembler for the AI suggestion routes. Projects the context the
 * prompt composer already gathered into a flat `EvidenceRow[]` "Why this
 * suggestion?" side-channel — NO second LLM call. The shared shape + the
 * read-time scrubber live in `@janusly/shared/src/ai-evidence`; this module
 * owns the SOURCE → row mapping for each of the six evidence kinds.
 *
 * Used by:
 *  - `apps/api/src/routes/ai-routes.ts:POST /ai/patch-workflow` — the
 *    recovery path. Has every source (feedback, memory, runbook, recent
 *    errors, signature rule, tool contract), so it produces the richest
 *    evidence list.
 *  - `apps/api/src/routes/ai-routes.ts:POST /ai/explain-run` — has the run
 *    id + the fired signature rule on the failing node; emits a smaller list.
 *  - `apps/api/src/routes/ai-routes.ts:POST /ai/suggest-improvement` — an
 *    authoring surface with no failing node, so its evidence is whatever
 *    past-feedback + runbook context the workflow carries (often empty —
 *    `evidence: []` is a valid response).
 *
 * Design:
 *  - The per-kind builders are PURE (no I/O) so the test suite pins each one
 *    against fixtures for the empty case, link integrity, and redaction.
 *  - The two sources the patch route did NOT already load (the workflow
 *    runbook + the recent failure samples) are fetched by the thin async
 *    `assembleRecoveryEvidence` orchestrator, which calls the pure builders.
 *  - Every assembled list is funnelled through `scrubEvidenceRows` (the
 *    shared read-time redaction + bounding pass) before it is returned, so
 *    the AC's "scrubbed at read even though scrubbed at write" holds on
 *    every path including the orchestrator's own composition.
 *  - Multi-tenant: the orchestrator's two reads carry `orgId`; the builders
 *    receive already-org-scoped rows. No builder touches `process.env` or
 *    issues a cross-org query.
 */

import {
  getWorkflowMetadata,
  queryFailureSamples,
  type FailureSample,
  type FeedbackSummary,
  type MemoryRecallEntry,
} from "@janusly/data";
import { scrubEvidenceRows, type EvidenceRow } from "@janusly/shared";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";

/** Hard cap on recent-error evidence rows. The window is large; the panel
 *  only needs a few representative recent failures, not the full history. */
const MAX_RECENT_ERROR_ROWS = 4;

/** Hard cap on runbook excerpt length before it becomes an evidence snippet
 *  (the shared scrubber caps again at `MAX_SNIPPET_CHARS`, but trimming here
 *  keeps the first meaningful line rather than an arbitrary 400-char slice). */
const RUNBOOK_EXCERPT_CHARS = 280;

/** Window + sample caps for the recent-error read. Narrower than the
 *  cluster surface's defaults — evidence wants a handful of recent matches,
 *  not a representative cluster sample. */
const RECENT_ERROR_WINDOW_DAYS = 14;
const RECENT_ERROR_SCAN_LIMIT = 60;

/**
 * Past-feedback evidence — one row per `approachLabel` the operator has
 * decided on for this workflow. `sourceRef` is the approach label (the
 * summary is an aggregation, so there is no single-row id to deep-link).
 * Skips approaches with zero decisions. Pure.
 */
export function buildFeedbackEvidence(summaries: readonly FeedbackSummary[]): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  for (const summary of summaries) {
    const total = summary.acceptedCount + summary.rejectedCount;
    if (total === 0) continue;
    const reasonTail = summary.rejectionComments.length > 0
      ? ` · last pushback: ${summary.rejectionComments[0]}`
      : "";
    rows.push({
      kind: "recovery_feedback",
      sourceRef: summary.approachLabel,
      snippet: `${summary.approachLabel}: ${summary.acceptedCount} accepted / ${summary.rejectedCount} rejected${reasonTail}`,
      // Weight by acceptance ratio so the renderer can sort the strongest
      // signal first. Half-credit when there is no decision history yet
      // (guarded above, so total > 0 here).
      weight: summary.acceptedCount / total,
    });
  }
  return rows;
}

/**
 * Memory evidence — one row per recalled `memory_entries` row, only present
 * when the org has memory enabled (the caller passes `[]` otherwise). The
 * entry id is the deep-link `sourceRef`. `weight` carries the pgvector
 * cosine similarity. Pure.
 */
export function buildMemoryEvidence(entries: readonly MemoryRecallEntry[]): EvidenceRow[] {
  return entries.map((entry) => ({
    kind: "memory_entry" as const,
    sourceRef: entry.id,
    snippet: `${entry.kind}: ${entry.content}`,
    // Clamp the similarity into [0,1]; the scrubber clamps again defensively.
    weight: Number.isFinite(entry.similarity) ? Math.max(0, Math.min(1, entry.similarity)) : undefined,
  }));
}

/**
 * Runbook evidence — a single row carrying the head of the workflow's
 * `workflow_metadata.runbookMarkdown`, when present + non-empty. The
 * workflow id is the deep-link `sourceRef` (the inspector's metadata panel
 * keys on it). Pure. Returns `[]` for a workflow with no runbook.
 */
export function buildRunbookEvidence(
  workflowId: string | null | undefined,
  runbookMarkdown: string | null | undefined,
): EvidenceRow[] {
  if (!workflowId) return [];
  if (typeof runbookMarkdown !== "string" || runbookMarkdown.trim().length === 0) return [];
  const excerpt = runbookMarkdown.trim().slice(0, RUNBOOK_EXCERPT_CHARS);
  return [{
    kind: "runbook_excerpt",
    sourceRef: workflowId,
    snippet: excerpt,
  }];
}

/**
 * Recent-error evidence — up to `MAX_RECENT_ERROR_ROWS` rows summarizing
 * recent failures that share this workflow. Each sample's error envelope is
 * normalized through `normalizeErrorSignature` (the same rule that drives
 * cluster labels), so no raw secret value reaches the snippet. `sourceRef`
 * is the source run id (DLQ / failed-node both carry one). Pure.
 *
 * `excludeRunId` drops the current failing run so the panel surfaces OTHER
 * recent failures, not the one being recovered.
 */
export function buildRecentErrorEvidence(
  samples: readonly FailureSample[],
  options: { workflowId?: string | null; excludeRunId?: string | null } = {},
): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  const seenSignatures = new Set<string>();
  for (const sample of samples) {
    if (rows.length >= MAX_RECENT_ERROR_ROWS) break;
    if (options.workflowId && sample.workflowId !== options.workflowId) continue;
    if (options.excludeRunId && sample.runId === options.excludeRunId) continue;
    const sig = normalizeErrorSignature(sample.errorJson, {
      nodeType: sample.nodeType,
      nodeId: sample.nodeId,
      toolName: sample.toolName,
    });
    // Collapse duplicate signatures so the panel shows distinct failure
    // modes, not N copies of the same one.
    if (seenSignatures.has(sig.signature)) continue;
    seenSignatures.add(sig.signature);
    rows.push({
      kind: "recent_error",
      sourceRef: sample.runId,
      snippet: sig.signature,
    });
  }
  return rows;
}

/**
 * Signature-rule evidence — a single row naming the normalization rule that
 * fired for the failing node's error. `sourceRef` is the rule `category`
 * (e.g. `secret_missing`, `http_error`). The signature itself is already
 * secret-scrubbed by `normalizeErrorSignature`. Pure.
 */
export function buildSignatureRuleEvidence(
  errorJson: unknown,
  failingNode: { type?: string; id?: string; toolName?: string } | null | undefined,
): EvidenceRow[] {
  if (errorJson == null) return [];
  const sig = normalizeErrorSignature(errorJson, {
    nodeType: failingNode?.type,
    nodeId: failingNode?.id,
    toolName: failingNode?.toolName,
  });
  return [{
    kind: "signature_rule",
    sourceRef: sig.category,
    snippet: `Matched signature rule "${sig.category}" → ${sig.signature}`,
  }];
}

/** The failing tool's registered input contract — same shape the route
 *  already assembled from `listTools()` for the prompt. */
export type ToolContractEvidenceInput = {
  name: string;
  description?: string;
  required?: readonly string[];
  optional?: readonly string[];
};

/**
 * Tool-contract evidence — a single row listing the failing tool's required
 * + optional input field names (the same `inputContract` the route threads
 * into the prompt for tool-typed failures). `sourceRef` is the tool name.
 * Pure. Returns `[]` for non-tool failures (caller passes `null`).
 */
export function buildToolContractEvidence(
  contract: ToolContractEvidenceInput | null | undefined,
): EvidenceRow[] {
  if (!contract || !contract.name) return [];
  const required = (contract.required ?? []).join(", ") || "(none)";
  const optional = (contract.optional ?? []).join(", ") || "(none)";
  return [{
    kind: "tool_contract",
    sourceRef: contract.name,
    snippet: `${contract.name} requires [${required}]; optional [${optional}]`,
  }];
}

export type RecoveryEvidenceInput = {
  /** Multi-tenant scope. */
  orgId: string;
  /** Failing workflow's saved id (`dlq.workflowJson.id`), if any. Drives the
   *  runbook lookup + the recent-error workflow filter. */
  workflowId: string | null;
  /** Current failing run id — excluded from the recent-error list. */
  runId: string | null;
  /** Failing node descriptor for the signature rule + recent-error context. */
  failingNode: { type?: string; id?: string; toolName?: string } | null;
  /** The failing node's persisted error envelope (`dlq.errorJson`). */
  errorJson: unknown;
  /** Per-approach feedback summary already loaded by the route. */
  feedbackSummaries: readonly FeedbackSummary[];
  /** Recalled memory entries already loaded by `composeRecoveryMemoryHint`
   *  (empty when memory is disabled). */
  memoryEntries: readonly MemoryRecallEntry[];
  /** Failing tool's input contract (null for non-tool failures). */
  toolContract: ToolContractEvidenceInput | null;
};

/**
 * Orchestrate the full recovery-path evidence list. Fetches the two sources
 * the patch route does NOT already have in hand (the workflow runbook + the
 * recent failure samples), calls every pure builder, concatenates, and runs
 * the whole list through the shared read-time scrubber.
 *
 * Best-effort: a read failure on either supplemental source degrades that
 * one source to empty — evidence is an explainability nicety, never load-
 * bearing, so a DB blip must not break the recovery flow. The other rows
 * (which came from data the route already loaded) still render.
 */
export async function assembleRecoveryEvidence(input: RecoveryEvidenceInput): Promise<EvidenceRow[]> {
  // The two supplemental reads run in parallel. Both are org-scoped; a
  // failure on either degrades to "no rows from that source".
  const [runbookMarkdown, recentSamples] = await Promise.all([
    fetchRunbookMarkdown(input.orgId, input.workflowId),
    fetchRecentSamples(input.orgId),
  ]);

  const rows: EvidenceRow[] = [
    ...buildSignatureRuleEvidence(input.errorJson, input.failingNode),
    ...buildToolContractEvidence(input.toolContract),
    ...buildFeedbackEvidence(input.feedbackSummaries),
    ...buildMemoryEvidence(input.memoryEntries),
    ...buildRunbookEvidence(input.workflowId, runbookMarkdown),
    ...buildRecentErrorEvidence(recentSamples, {
      workflowId: input.workflowId,
      excludeRunId: input.runId,
    }),
  ];

  return scrubEvidenceRows(rows);
}

async function fetchRunbookMarkdown(orgId: string, workflowId: string | null): Promise<string | null> {
  if (!workflowId) return null;
  try {
    const metadata = await getWorkflowMetadata(orgId, workflowId);
    return metadata?.runbookMarkdown ?? null;
  } catch {
    return null;
  }
}

async function fetchRecentSamples(orgId: string): Promise<FailureSample[]> {
  try {
    return await queryFailureSamples(orgId, RECENT_ERROR_WINDOW_DAYS, RECENT_ERROR_SCAN_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Lightweight evidence for the explain-run surface — there is no failing
 * node config to read a tool contract from, no patch suggestion to gather
 * memory for; the meaningful evidence is the fired signature rule (when the
 * run failed with an error) plus the workflow runbook (when present).
 * Pure-ish: one org-scoped runbook read, best-effort.
 */
export async function assembleExplainRunEvidence(input: {
  orgId: string;
  workflowId: string | null;
  failingNode: { type?: string; id?: string; toolName?: string } | null;
  errorJson: unknown;
}): Promise<EvidenceRow[]> {
  const runbookMarkdown = await fetchRunbookMarkdown(input.orgId, input.workflowId);
  const rows: EvidenceRow[] = [
    ...buildSignatureRuleEvidence(input.errorJson, input.failingNode),
    ...buildRunbookEvidence(input.workflowId, runbookMarkdown),
  ];
  return scrubEvidenceRows(rows);
}

/**
 * Evidence for the authoring `suggest-improvement` surface — no failing
 * node, so the only context-derived evidence is the workflow's past-feedback
 * history + its runbook. Often `[]` (a fresh workflow with no decisions).
 */
export async function assembleSuggestImprovementEvidence(input: {
  orgId: string;
  workflowId: string | null;
  feedbackSummaries: readonly FeedbackSummary[];
}): Promise<EvidenceRow[]> {
  const runbookMarkdown = await fetchRunbookMarkdown(input.orgId, input.workflowId);
  const rows: EvidenceRow[] = [
    ...buildFeedbackEvidence(input.feedbackSummaries),
    ...buildRunbookEvidence(input.workflowId, runbookMarkdown),
  ];
  return scrubEvidenceRows(rows);
}
