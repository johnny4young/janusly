/**
 * Pure builder for the "Recovery Evidence Report" — the single,
 * shareable artefact a compliance buyer needs per incident: everything
 * that happened with one failure, from the original run timeline through
 * the AI-suggested patch, the sandbox validation, the approval trail, and
 * the audit log, packaged as Markdown + JSON.
 *
 * Mirrors the shape of `run-explain-report.ts` (same `{ markdown, json }`
 * envelope, same `Content-Disposition` download path at the route layer)
 * and REUSES `buildRunExplainReport` for the run-summary + timeline
 * sections so the two artefacts can never drift on how a run is rendered.
 *
 * Pure function — no DB, no LLM call, no I/O. The route layer
 * (`apps/api/src/routes/recovery-items-routes.ts`) owns multi-tenant
 * scope, the DB reads (`@janusly/data/src/recoveryEvidenceRepo`), and the
 * audit write; this module owns format + content.
 *
 * Hard safety property: **no raw secret value ever appears in the
 * returned artefact**. Two layers guard this (identical posture to
 * `run-explain-report.ts`):
 *   1. The persisted jsonb columns (`runs.input_json`,
 *      `run_nodes.state_json`, `run_events.payload`, `dead_letters.*_json`,
 *      `audit_logs.metadata`) are already key-redacted at write time via
 *      `safePersistPayload`.
 *   2. The builder additionally runs every rendered free-form string
 *      through `scrubSecretShapes` (the token-shape regex set) as defense
 *      in depth — upstream error messages occasionally echo headers back,
 *      so this second pass catches anything that slipped past the
 *      chokepoint.
 *
 * Used by `apps/api/src/routes/recovery-items-routes.ts:POST
 * /recovery/items/:id/evidence`.
 */

import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { computeWorkflowDiff, type WorkflowDiff } from "@janusly/shared/src/workflow-diff";

import {
  buildRunExplainReport,
  type RunExplainReportJson,
} from "./run-explain-report";

/** Hard cap on rendered audit rows in the artefact (the resolver already caps the read). */
export const EVIDENCE_AUDIT_RENDER_CAP = 100;

/* ----------------------------- Input snapshots ---------------------------- */

/** Structural mirror of `EvidenceRecoveryItem` from the data layer (engine ↛ data dep direction). */
export type EvidenceReportRecoveryItem = {
  id: string;
  deadLetterId: string;
  workflowId: string | null;
  owner: string | null;
  severity: string;
  status: string;
  slaTargetAt: Date | string | null;
  resolutionReason: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | string | null;
  errorSignature: string | null;
  occurrenceCount: number;
  comments: Array<{ id: string; authorUserId: string; body: string; createdAt: string }>;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

export type EvidenceReportDeadLetter = {
  id: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: string;
  workflowJson: unknown;
  nodeJson: unknown;
  errorJson: unknown;
  replayedAt: Date | string | null;
  createdAt: Date | string | null;
};

export type EvidenceReportRun = {
  id: string;
  status: string;
  workflowVersionId: string | null;
  parentRunId: string | null;
  replayMode: string | null;
  inputJson: unknown;
  outputJson: unknown;
  createdAt: Date | string | null;
};

export type EvidenceReportRunNode = {
  nodeId: string;
  status: string;
  attempts: number | null;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  stateJson: unknown;
  errorJson: unknown;
};

export type EvidenceReportRunEvent = {
  id: string;
  nodeId: string | null;
  type: string;
  createdAt: Date | string | null;
  payload: unknown;
};

export type EvidenceReportAuditRow = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  userId: string | null;
  metadata: unknown;
  createdAt: Date | string | null;
};

/** Builder input — the route resolves all of this from DB reads via the resolver. */
export type BuildRecoveryEvidenceInput = {
  recoveryItem: EvidenceReportRecoveryItem;
  deadLetter: EvidenceReportDeadLetter | null;
  originalRun: EvidenceReportRun | null;
  originalRunNodes: EvidenceReportRunNode[];
  originalRunEvents: EvidenceReportRunEvent[];
  originalRunEventsTruncated: boolean;
  validationRun: EvidenceReportRun | null;
  validationRunNodes: EvidenceReportRunNode[];
  auditRows: EvidenceReportAuditRow[];
  rollback: { workflowId: string; currentVersion: number; priorVersion: number } | null;
  /** Optional base URL for the rollback deep link (the route passes `JANUSLY_PUBLIC_APP_URL`). */
  appBaseUrl?: string | null;
  /** Override the `generatedAt` timestamp — used by tests to assert stable output. */
  generatedAt?: string;
};

