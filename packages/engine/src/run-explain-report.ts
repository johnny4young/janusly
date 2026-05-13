/**
 * Pure builder for the "Run Explain Report" — a shareable Markdown +
 * JSON artefact summarising a single run for a stakeholder. The
 * artefact includes workflow context, run timeline, root cause
 * (extracted via the shared `normalizeErrorSignature` taxonomy), the
 * failing node and its attempts, and (when present) a "Suggested fix"
 * section reading from the most recent `ai.workflow.patch_suggested`
 * audit row.
 *
 * Pure function — no DB, no LLM call, no I/O. Reads from snapshots
 * passed in by the caller. The route layer owns multi-tenant scope,
 * pagination, and audit writes; this module owns format and content.
 *
 * Hard safety property: **no raw secret value ever appears in the
 * returned report**. Two layers guard this:
 *   1. The `runs.input_json`, `run_nodes.state_json`, `run_events.payload`
 *      rows are already key-redacted at write time via
 *      `safePersistPayload` — reading them back is safe by construction.
 *   2. The builder additionally scrubs every rendered free-form string
 *      through `scrubSecretShapes` (the same token-shape regex set the
 *      cluster signature uses) as defense in depth. Error messages
 *      from upstream APIs occasionally echo headers back, so the second
 *      pass catches anything that slipped past the chokepoint.
 *
 * Used by `apps/api/src/routes/reports-routes.ts:GET /reports/run-explain`.
 */

import {
  normalizeErrorSignature,
  scrubSecretShapes,
  type SuggestedOwner,
} from "@janusly/shared/src/error-signature";

/** Hard cap on timeline entries to keep the artefact readable. */
export const RUN_EXPLAIN_TIMELINE_CAP = 50;

/** Snapshot of the `runs` row the report needs. Minimal — the builder doesn't need every column. */
export type RunExplainRunSnapshot = {
  id: string;
  status: string;
  workflowVersionId?: string | null;
  parentRunId?: string | null;
  replayMode?: string | null;
  createdAt?: Date | string | null;
  /** Optional inputJson — used to derive the workflow name when persisted; never rendered raw. */
  inputJson?: unknown;
  /** Optional outputJson — surfaced as a structured block when the run succeeded with declared outputs. */
  outputJson?: unknown;
};

/** Snapshot of a `run_nodes` row. */
export type RunExplainNodeSnapshot = {
  nodeId: string;
  status: string;
  attempts?: number | null;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  stateJson?: unknown;
  errorJson?: unknown;
};

/** Snapshot of a `run_events` row. */
export type RunExplainEventSnapshot = {
  id?: string;
  nodeId?: string | null;
  type: string;
  createdAt?: Date | string | null;
  /** Free-form jsonb payload — already key-redacted at write time. */
  payload?: unknown;
};

/** Snapshot of the most recent `ai.workflow.patch_suggested` audit row for this run. */
export type RunExplainRecoveryAudit = {
  createdAt?: Date | string | null;
  metadata?: {
    mode?: "ai" | "fallback";
    model?: string;
    provider?: string;
    envelopeKind?: string;
    patchStyle?: "structural" | "config_only";
    topApproachLabel?: string;
    suggestionsCount?: number;
    aiError?: string;
  };
};

/** Builder input — the route resolves all of these from DB reads. */
export type BuildRunExplainReportInput = {
  run: RunExplainRunSnapshot;
  runNodes: RunExplainNodeSnapshot[];
  runEvents: RunExplainEventSnapshot[];
  /** Most recent recovery audit row for this run; `null` when none exists. */
  recoveryAudit: RunExplainRecoveryAudit | null;
};

/** Structured JSON envelope returned alongside the Markdown rendering. */
export type RunExplainReportJson = {
  generatedAt: string;
  summary: {
    runId: string;
    status: string;
    workflowVersionId: string | null;
    parentRunId: string | null;
    replayMode: string | null;
    createdAt: string | null;
    isFailure: boolean;
  };
  rootCause: RunExplainRootCause | null;
  failedNode: RunExplainFailedNode | null;
  timeline: RunExplainTimelineEntry[];
  timelineTruncated: boolean;
  suggestedFix: RunExplainSuggestedFix | null;
  nextAction: string;
};

export type RunExplainRootCause = {
  signature: string;
  category: string;
  suggestedOwner: SuggestedOwner;
};

export type RunExplainFailedNode = {
  nodeId: string;
  status: string;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorSummary: string;
};

export type RunExplainTimelineEntry = {
  at: string | null;
  nodeId: string | null;
  type: string;
};

export type RunExplainSuggestedFix = {
  mode: "ai" | "fallback";
  topApproachLabel: string;
  envelopeKind: string;
  patchStyle: "structural" | "config_only" | "unknown";
  suggestionsCount: number;
  suggestedAt: string | null;
};

/** Output envelope — what the route returns. */
export type RunExplainReport = {
  markdown: string;
  json: RunExplainReportJson;
};

