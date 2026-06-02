/**
 * Repository for the Replay Lab's per-node comparison view. Loads both
 * runs' `run_nodes` rows + the `usage_events` rows attributed to either
 * run, then aggregates them into a per-node bundle the comparison
 * renderer can diff directly.
 *
 * Used by `apps/api/src/routes/runs-routes.ts:GET /runs/compare` after
 * the route layer org-scopes both run ids.
 *
 * Invariants:
 * - Multi-tenant scope: every query carries `eq(<table>.orgId, orgId)`.
 *   The two runs are loaded via `eq(runs.orgId, orgId)`; the usage rows
 *   are loaded via `eq(usageEvents.orgId, orgId)`. The route layer is
 *   the chokepoint that resolves `orgId` from the auth context.
 * - Node output extraction is shape-aware: `succeeded` nodes write
 *   `state_json: { output }`; the comparison surfaces the projected
 *   `.output` for those. Other statuses (`waiting`/`cancelled`/`skipped`)
 *   carry the full state — operator reads the raw structure.
 * - Cost is null when no usage row covers the node (transform/condition/
 *   http nodes don't emit telemetry). The renderer surfaces `—` for null.
 */

import { db, runs, runNodes, usageEvents } from "@janusly/db";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Per-side snapshot for one node — populated from `run_nodes` + the
 * `usage_events` rows attributed to the same `(runId, nodeId)`.
 */
export type RunComparisonNodeSide = {
  /** Run-nodes `status` column, or `"missing"` when the node was not present in the run. */
  status: string;
  /** Computed from `finishedAt - startedAt`; `null` when not yet finished. */
  latencyMs: number | null;
  /**
   * Sum of `usage_events.metadata.costUsd` over rows tagged with this
   * `(runId, nodeId)`. `null` when no row carries a non-null cost — never
   * coerced to zero so unknown-model buckets are distinguishable.
   */
  costUsd: number | null;
  /** Sum of `usage_events.quantity` over rows tagged with this `(runId, nodeId)`. */
  tokens: number;
  /**
   * Projected node output. For `succeeded` nodes this is the `.output`
   * field of `state_json`; for other statuses it's the full `state_json`.
   */
  output: unknown;
  /** `run_nodes.error_json` (may be null). */
  errorJson: unknown;
};

export type RunComparisonNode = {
  nodeId: string;
  base: RunComparisonNodeSide;
  replay: RunComparisonNodeSide;
};

export type RunComparisonRunSummary = {
  id: string;
  status: string;
  replayMode: string | null;
  parentRunId: string | null;
  createdAt: Date | null;
};

export type RunComparison = {
  baseRun: RunComparisonRunSummary;
  replayRun: RunComparisonRunSummary;
  perNode: RunComparisonNode[];
};

export type RunComparisonError =
  | { error: "base_run_not_found" }
  | { error: "replay_run_not_found" };

const MISSING: RunComparisonNodeSide = {
  status: "missing",
  latencyMs: null,
  costUsd: null,
  tokens: 0,
  output: null,
  errorJson: null,
};

function projectOutput(status: string, stateJson: unknown): unknown {
  if (status === "succeeded" && stateJson && typeof stateJson === "object") {
    const value = (stateJson as Record<string, unknown>).output;
    return value === undefined ? null : value;
  }
  return stateJson ?? null;
}

function computeLatency(startedAt: Date | null, finishedAt: Date | null): number | null {
  if (!startedAt || !finishedAt) return null;
  const start = startedAt instanceof Date ? startedAt.getTime() : new Date(startedAt).getTime();
  const finish = finishedAt instanceof Date ? finishedAt.getTime() : new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;
  return Math.max(0, finish - start);
}

type UsageAggregate = { costUsd: number | null; tokens: number };