/* ----------------------------- Output envelope ---------------------------- */

export type EvidenceIncidentBlock = {
  recoveryItemId: string;
  deadLetterId: string;
  workflowId: string | null;
  owner: string | null;
  severity: string;
  status: string;
  slaTargetAt: string | null;
  resolutionReason: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  occurrenceCount: number;
  commentCount: number;
  /** Normalized, scrubbed failure signature persisted on the recovery item (debounce match key). */
  failureSignature: string | null;
  createdAt: string | null;
};

export type EvidenceDeadLetterBlock = {
  deadLetterId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: string;
  /** Scrubbed error summary lifted from `dead_letters.error_json`. */
  errorSummary: string;
  createdAt: string | null;
  replayedAt: string | null;
};

export type EvidenceAiExplanationBlock = {
  mode: "ai" | "fallback";
  envelopeKind: string;
  patchStyle: "structural" | "config_only" | "unknown";
  topApproachLabel: string;
  suggestionsCount: number;
  aiError: string | null;
  suggestedAt: string | null;
};

export type EvidenceValidationBlock = {
  validationRunId: string;
  /** `succeeded` / `failed` / `cancelled` / `running` — the terminal (or in-flight) state of the sandbox replay. */
  status: string;
  /** Scrubbed error summary of the validation run's failed node, when it failed. */
  failureSummary: string | null;
  startedAt: string | null;
};

export type EvidenceApprovalEntry = {
  nodeId: string;
  /** Node status (`completed` = approved, `failed` = rejected/timeout, `waiting` = pending). */
  status: string;
  /** Most relevant event type observed for this approval node (`approval.requested` / `approval.decided` / …). */
  lastEvent: string | null;
  decidedAt: string | null;
};

export type EvidenceAuditEntry = {
  action: string;
  targetType: string | null;
  targetId: string | null;
  actor: string | null;
  at: string | null;
};

export type EvidenceRollbackBlock = {
  workflowId: string;
  currentVersion: number;
  priorVersion: number;
  /** Deep link into the version-history compare view, when an app base URL was supplied. */
  url: string | null;
};

export type RecoveryEvidenceReportJson = {
  generatedAt: string;
  incident: EvidenceIncidentBlock;
  deadLetter: EvidenceDeadLetterBlock | null;
  /** The original failing run's summary + timeline, reusing the run-explain shape. */
  run: RunExplainReportJson | null;
  aiExplanation: EvidenceAiExplanationBlock | null;
  /** Structural diff between the failing workflow snapshot and the proposed/validated patch. */
  patchDiff: WorkflowDiff | null;
  sandboxValidation: EvidenceValidationBlock | null;
  approvalTrail: EvidenceApprovalEntry[];
  auditTrail: EvidenceAuditEntry[];
  rollback: EvidenceRollbackBlock | null;
};

export type RecoveryEvidenceReport = {
  markdown: string;
  json: RecoveryEvidenceReportJson;
};

/* ------------------------------- Helpers ---------------------------------- */

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeText(value: unknown, maxLen = 240): string {
  if (typeof value === "string") return scrubSecretShapes(value).slice(0, maxLen);
  if (value == null) return "";
  try {
    return scrubSecretShapes(JSON.stringify(value)).slice(0, maxLen);
  } catch {
    return "[unserialisable]";
  }
}

/** Extract a scrubbed one-line error summary from a node/DLQ `error_json` blob. */
function errorSummaryFrom(errorJson: unknown): string {
  if (errorJson == null) return "(no error message recorded)";
  if (typeof errorJson === "object") {
    const obj = errorJson as Record<string, unknown>;
    const candidate = obj.message ?? obj.error ?? obj.code ?? obj;
    return safeText(candidate ?? "(no error message recorded)");
  }
  return safeText(errorJson);
}

