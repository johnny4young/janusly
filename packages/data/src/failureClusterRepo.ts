/**
 * Repository for failure-cluster samples — the inputs the engine's
 * `clusterFailureSamples` aggregator (in `@janusly/engine`) walks to
 * group recent failures by normalized signature.
 *
 * Single function `collectFailureSamples(orgId, windowDays, limit)` runs
 * two parallel SQL queries — one over `dead_letters`, one over failed
 * `run_nodes` — and returns a flat list of typed samples. The engine
 * layer normalizes and clusters; this module only collects.
 *
 * Used by `apps/api/src/index.ts:GET /dlq/clusters`.
 *
 * Invariants:
 * - Multi-tenant scope: every query carries an org-scoped persisted row
 *   filter (`dead_letters.org_id` or `runs.org_id`). Saved workflows left
 *   join through `workflow_versions` for names; ad-hoc runs fall back to
 *   the persisted workflow snapshot.
 * - Window cap: matches the 30-day convention used by
 *   `workflowHealthRepo` and `getUsageSummary`. Don't unbound the scan.
 * - Sample cap: defaults to 500 rows per source. Cluster computation is
 *   O(N) so 500 entries is fine; clusters scale by the number of
 *   distinct signatures, not raw failures.
 *
 * Note on the cross-module shape: `FailureSample` is duplicated here and
 * in `@janusly/engine/src/cluster-failures.ts` so `data` never imports
 * from `engine`. The API wires repo → engine through structural typing.
 */

import { db } from "@janusly/db";
import { deadLetters, runNodes, runs, workflowVersions, workflows } from "@janusly/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

/** One row read from either `dead_letters` or a failed `run_nodes` row. */
export type FailureSample = {
  source: "dead_letter" | "failed_run_node";
  /** Stable identifier for drill-down — DLQ id for `dead_letter`, composite `runId:nodeId` for `failed_run_node`. */
  id: string;
  workflowId: string;
  workflowName: string;
  runId: string;
  nodeId: string;
  /** Failing node's type. Falls back to `"node"` when not present in `nodeJson`. */
  nodeType: string;
  /** Optional resolved tool name when `nodeType === "tool"`. */
  toolName?: string;
  /** The error envelope as persisted; safe-persist already key-redacted before this point. */
  errorJson: unknown;
  createdAt: Date;
};

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_SAMPLE_LIMIT = 500;

/**
 * Collect a flat list of failure samples for one org over a rolling
 * window. Returns rows from both `dead_letters` and failed `run_nodes`;
 * the engine layer deduplicates `(runId, nodeId)` pairs so a failed run
 * that landed in DLQ counts once, not twice.
 */
export async function collectFailureSamples(
  orgId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
  limit = DEFAULT_SAMPLE_LIMIT,
): Promise<FailureSample[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const [dlqRows, failedRunRows] = await Promise.all([
    queryDeadLetters(orgId, since, limit),
    queryFailedRunNodes(orgId, since, limit),
  ]);

  return [...dlqRows, ...failedRunRows];
}

async function queryDeadLetters(orgId: string, since: Date, limit: number): Promise<FailureSample[]> {
  const rows = await db
    .select({
      id: deadLetters.id,
      runId: deadLetters.runId,
      nodeId: deadLetters.nodeId,
      workflowJson: deadLetters.workflowJson,
      nodeJson: deadLetters.nodeJson,
      errorJson: deadLetters.errorJson,
      createdAt: deadLetters.createdAt,
      workflowId: workflowVersions.workflowId,
      workflowName: workflows.name,
    })
    .from(deadLetters)
    .innerJoin(runs, eq(runs.id, deadLetters.runId))
    .leftJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .leftJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(and(
      eq(deadLetters.orgId, orgId),
      gte(deadLetters.createdAt, since),
    ))
    .orderBy(desc(deadLetters.createdAt))
    .limit(limit);

  return rows.map((row) => {
    const workflowId = row.workflowId ?? extractWorkflowId(row.workflowJson);
    return {
      source: "dead_letter" as const,
      id: row.id,
      runId: row.runId,
      nodeId: row.nodeId,
      workflowId,
      workflowName: row.workflowName ?? extractWorkflowName(row.workflowJson, workflowId),
      nodeType: extractNodeType(row.nodeJson),
      toolName: extractToolName(row.nodeJson),
      errorJson: row.errorJson,
      createdAt: row.createdAt ?? new Date(0),
    };
  });
}