function aggregateUsageByNode(
  rows: ReadonlyArray<{ runId: string | null; quantity: number | null; metadata: unknown }>,
  runId: string,
): Map<string, UsageAggregate> {
  const out = new Map<string, UsageAggregate>();
  for (const row of rows) {
    if (row.runId !== runId) continue;
    const metadata = row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : null;
    const nodeId = metadata && typeof metadata.nodeId === "string" ? metadata.nodeId : null;
    if (!nodeId) continue;

    const cost = metadata && typeof metadata.costUsd === "number" ? metadata.costUsd : null;
    const tokens = typeof row.quantity === "number" ? row.quantity : 0;

    const existing = out.get(nodeId);
    if (!existing) {
      out.set(nodeId, { costUsd: cost, tokens });
      continue;
    }
    if (cost !== null) existing.costUsd = (existing.costUsd ?? 0) + cost;
    existing.tokens += tokens;
  }
  return out;
}

/**
 * Build the per-node comparison payload for two org-scoped runs.
 * Returns `{ error: ... }` when either run is missing or not owned by
 * `orgId`. The route layer maps the error tags to HTTP 404.
 */
export async function getRunComparison(input: {
  orgId: string;
  baseRunId: string;
  replayRunId: string;
}): Promise<RunComparison | RunComparisonError> {
  const { orgId, baseRunId, replayRunId } = input;

  const runRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.orgId, orgId), inArray(runs.id, [baseRunId, replayRunId])));

  const baseRow = runRows.find((r) => r.id === baseRunId);
  if (!baseRow) return { error: "base_run_not_found" };
  const replayRow = runRows.find((r) => r.id === replayRunId);
  if (!replayRow) return { error: "replay_run_not_found" };

  const nodeRows = await db
    .select()
    .from(runNodes)
    .where(inArray(runNodes.runId, [baseRunId, replayRunId]));

  const usageRows = await db
    .select({
      runId: usageEvents.runId,
      quantity: usageEvents.quantity,
      metadata: usageEvents.metadata,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.orgId, orgId), inArray(usageEvents.runId, [baseRunId, replayRunId])));

  const baseUsage = aggregateUsageByNode(usageRows, baseRunId);
  const replayUsage = aggregateUsageByNode(usageRows, replayRunId);

  const baseByNode = new Map<string, typeof nodeRows[number]>();
  const replayByNode = new Map<string, typeof nodeRows[number]>();
  for (const row of nodeRows) {
    if (row.runId === baseRunId) baseByNode.set(row.nodeId, row);
    else if (row.runId === replayRunId) replayByNode.set(row.nodeId, row);
  }

  const nodeIds = new Set<string>();
  for (const id of baseByNode.keys()) nodeIds.add(id);
  for (const id of replayByNode.keys()) nodeIds.add(id);

  const perNode: RunComparisonNode[] = [];
  for (const nodeId of nodeIds) {
    perNode.push({
      nodeId,
      base: buildSide(baseByNode.get(nodeId), baseUsage.get(nodeId)),
      replay: buildSide(replayByNode.get(nodeId), replayUsage.get(nodeId)),
    });
  }
  perNode.sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  return {
    baseRun: summarize(baseRow),
    replayRun: summarize(replayRow),
    perNode,
  };
}

function buildSide(
  node: { status: string; startedAt: Date | null; finishedAt: Date | null; stateJson: unknown; errorJson: unknown } | undefined,
  usage: UsageAggregate | undefined,
): RunComparisonNodeSide {
  if (!node) return MISSING;
  return {
    status: node.status,
    latencyMs: computeLatency(node.startedAt ?? null, node.finishedAt ?? null),
    costUsd: usage?.costUsd ?? null,
    tokens: usage?.tokens ?? 0,
    output: projectOutput(node.status, node.stateJson),
    errorJson: node.errorJson ?? null,
  };
}

function summarize(row: typeof runs.$inferSelect): RunComparisonRunSummary {
  return {
    id: row.id,
    status: row.status,
    replayMode: row.replayMode ?? null,
    parentRunId: row.parentRunId ?? null,
    createdAt: row.createdAt ?? null,
  };
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