/** Read `inputJson.workflow` off a sandbox validation run; returns null when absent / wrong shape. */
function workflowFromInput(inputJson: unknown): Record<string, unknown> | null {
  if (!inputJson || typeof inputJson !== "object") return null;
  const wf = (inputJson as Record<string, unknown>).workflow;
  return wf && typeof wf === "object" ? (wf as Record<string, unknown>) : null;
}

/** Pull the actor string from an audit row's `metadata.actor.userId`, falling back to the row's `userId`. */
function auditActor(row: EvidenceReportAuditRow): string | null {
  const metadata = row.metadata;
  if (metadata && typeof metadata === "object") {
    const actor = (metadata as Record<string, unknown>).actor;
    if (actor && typeof actor === "object") {
      const userId = (actor as Record<string, unknown>).userId;
      if (typeof userId === "string" && userId.length > 0) return userId;
    }
  }
  return row.userId ?? null;
}

/* ------------------------------- Section builders ------------------------- */

function buildIncidentBlock(item: EvidenceReportRecoveryItem): EvidenceIncidentBlock {
  return {
    recoveryItemId: item.id,
    deadLetterId: item.deadLetterId,
    workflowId: item.workflowId,
    owner: item.owner ? safeText(item.owner, 120) : null,
    severity: item.severity,
    status: item.status,
    slaTargetAt: toIsoOrNull(item.slaTargetAt),
    resolutionReason: item.resolutionReason,
    resolvedBy: item.resolvedBy ? safeText(item.resolvedBy, 120) : null,
    resolvedAt: toIsoOrNull(item.resolvedAt),
    occurrenceCount: item.occurrenceCount,
    commentCount: Array.isArray(item.comments) ? item.comments.length : 0,
    // Already a normalized signature persisted on the row, but scrub
    // again — defense in depth, never trust a stored free-form string.
    failureSignature: item.errorSignature ? safeText(item.errorSignature, 200) : null,
    createdAt: toIsoOrNull(item.createdAt),
  };
}

function buildDeadLetterBlock(dlq: EvidenceReportDeadLetter | null): EvidenceDeadLetterBlock | null {
  if (!dlq) return null;
  return {
    deadLetterId: dlq.id,
    runId: dlq.runId,
    nodeId: safeText(dlq.nodeId, 120),
    attempt: dlq.attempt,
    status: dlq.status,
    errorSummary: errorSummaryFrom(dlq.errorJson),
    createdAt: toIsoOrNull(dlq.createdAt),
    replayedAt: toIsoOrNull(dlq.replayedAt),
  };
}

/**
 * Find the most recent `ai.workflow.patch_suggested` audit row and lift
 * its metadata into the AI-explanation block. The metadata is written by
 * `/ai/patch-workflow` on BOTH ai-mode and fallback per the AI-mutation
 * audit contract, so this surfaces the explanation mode either way.
 */
function buildAiExplanationBlock(auditRows: EvidenceReportAuditRow[]): EvidenceAiExplanationBlock | null {
  const row = auditRows.find((r) => r.action === "ai.workflow.patch_suggested");
  if (!row) return null;
  const metadata = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
  const mode: "ai" | "fallback" = metadata.mode === "ai" ? "ai" : "fallback";
  const patchStyleRaw = metadata.patchStyle;
  const patchStyle: "structural" | "config_only" | "unknown" =
    patchStyleRaw === "structural" || patchStyleRaw === "config_only" ? patchStyleRaw : "unknown";
  const suggestionsCount =
    typeof metadata.suggestionsCount === "number" && Number.isFinite(metadata.suggestionsCount)
      ? metadata.suggestionsCount
      : 0;
  const aiError = typeof metadata.aiError === "string" ? safeText(metadata.aiError, 200) : null;
  return {
    mode,
    envelopeKind: safeText(metadata.envelopeKind ?? "(unknown)", 120),
    patchStyle,
    topApproachLabel: safeText(metadata.topApproachLabel ?? "(unknown)", 120),
    suggestionsCount,
    aiError,
    suggestedAt: toIsoOrNull(row.createdAt),
  };
}