const NEXT_ACTION_BY_OWNER: Record<SuggestedOwner, string> = {
  ops: "Set the missing secret or credential in the environment, then replay the run from the Recovery Queue.",
  workflow_author: "Review the failing node's config and the suggested patch (if any), apply a fix in AI Studio, then replay.",
  platform: "File a platform incident — the failure is in shared infrastructure (LLM provider, ingress, runtime).",
};

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

function pickFailedNode(nodes: RunExplainNodeSnapshot[]): RunExplainNodeSnapshot | null {
  // Latest failed node by `finishedAt` (or `startedAt` as tiebreaker). A
  // run can have only one failure terminating the DAG, but the latest
  // wins if multiple parallel branches failed.
  const failed = nodes.filter((n) => n.status === "failed");
  if (failed.length === 0) return null;
  return failed.reduce((acc, current) => {
    const accTime = toIsoOrNull(acc.finishedAt) ?? toIsoOrNull(acc.startedAt) ?? "";
    const curTime = toIsoOrNull(current.finishedAt) ?? toIsoOrNull(current.startedAt) ?? "";
    return curTime > accTime ? current : acc;
  });
}

function deriveRootCause(failedNode: RunExplainNodeSnapshot | null): RunExplainRootCause | null {
  if (!failedNode || !failedNode.errorJson) return null;
  const nodeType = (failedNode.stateJson && typeof failedNode.stateJson === "object")
    ? ((failedNode.stateJson as Record<string, unknown>).nodeType as string | undefined)
    : undefined;
  const result = normalizeErrorSignature(failedNode.errorJson, { nodeId: failedNode.nodeId, nodeType });
  return {
    signature: safeText(result.signature),
    category: result.category,
    suggestedOwner: result.suggestedOwner,
  };
}

function buildFailedNodeBlock(failedNode: RunExplainNodeSnapshot | null): RunExplainFailedNode | null {
  if (!failedNode) return null;
  const errorPayload = failedNode.errorJson as Record<string, unknown> | null | undefined;
  const message = errorPayload && typeof errorPayload === "object"
    ? (errorPayload.message ?? errorPayload.error ?? errorPayload.code ?? errorPayload)
    : errorPayload;
  return {
    nodeId: safeText(failedNode.nodeId, 120),
    status: failedNode.status,
    attempts: failedNode.attempts ?? 1,
    startedAt: toIsoOrNull(failedNode.startedAt),
    finishedAt: toIsoOrNull(failedNode.finishedAt),
    errorSummary: safeText(message ?? "(no error message recorded)"),
  };
}

function buildTimeline(events: RunExplainEventSnapshot[]): { entries: RunExplainTimelineEntry[]; truncated: boolean } {
  const sorted = [...events].sort((left, right) => {
    const l = toIsoOrNull(left.createdAt) ?? "";
    const r = toIsoOrNull(right.createdAt) ?? "";
    return l.localeCompare(r);
  });
  const truncated = sorted.length > RUN_EXPLAIN_TIMELINE_CAP;
  // When over cap, keep the LAST `RUN_EXPLAIN_TIMELINE_CAP` entries —
  // the failure context is at the tail. The Markdown surface notes the
  // truncation so the reader knows older context exists.
  const trimmed = truncated ? sorted.slice(sorted.length - RUN_EXPLAIN_TIMELINE_CAP) : sorted;
  const entries = trimmed.map((event) => ({
    at: toIsoOrNull(event.createdAt),
    nodeId: event.nodeId ? safeText(event.nodeId, 120) : null,
    type: safeText(event.type, 120),
  }));
  return { entries, truncated };
}

function buildSuggestedFix(audit: RunExplainRecoveryAudit | null): RunExplainSuggestedFix | null {
  if (!audit?.metadata) return null;
  const metadata = audit.metadata;
  const mode: "ai" | "fallback" =
    metadata.mode === "ai" || metadata.mode === "fallback" ? metadata.mode : "fallback";
  const patchStyleRaw = metadata.patchStyle;
  const patchStyle: "structural" | "config_only" | "unknown" =
    patchStyleRaw === "structural" || patchStyleRaw === "config_only" ? patchStyleRaw : "unknown";
  const suggestionsCount = typeof metadata.suggestionsCount === "number" && Number.isFinite(metadata.suggestionsCount)
    ? metadata.suggestionsCount
    : 0;
  return {
    mode,
    topApproachLabel: safeText(metadata.topApproachLabel ?? "(unknown)", 120),
    envelopeKind: safeText(metadata.envelopeKind ?? "(unknown)", 120),
    patchStyle,
    suggestionsCount,
    suggestedAt: toIsoOrNull(audit.createdAt),
  };
}

function deriveNextAction(rootCause: RunExplainRootCause | null, isFailure: boolean): string {
  if (!isFailure) return "Run succeeded — no operator action required.";
  if (!rootCause) return "Inspect the run timeline and node state for the failure cause, then iterate.";
  return NEXT_ACTION_BY_OWNER[rootCause.suggestedOwner];
}

