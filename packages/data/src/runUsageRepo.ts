/**
 * Bounded, tenant-scoped resource usage projection for one workflow run.
 *
 * Used by:
 * - `apps/api/src/routes/runs-routes.ts` — `GET /run/usage`.
 * - the web Reasoning panel — resource-backed run diagnostics.
 *
 * Invariants:
 * - Reads at most the newest 10,000 usage rows and reports truncation.
 * - Never infers token, cost, or memory activity from partial run events.
 * - Every production query scopes both `org_id` and `run_id`.
 */

import { db, usageEvents } from "@janusly/db";
import { and, eq, sql } from "drizzle-orm";

export const RUN_USAGE_ROW_CAP = 10_000;

export type RunUsageRow = {
  metric: string;
  quantity: number | null;
  metadata: unknown;
};

export type RunMemoryUsageKind = {
  kind: string;
  recalls: number;
  commits: number;
  failures: number;
};

export type RunUsageSummary = {
  loadedRows: number;
  truncated: boolean;
  rowCap: number;
  llm: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    knownCostUsd: number;
    unknownCostCalls: number;
  };
  memory: {
    recalls: number;
    commits: number;
    failures: number;
    kinds: RunMemoryUsageKind[];
  };
};

function metadataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeSafeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function addSafeInteger(total: number, value: unknown): number {
  const increment = nonNegativeSafeInteger(value);
  return increment > Number.MAX_SAFE_INTEGER - total
    ? Number.MAX_SAFE_INTEGER
    : total + increment;
}

function addFiniteNumber(total: number, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return total;
  return value > Number.MAX_VALUE - total ? Number.MAX_VALUE : total + value;
}

/** Aggregate an already-bounded usage slice into an operator-safe summary. */
export function aggregateRunUsage(
  rows: readonly RunUsageRow[],
  options: { truncated?: boolean; rowCap?: number } = {},
): RunUsageSummary {
  const rowCap = options.rowCap ?? RUN_USAGE_ROW_CAP;
  const llm: RunUsageSummary["llm"] = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    knownCostUsd: 0,
    unknownCostCalls: 0,
  };
  const memoryByKind = new Map<string, RunMemoryUsageKind>();

  for (const row of rows) {
    const metadata = metadataRecord(row.metadata);
    if (row.metric === "llm.completion") {
      llm.calls += 1;
      llm.inputTokens = addSafeInteger(llm.inputTokens, metadata.inputTokens);
      llm.outputTokens = addSafeInteger(llm.outputTokens, metadata.outputTokens);
      llm.totalTokens = addSafeInteger(llm.totalTokens, row.quantity);
      llm.cachedInputTokens = addSafeInteger(llm.cachedInputTokens, metadata.cachedInputTokens);
      llm.cacheCreationInputTokens = addSafeInteger(
        llm.cacheCreationInputTokens,
        metadata.cacheCreationInputTokens,
      );
      if (typeof metadata.costUsd === "number" && Number.isFinite(metadata.costUsd) && metadata.costUsd >= 0) {
        llm.knownCostUsd = addFiniteNumber(llm.knownCostUsd, metadata.costUsd);
      } else {
        llm.unknownCostCalls += 1;
      }
      continue;
    }
    if (row.metric !== "memory.recall" && row.metric !== "memory.commit") continue;
    const kind = typeof metadata.kind === "string" && metadata.kind.trim()
      ? metadata.kind
      : "unknown";
    const current = memoryByKind.get(kind) ?? { kind, recalls: 0, commits: 0, failures: 0 };
    if (row.metric === "memory.recall") current.recalls += 1;
    else current.commits += 1;
    if (metadata.ok === false) current.failures += 1;
    memoryByKind.set(kind, current);
  }

  const kinds = [...memoryByKind.values()].sort((left, right) =>
    (right.recalls + right.commits) - (left.recalls + left.commits) || left.kind.localeCompare(right.kind));

  return {
    loadedRows: rows.length,
    truncated: options.truncated === true,
    rowCap,
    llm,
    memory: {
      recalls: kinds.reduce((sum, row) => sum + row.recalls, 0),
      commits: kinds.reduce((sum, row) => sum + row.commits, 0),
      failures: kinds.reduce((sum, row) => sum + row.failures, 0),
      kinds,
    },
  };
}

/** Query the newest bounded usage slice for one tenant-owned run. */
export async function queryRunUsage(orgId: string, runId: string): Promise<RunUsageSummary> {
  const rows = await db
    .select({
      metric: usageEvents.metric,
      quantity: usageEvents.quantity,
      metadata: usageEvents.metadata,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.orgId, orgId), eq(usageEvents.runId, runId)))
    // Match the generated index's explicit NULLS LAST order. `createdAt` is
    // historically nullable even though new writes default it, so plain DESC
    // would request Postgres' NULLS FIRST order and force a bounded re-sort.
    .orderBy(
      sql`${usageEvents.createdAt} DESC NULLS LAST`,
      sql`${usageEvents.id} DESC NULLS LAST`,
    )
    .limit(RUN_USAGE_ROW_CAP + 1);
  const truncated = rows.length > RUN_USAGE_ROW_CAP;
  return aggregateRunUsage(rows.slice(0, RUN_USAGE_ROW_CAP), { truncated });
}