/**
 * Compute the structural diff between the failing workflow snapshot (the
 * DLQ row's `workflow_json`) and the proposed patch (the validation run's
 * `inputJson.workflow`). Returns null when either side is missing — there's
 * no patch to diff against until a sandbox validation has run.
 */
function buildPatchDiff(
  dlq: EvidenceReportDeadLetter | null,
  validationRun: EvidenceReportRun | null,
): WorkflowDiff | null {
  if (!dlq || !validationRun) return null;
  const before = dlq.workflowJson;
  const after = workflowFromInput(validationRun.inputJson);
  if (!before || typeof before !== "object" || !after) return null;
  return computeWorkflowDiff(
    before as Record<string, unknown>,
    after,
  );
}

function buildValidationBlock(
  validationRun: EvidenceReportRun | null,
  validationRunNodes: EvidenceReportRunNode[],
): EvidenceValidationBlock | null {
  if (!validationRun) return null;
  const failed = validationRunNodes
    .filter((n) => n.status === "failed")
    .sort((a, b) => (toIsoOrNull(b.finishedAt) ?? "").localeCompare(toIsoOrNull(a.finishedAt) ?? ""));
  const failureSummary = failed.length > 0 ? errorSummaryFrom(failed[0].errorJson) : null;
  return {
    validationRunId: validationRun.id,
    status: validationRun.status,
    failureSummary,
    startedAt: toIsoOrNull(validationRun.createdAt),
  };
}

/**
 * Reconstruct the approval trail from the original run's `approval` /
 * `human_form` nodes + their `approval.*` events. An approval node's
 * status carries the decision: `completed` = approved, `failed` =
 * rejected/timeout, `waiting` = still pending.
 */
function buildApprovalTrail(
  runNodes: EvidenceReportRunNode[],
  runEvents: EvidenceReportRunEvent[],
): EvidenceApprovalEntry[] {
  // Identify approval-shaped nodes. The persisted node type lives on
  // `state_json.nodeType`; fall back to inspecting `approval.*` events
  // keyed by nodeId when the type wasn't persisted.
  const approvalEventNodeIds = new Set<string>();
  for (const ev of runEvents) {
    if (ev.nodeId && ev.type.startsWith("approval.")) approvalEventNodeIds.add(ev.nodeId);
  }
  const entries: EvidenceApprovalEntry[] = [];
  for (const node of runNodes) {
    const nodeType =
      node.stateJson && typeof node.stateJson === "object"
        ? ((node.stateJson as Record<string, unknown>).nodeType as string | undefined)
        : undefined;
    const isApproval =
      nodeType === "approval" || nodeType === "human_form" || approvalEventNodeIds.has(node.nodeId);
    if (!isApproval) continue;

    // Latest approval-related event for this node, for the `lastEvent`
    // label + a decision timestamp.
    const nodeEvents = runEvents
      .filter((e) => e.nodeId === node.nodeId && e.type.startsWith("approval."))
      .sort((a, b) => (toIsoOrNull(a.createdAt) ?? "").localeCompare(toIsoOrNull(b.createdAt) ?? ""));
    const last = nodeEvents.length > 0 ? nodeEvents[nodeEvents.length - 1] : null;
    entries.push({
      nodeId: safeText(node.nodeId, 120),
      status: node.status,
      lastEvent: last ? safeText(last.type, 120) : null,
      decidedAt: toIsoOrNull(node.finishedAt) ?? (last ? toIsoOrNull(last.createdAt) : null),
    });
  }
  return entries;
}

function buildAuditTrail(auditRows: EvidenceReportAuditRow[]): EvidenceAuditEntry[] {
  return auditRows.slice(0, EVIDENCE_AUDIT_RENDER_CAP).map((row) => ({
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId ? safeText(row.targetId, 120) : null,
    actor: (() => {
      const actor = auditActor(row);
      return actor ? safeText(actor, 120) : null;
    })(),
    at: toIsoOrNull(row.createdAt),
  }));
}