function markdownEscape(value: string): string {
  // Backticks need escaping inside fenced code; pipes inside table cells
  // (not used here but defensive). Keep newlines verbatim.
  return value.replace(/`/g, "\\`");
}

function renderMarkdown(json: RunExplainReportJson): string {
  const lines: string[] = [];
  lines.push(`# Run Explain Report — ${markdownEscape(json.summary.runId)}`);
  lines.push("");
  lines.push(`> Generated ${json.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- **Run id:** \`${markdownEscape(json.summary.runId)}\``);
  lines.push(`- **Status:** ${json.summary.status}`);
  if (json.summary.workflowVersionId) lines.push(`- **Workflow version:** \`${markdownEscape(json.summary.workflowVersionId)}\``);
  if (json.summary.createdAt) lines.push(`- **Created at:** ${json.summary.createdAt}`);
  if (json.summary.parentRunId) lines.push(`- **Parent run:** \`${markdownEscape(json.summary.parentRunId)}\``);
  if (json.summary.replayMode) lines.push(`- **Replay mode:** ${json.summary.replayMode} (sandbox — not a production run)`);
  lines.push("");

  if (json.rootCause) {
    lines.push("## Root cause");
    lines.push(`- **Signature:** ${markdownEscape(json.rootCause.signature)}`);
    lines.push(`- **Category:** ${json.rootCause.category}`);
    lines.push(`- **Suggested owner:** ${json.rootCause.suggestedOwner}`);
    lines.push("");
  }

  if (json.failedNode) {
    lines.push("## Failed node");
    lines.push(`- **Node id:** \`${markdownEscape(json.failedNode.nodeId)}\``);
    lines.push(`- **Status:** ${json.failedNode.status}`);
    lines.push(`- **Attempts:** ${json.failedNode.attempts}`);
    if (json.failedNode.startedAt) lines.push(`- **Started:** ${json.failedNode.startedAt}`);
    if (json.failedNode.finishedAt) lines.push(`- **Finished:** ${json.failedNode.finishedAt}`);
    lines.push("");
    lines.push("**Error summary** (redacted):");
    lines.push("");
    lines.push("```");
    lines.push(markdownEscape(json.failedNode.errorSummary));
    lines.push("```");
    lines.push("");
  }

  lines.push("## Timeline");
  if (json.timeline.length === 0) {
    lines.push("_No events recorded yet._");
  } else {
    if (json.timelineTruncated) {
      lines.push(`_Showing the last ${RUN_EXPLAIN_TIMELINE_CAP} events. Older events were trimmed for readability._`);
      lines.push("");
    }
    for (const entry of json.timeline) {
      const stamp = entry.at ?? "(unknown time)";
      const node = entry.nodeId ? ` node=\`${markdownEscape(entry.nodeId)}\`` : "";
      lines.push(`- ${stamp} — **${markdownEscape(entry.type)}**${node}`);
    }
  }
  lines.push("");

  lines.push("## Suggested fix");
  if (!json.suggestedFix) {
    lines.push("_No prior recovery suggestion exists for this run. Open the Recovery Queue to request one._");
  } else {
    const fix = json.suggestedFix;
    lines.push(`- **Mode:** ${fix.mode}`);
    lines.push(`- **Approach:** ${fix.topApproachLabel}`);
    lines.push(`- **Envelope:** ${fix.envelopeKind}`);
    lines.push(`- **Patch style:** ${fix.patchStyle}`);
    lines.push(`- **Alternatives proposed:** ${fix.suggestionsCount}`);
    if (fix.suggestedAt) lines.push(`- **Suggested at:** ${fix.suggestedAt}`);
  }
  lines.push("");

  lines.push("## Next action");
  lines.push(json.nextAction);
  lines.push("");

  return lines.join("\n");
}

/**
 * Build the report. Pure — no I/O. The route resolves DB reads and
 * passes the snapshots in. The output's `markdown` is ready to ship as
 * an HTTP body; the `json` is the same content as a structured envelope
 * for programmatic consumers.
 */
export function buildRunExplainReport(input: BuildRunExplainReportInput): RunExplainReport {
  const { run, runNodes, runEvents, recoveryAudit } = input;

  const isFailure = run.status === "failed";
  const failedNode = pickFailedNode(runNodes);
  const rootCause = deriveRootCause(failedNode);
  const failedNodeBlock = buildFailedNodeBlock(failedNode);
  const { entries: timeline, truncated: timelineTruncated } = buildTimeline(runEvents);
  const suggestedFix = buildSuggestedFix(recoveryAudit);
  const nextAction = deriveNextAction(rootCause, isFailure);

  const json: RunExplainReportJson = {
    generatedAt: new Date().toISOString(),
    summary: {
      runId: run.id,
      status: run.status,
      workflowVersionId: run.workflowVersionId ?? null,
      parentRunId: run.parentRunId ?? null,
      replayMode: run.replayMode ?? null,
      createdAt: toIsoOrNull(run.createdAt),
      isFailure,
    },
    rootCause,
    failedNode: failedNodeBlock,
    timeline,
    timelineTruncated,
    suggestedFix,
    nextAction,
  };

  const markdown = renderMarkdown(json);
  return { markdown, json };
}