async function queryFailedRunNodes(orgId: string, since: Date, limit: number): Promise<FailureSample[]> {
  // The failed-runs branch joins `run_nodes` (status = 'failed') back
  // through `runs` for multi-tenant scope, then left joins
  // `workflow_versions` for saved workflow context. Ad-hoc runs have no
  // version row, so we fall back to `runs.input_json.workflow`. Windowing
  // uses the node finish time when present and falls back to run creation.
  const rows = await db
    .select({
      runId: runNodes.runId,
      nodeId: runNodes.nodeId,
      stateJson: runNodes.stateJson,
      errorJson: runNodes.errorJson,
      finishedAt: runNodes.finishedAt,
      inputJson: runs.inputJson,
      runCreatedAt: runs.createdAt,
      workflowId: workflowVersions.workflowId,
      workflowName: workflows.name,
      dagJson: workflowVersions.dagJson,
    })
    .from(runNodes)
    .innerJoin(runs, eq(runs.id, runNodes.runId))
    .leftJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .leftJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(and(
      eq(runs.orgId, orgId),
      eq(runNodes.status, "failed"),
      gte(sql`COALESCE(${runNodes.finishedAt}, ${runs.createdAt})`, since),
    ))
    .orderBy(desc(sql`COALESCE(${runNodes.finishedAt}, ${runs.createdAt})`))
    .limit(limit);

  return rows.map((row) => {
    const workflowJson = row.dagJson ?? extractWorkflowFromRunInput(row.inputJson);
    const workflowId = row.workflowId ?? extractWorkflowId(workflowJson);
    const nodeMeta = lookupNodeFromDag(workflowJson, row.nodeId);
    return {
      source: "failed_run_node" as const,
      id: `${row.runId}:${row.nodeId}`,
      runId: row.runId,
      nodeId: row.nodeId,
      workflowId,
      workflowName: row.workflowName ?? extractWorkflowName(workflowJson, workflowId),
      nodeType: nodeMeta.type,
      toolName: nodeMeta.toolName,
      errorJson: row.errorJson,
      createdAt: row.finishedAt ?? row.runCreatedAt ?? new Date(0),
    };
  });
}

function extractWorkflowFromRunInput(inputJson: unknown): unknown {
  if (!inputJson || typeof inputJson !== "object" || Array.isArray(inputJson)) return null;
  const workflow = (inputJson as Record<string, unknown>).workflow;
  return workflow && typeof workflow === "object" && !Array.isArray(workflow) ? workflow : null;
}

function extractWorkflowId(workflowJson: unknown): string {
  if (workflowJson && typeof workflowJson === "object" && !Array.isArray(workflowJson)) {
    const id = (workflowJson as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return "ad-hoc-workflow";
}

function extractWorkflowName(workflowJson: unknown, fallback: string): string {
  if (workflowJson && typeof workflowJson === "object" && !Array.isArray(workflowJson)) {
    const name = (workflowJson as Record<string, unknown>).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return fallback;
}

function extractNodeType(nodeJson: unknown): string {
  if (nodeJson && typeof nodeJson === "object" && !Array.isArray(nodeJson)) {
    const type = (nodeJson as Record<string, unknown>).type;
    if (typeof type === "string" && type.length > 0) return type;
  }
  return "node";
}

function extractToolName(nodeJson: unknown): string | undefined {
  if (!nodeJson || typeof nodeJson !== "object" || Array.isArray(nodeJson)) return undefined;
  const cfg = (nodeJson as Record<string, unknown>).config;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return undefined;
  const tool = (cfg as Record<string, unknown>).tool;
  return typeof tool === "string" ? tool : undefined;
}

/**
 * Pull the `{ type, toolName? }` for a node id out of the workflow's
 * persisted DAG JSON. Falls back to a generic `"node"` when the row
 * predates the schema or the node was renamed.
 */
function lookupNodeFromDag(dagJson: unknown, nodeId: string): { type: string; toolName?: string } {
  if (!dagJson || typeof dagJson !== "object" || Array.isArray(dagJson)) return { type: "node" };
  const nodes = (dagJson as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return { type: "node" };
  for (const candidate of nodes) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as Record<string, unknown>;
    if (obj.id === nodeId) {
      const type = typeof obj.type === "string" ? obj.type : "node";
      const cfg = obj.config && typeof obj.config === "object" && !Array.isArray(obj.config)
        ? (obj.config as Record<string, unknown>)
        : null;
      const toolName = cfg && typeof cfg.tool === "string" ? cfg.tool : undefined;
      return { type, toolName };
    }
  }
  return { type: "node" };
}