function buildRollbackBlock(
  rollback: BuildRecoveryEvidenceInput["rollback"],
  appBaseUrl: string | null | undefined,
): EvidenceRollbackBlock | null {
  if (!rollback) return null;
  let url: string | null = null;
  if (appBaseUrl && appBaseUrl.trim().length > 0) {
    const trimmed = appBaseUrl.replace(/\/$/, "");
    url = `${trimmed}/workflows/${encodeURIComponent(rollback.workflowId)}/versions?rollbackTo=${rollback.priorVersion}`;
  }
  return {
    workflowId: rollback.workflowId,
    currentVersion: rollback.currentVersion,
    priorVersion: rollback.priorVersion,
    url,
  };
}

/* ------------------------------- Markdown --------------------------------- */

function markdownEscape(value: string): string {
  return value.replace(/`/g, "\\`");
}

function renderMarkdown(json: RecoveryEvidenceReportJson, runMarkdown: string | null): string {
  const lines: string[] = [];
  lines.push(`# Recovery Evidence Report — ${markdownEscape(json.incident.recoveryItemId)}`);
  lines.push("");
  lines.push(`> Generated ${json.generatedAt}`);
  lines.push("");

  // Incident
  lines.push("## Incident");
  lines.push(`- **Recovery item:** \`${markdownEscape(json.incident.recoveryItemId)}\``);
  lines.push(`- **Dead letter:** \`${markdownEscape(json.incident.deadLetterId)}\``);
  if (json.incident.workflowId) lines.push(`- **Workflow:** \`${markdownEscape(json.incident.workflowId)}\``);
  lines.push(`- **Severity:** ${json.incident.severity}`);
  lines.push(`- **Status:** ${json.incident.status}`);
  lines.push(`- **Owner:** ${json.incident.owner ?? "(unassigned)"}`);
  if (json.incident.slaTargetAt) lines.push(`- **SLA target:** ${json.incident.slaTargetAt}`);
  if (json.incident.occurrenceCount > 1) lines.push(`- **Occurrences:** ${json.incident.occurrenceCount}`);
  if (json.incident.failureSignature) lines.push(`- **Failure signature:** ${markdownEscape(json.incident.failureSignature)}`);
  if (json.incident.resolutionReason) lines.push(`- **Resolution:** ${json.incident.resolutionReason}`);
  if (json.incident.resolvedBy) lines.push(`- **Resolved by:** ${json.incident.resolvedBy}`);
  if (json.incident.resolvedAt) lines.push(`- **Resolved at:** ${json.incident.resolvedAt}`);
  lines.push("");

  // Dead letter
  if (json.deadLetter) {
    lines.push("## Dead letter");
    lines.push(`- **Run:** \`${markdownEscape(json.deadLetter.runId)}\``);
    lines.push(`- **Node:** \`${markdownEscape(json.deadLetter.nodeId)}\``);
    lines.push(`- **Attempt:** ${json.deadLetter.attempt}`);
    lines.push(`- **Status:** ${json.deadLetter.status}`);
    if (json.deadLetter.createdAt) lines.push(`- **Created at:** ${json.deadLetter.createdAt}`);
    lines.push("");
    lines.push("**Error summary** (redacted):");
    lines.push("");
    lines.push("```");
    lines.push(markdownEscape(json.deadLetter.errorSummary));
    lines.push("```");
    lines.push("");
  } else {
    lines.push("## Dead letter");
    lines.push("_The dead-letter row is no longer present (it may have been purged); the incident metadata above is retained._");
    lines.push("");
  }

  // Run timeline (reuse the run-explain markdown body verbatim, demoted
  // one heading level so it nests under the evidence document).
  lines.push("## Original run");
  if (runMarkdown) {
    // Demote `#`/`##` headings in the reused body to `###`/`####` so the
    // evidence document keeps a single top-level title.
    const demoted = runMarkdown
      .split("\n")
      .map((ln) => (ln.startsWith("#") ? `##${ln}` : ln))
      .join("\n");
    lines.push("");
    lines.push(demoted.trim());
    lines.push("");
  } else {
    lines.push("_The original run is no longer present; see the dead-letter error summary above for the failure context._");
    lines.push("");
  }

  // AI explanation
  lines.push("## AI explanation");
  if (json.aiExplanation) {
    lines.push(`- **Mode:** ${json.aiExplanation.mode}`);
    lines.push(`- **Envelope:** ${json.aiExplanation.envelopeKind}`);
    lines.push(`- **Patch style:** ${json.aiExplanation.patchStyle}`);
    lines.push(`- **Top approach:** ${json.aiExplanation.topApproachLabel}`);
    lines.push(`- **Alternatives proposed:** ${json.aiExplanation.suggestionsCount}`);
    if (json.aiExplanation.aiError) lines.push(`- **AI error:** ${markdownEscape(json.aiExplanation.aiError)}`);
    if (json.aiExplanation.suggestedAt) lines.push(`- **Suggested at:** ${json.aiExplanation.suggestedAt}`);
  } else {
    lines.push("_No AI patch suggestion was recorded for this incident._");
  }
  lines.push("");

  // Patch diff
  lines.push("## Selected patch diff");
  if (json.patchDiff) {
    const s = json.patchDiff.summary;
    lines.push(
      `- **Summary:** ${s.totalChanges} change(s) — ` +
        `nodes +${s.nodesAdded}/-${s.nodesRemoved}/~${s.nodesChanged}, ` +
        `edges +${s.edgesAdded}/-${s.edgesRemoved}/~${s.edgesChanged}`,
    );
    for (const node of json.patchDiff.nodes) {
      if (node.kind === "added") lines.push(`- **+ node** \`${markdownEscape(node.node.id)}\` (${node.node.type})`);
      else if (node.kind === "removed") lines.push(`- **− node** \`${markdownEscape(node.node.id)}\` (${node.node.type})`);
      else lines.push(`- **~ node** \`${markdownEscape(node.nodeId)}\` (${node.fields.length} field change(s))`);
    }
    for (const edge of json.patchDiff.edges) {
      if (edge.kind === "added") lines.push(`- **+ edge** \`${markdownEscape(edge.edgeKey)}\``);
      else if (edge.kind === "removed") lines.push(`- **− edge** \`${markdownEscape(edge.edgeKey)}\``);
      else lines.push(`- **~ edge** \`${markdownEscape(edge.edgeKey)}\``);
    }
  } else {
    lines.push("_No validated patch is associated with this incident yet (run a sandbox validation to capture one)._");
  }
  lines.push("");

  // Sandbox validation
  lines.push("## Sandbox validation");
  if (json.sandboxValidation) {
    lines.push(`- **Validation run:** \`${markdownEscape(json.sandboxValidation.validationRunId)}\``);
    lines.push(`- **Result:** ${json.sandboxValidation.status}`);
    if (json.sandboxValidation.startedAt) lines.push(`- **Started:** ${json.sandboxValidation.startedAt}`);
    if (json.sandboxValidation.failureSummary) {
      lines.push("");
      lines.push("**Validation failure** (redacted):");
      lines.push("");
      lines.push("```");
      lines.push(markdownEscape(json.sandboxValidation.failureSummary));
      lines.push("```");
    }
  } else {
    lines.push("_No sandbox validation run was recorded for this incident._");
  }
  lines.push("");

  // Approval trail
  lines.push("## Approval trail");
  if (json.approvalTrail.length === 0) {
    lines.push("_No approval gates were present in this run._");
  } else {
    for (const entry of json.approvalTrail) {
      const decided = entry.decidedAt ? ` — ${entry.decidedAt}` : "";
      const event = entry.lastEvent ? ` (${markdownEscape(entry.lastEvent)})` : "";
      lines.push(`- \`${markdownEscape(entry.nodeId)}\` — **${entry.status}**${event}${decided}`);
    }
  }
  lines.push("");

  // Audit trail
  lines.push("## Audit trail");
  if (json.auditTrail.length === 0) {
    lines.push("_No audit rows reference this incident._");
  } else {
    for (const entry of json.auditTrail) {
      const at = entry.at ?? "(unknown time)";
      const actor = entry.actor ? ` by ${markdownEscape(entry.actor)}` : "";
      lines.push(`- ${at} — **${markdownEscape(entry.action)}**${actor}`);
    }
  }
  lines.push("");

  // Rollback
  lines.push("## Rollback");
  if (json.rollback) {
    lines.push(`- **Workflow:** \`${markdownEscape(json.rollback.workflowId)}\``);
    lines.push(`- **Current version:** v${json.rollback.currentVersion}`);
    lines.push(`- **Roll back to:** v${json.rollback.priorVersion}`);
    if (json.rollback.url) lines.push(`- **Link:** ${json.rollback.url}`);
  } else {
    lines.push("_No prior version is available to roll back to._");
  }
  lines.push("");

  return lines.join("\n");
}

/* ------------------------------- Entry point ------------------------------ */

/**
 * Build the recovery evidence report. Pure — no I/O. The route resolves
 * DB reads (via `resolveRecoveryEvidence`) and passes the snapshots in.
 * `markdown` is ready to ship as an HTTP body; `json` is the same content
 * as a structured envelope for programmatic / compliance-archive consumers.
 */
export function buildRecoveryEvidenceReport(input: BuildRecoveryEvidenceInput): RecoveryEvidenceReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  // Reuse the run-explain builder for the original run's summary +
  // timeline so the two artefacts never drift on run rendering. The
  // recovery-audit input pulls the patch-suggested row from our audit set.
  const patchAuditRow = input.auditRows.find((r) => r.action === "ai.workflow.patch_suggested") ?? null;
  let runJson: RunExplainReportJson | null = null;
  let runMarkdown: string | null = null;
  if (input.originalRun) {
    const runReport = buildRunExplainReport({
      run: {
        id: input.originalRun.id,
        status: input.originalRun.status,
        workflowVersionId: input.originalRun.workflowVersionId,
        parentRunId: input.originalRun.parentRunId,
        replayMode: input.originalRun.replayMode,
        createdAt: input.originalRun.createdAt,
        inputJson: input.originalRun.inputJson,
        outputJson: input.originalRun.outputJson,
      },
      runNodes: input.originalRunNodes.map((n) => ({
        nodeId: n.nodeId,
        status: n.status,
        attempts: n.attempts,
        startedAt: n.startedAt,
        finishedAt: n.finishedAt,
        stateJson: n.stateJson,
        errorJson: n.errorJson,
      })),
      runEvents: input.originalRunEvents.map((e) => ({
        id: e.id,
        nodeId: e.nodeId,
        type: e.type,
        createdAt: e.createdAt,
        payload: e.payload,
      })),
      recoveryAudit: patchAuditRow
        ? {
            createdAt: patchAuditRow.createdAt,
            metadata: (patchAuditRow.metadata && typeof patchAuditRow.metadata === "object"
              ? patchAuditRow.metadata
              : {}) as Record<string, unknown>,
          }
        : null,
    });
    // Stamp the nested run block with the SAME generation timestamp as
    // the evidence envelope so the whole artefact carries one consistent
    // `generatedAt` (the run-explain builder stamps its own `Date.now()`
    // otherwise, which would make two exports of the same incident differ
    // by microseconds — breaking the stable-output contract).
    runJson = { ...runReport.json, generatedAt };
    runMarkdown = runReport.markdown.replace(
      /^> Generated .*$/m,
      `> Generated ${generatedAt}`,
    );
  }

  const json: RecoveryEvidenceReportJson = {
    generatedAt,
    incident: buildIncidentBlock(input.recoveryItem),
    deadLetter: buildDeadLetterBlock(input.deadLetter),
    run: runJson,
    aiExplanation: buildAiExplanationBlock(input.auditRows),
    patchDiff: buildPatchDiff(input.deadLetter, input.validationRun),
    sandboxValidation: buildValidationBlock(input.validationRun, input.validationRunNodes),
    approvalTrail: buildApprovalTrail(input.originalRunNodes, input.originalRunEvents),
    auditTrail: buildAuditTrail(input.auditRows),
    rollback: buildRollbackBlock(input.rollback, input.appBaseUrl),
  };

  const markdown = renderMarkdown(json, runMarkdown);
  return { markdown, json };
}
