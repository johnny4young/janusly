/**
 * Bounded `usage_events` aggregator. Sums `quantity` per `metric` over a
 * recent time window. The 30-day / 10k-row cap keeps a long-running org from
 * OOMing the API on every dashboard poll. The shared LLM recorder writes the
 * rows this query reads.
 *
 * Used by `apps/api/src/index.ts` `GET /billing/usage`, which the web's
 * "Usage summary" card consumes.
 *
 * Invariants:
 * - Multi-tenant scope: every query carries `eq(usageEvents.orgId, orgId)`.
 * - Don't unbound the scan. If richer historical reporting matters, build a
 *   pre-aggregated table — don't widen the window here.
 *
 * Two surfaces:
 *
 *   - `getUsageSummary(orgId, windowDays)` — flat `Record<metric, quantity>`
 *     for the existing dashboard. Same shape since v1; back-compat surface.
 *   - `getUsageBreakdown(orgId, dimensions, windowDays)` — multi-axis
 *     breakdown for the operator-grade cost dashboard. Reads the same
 *     bounded slice and groups in-process by the caller-requested
 *     dimensions: `provider` / `model` / `mode` / `day` / `node` /
 *     `workflow`. Per-bucket returns token totals, call count, fallback
 *     count, costUsd sum (skipping null prices), and latency aggregates
 *     (p50 / p95 / avg).
 *
 * The pure aggregator `aggregateUsageBreakdown` is exported separately so
 * tests can pin behaviour without standing up Postgres.
 */

import { db } from "@janusly/db";
import { usageEvents } from "@janusly/db";
import { and, eq, gte } from "drizzle-orm";

/** Default time window for both summary and breakdown queries. */
export const DEFAULT_USAGE_WINDOW_DAYS = 30;
const USAGE_QUERY_LIMIT = 10_000;

/** Aggregate `usage_events.quantity` per `metric` for one org over the last `windowDays`. */
export async function getUsageSummary(orgId: string, windowDays = DEFAULT_USAGE_WINDOW_DAYS) {
  // Bound the scan so a long-running org doesn't OOM the API on every dashboard
  // poll. For richer historical reporting build a pre-aggregated table.
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.orgId, orgId), gte(usageEvents.createdAt, since)))
    .limit(USAGE_QUERY_LIMIT);

  const summary: Record<string, number> = {};

  for (const row of rows) {
    summary[row.metric] = (summary[row.metric] ?? 0) + (row.quantity ?? 0);
  }

  return summary;
}

/* ----------------------------- Breakdown reporting ----------------------------- */

/**
 * Closed enum of breakdown dimensions the route accepts. Six axes:
 *
 *   - `provider` — `metadata.provider` (registry key, e.g. `anthropic`).
 *   - `model` — `metadata.model` (resolved id).
 *   - `mode` — `"ai"` vs `"fallback"` per the AGENTS.md AI-fallback contract.
 *   - `day` — UTC `YYYY-MM-DD` from `usage_events.createdAt`.
 *   - `node` — `metadata.nodeId` (the workflow node that fired the LLM call).
 *   - `workflow` — `metadata.workflowId` (the saved-workflow id, populated
 *     by `/ai/*` routes that have the workflow in scope and by the
 *     engine's `ai`/`agent` executors via `getRunMetadata`).
 *
 * `/ai/generate-workflow` calls leave `workflowId` absent (no workflow
 * exists yet at LLM-call time); those rows bucket under `workflow=unknown`.
 */
export const USAGE_BREAKDOWN_DIMENSIONS = ["provider", "model", "mode", "day", "node", "workflow"] as const;
export type UsageBreakdownDimension = typeof USAGE_BREAKDOWN_DIMENSIONS[number];

/** Type guard for use at the route's query-string boundary. */
export function isUsageBreakdownDimension(value: unknown): value is UsageBreakdownDimension {
  return typeof value === "string" && (USAGE_BREAKDOWN_DIMENSIONS as readonly string[]).includes(value);
}

/** Per-bucket aggregate returned by `getUsageBreakdown`. Only requested dimension fields are populated. */
export type UsageBreakdownBucket = {
  /**
   * Stable bucket key — concatenates the requested dimension values in
   * the order they were passed. Useful as a React row key. Format
   * mirrors `provider=anthropic|model=claude-haiku-4-5-20251001`.
   */
  key: string;
  provider?: string;
  model?: string;
  mode?: "ai" | "fallback";
  /** ISO `YYYY-MM-DD` day in UTC. */
  day?: string;
  /** Workflow node id from `metadata.nodeId`. */
  node?: string;
  /** Saved-workflow id from `metadata.workflowId`. */
  workflow?: string;
  /** Sum of `usage_events.quantity` (token total when metric=`llm.completion`). */
  quantity: number;
  /** Number of underlying rows in the bucket. */
  callCount: number;
  /** Rows where `metadata.mode === "fallback"`. */
  fallbackCount: number;
  /**
   * Sum of `metadata.costUsd` over rows that carry a non-null cost.
   * `null` when EVERY row in the bucket has a null cost (unknown-model
   * pricing) — never coerce-to-zero, otherwise an unknown-model bucket
   * would falsely report `$0` instead of "unknown".
   */
  costUsd: number | null;
  /** Latency aggregates over `metadata.latencyMs`. `null` when no rows have a latency value. */
  latency: {
    p50Ms: number | null;
    p95Ms: number | null;
    avgMs: number | null;
  };
};

/**
 * Subset of `usage_events` row shape the aggregator reads. Exported so
 * tests can build fixtures without depending on Drizzle's inferred type
 * (which varies with Drizzle versions).
 */
export type UsageEventRow = {
  metric: string;
  quantity: number | null;
  metadata: unknown;
  createdAt: Date | string | null;
};

/** Subset of `usage_events.metadata` the aggregator reads. */
type UsageEventMetadata = {
  provider?: string;
  model?: string;
  mode?: "ai" | "fallback";
  costUsd?: number | null;
  latencyMs?: number | null;
  nodeId?: string;
  workflowId?: string;
};

function parseMetadata(value: unknown): UsageEventMetadata {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: UsageEventMetadata = {};
  if (typeof raw.provider === "string") out.provider = raw.provider;
  if (typeof raw.model === "string") out.model = raw.model;
  if (raw.mode === "ai" || raw.mode === "fallback") out.mode = raw.mode;
  if (typeof raw.costUsd === "number") out.costUsd = raw.costUsd;
  if (typeof raw.latencyMs === "number") out.latencyMs = raw.latencyMs;
  if (typeof raw.nodeId === "string") out.nodeId = raw.nodeId;
  if (typeof raw.workflowId === "string") out.workflowId = raw.workflowId;
  return out;
}

function dayBucketKey(value: Date | string | null | undefined): string {
  if (!value) return "unknown";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  // Use UTC YYYY-MM-DD so timezone drift doesn't split a single
  // calendar day across two buckets.
  return date.toISOString().slice(0, 10);
}

function dimensionValue(row: UsageEventRow, metadata: UsageEventMetadata, dim: UsageBreakdownDimension): string {
  switch (dim) {
    case "provider": return metadata.provider ?? "unknown";
    case "model": return metadata.model ?? "unknown";
    case "mode": return metadata.mode ?? "unknown";
    case "day": return dayBucketKey(row.createdAt);
    case "node": return metadata.nodeId ?? "unknown";
    case "workflow": return metadata.workflowId ?? "unknown";
  }
}

/** Pre-sorted percentile pick — returns the value at `ceil(p * N) - 1` index, bounded at `[0, N-1]`. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Pure aggregator — groups rows by the requested dimensions and
 * computes per-bucket aggregates. Exported for tests; production
 * callers go through `getUsageBreakdown` which runs the DB read first.
 *
 * Dimensions are de-duplicated (preserving first-occurrence order).
 * Empty dimensions list returns `[]` (the caller should fall through
 * to `getUsageSummary` instead).
 */
export function aggregateUsageBreakdown(
  rows: readonly UsageEventRow[],
  dimensions: readonly UsageBreakdownDimension[],
): UsageBreakdownBucket[] {
  // Dedupe while preserving first-occurrence order.
  const dims: UsageBreakdownDimension[] = [];
  const seen = new Set<UsageBreakdownDimension>();
  for (const dim of dimensions) {
    if (seen.has(dim)) continue;
    seen.add(dim);
    dims.push(dim);
  }
  if (dims.length === 0) return [];

  type BucketState = {
    bucket: UsageBreakdownBucket;
    costSum: number;
    costRowsWithValue: number;
    latencies: number[];
  };

  const buckets = new Map<string, BucketState>();

  for (const row of rows) {
    const metadata = parseMetadata(row.metadata);
    // Every dimension contributes a `name=value` segment to the key
    // so two buckets that differ only on a single dimension don't
    // collide. Format choice is debug-friendly without being noisy.
    const keyParts = dims.map((dim) => `${dim}=${dimensionValue(row, metadata, dim)}`);
    const key = keyParts.join("|");

    let state = buckets.get(key);
    if (!state) {
      const bucket: UsageBreakdownBucket = {
        key,
        quantity: 0,
        callCount: 0,
        fallbackCount: 0,
        costUsd: null,
        latency: { p50Ms: null, p95Ms: null, avgMs: null },
      };
      // Populate per-dimension fields only for the requested axes.
      for (const dim of dims) {
        const value = dimensionValue(row, metadata, dim);
        if (dim === "mode") {
          if (value === "ai" || value === "fallback") bucket.mode = value;
        } else {
          bucket[dim] = value;
        }
      }
      state = { bucket, costSum: 0, costRowsWithValue: 0, latencies: [] };
      buckets.set(key, state);
    }

    state.bucket.callCount += 1;
    state.bucket.quantity += row.quantity ?? 0;
    if (metadata.mode === "fallback") state.bucket.fallbackCount += 1;
    if (typeof metadata.costUsd === "number") {
      state.costSum += metadata.costUsd;
      state.costRowsWithValue += 1;
    }
    if (typeof metadata.latencyMs === "number") state.latencies.push(metadata.latencyMs);
  }

  const out: UsageBreakdownBucket[] = [];
  for (const { bucket, costSum, costRowsWithValue, latencies } of buckets.values()) {
    bucket.costUsd = costRowsWithValue > 0 ? costSum : null;
    if (latencies.length > 0) {
      const sorted = [...latencies].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      bucket.latency = {
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        avgMs: sum / sorted.length,
      };
    }
    out.push(bucket);
  }
  return out;
}

/**
 * Group `usage_events` by the requested dimensions over a bounded
 * window. Reads the same 30-day / 10k-row slice as `getUsageSummary`
 * and aggregates in-process via `aggregateUsageBreakdown`. Multi-
 * tenant scoped via `eq(usageEvents.orgId, orgId)`. Returns `[]` when
 * `dimensions` is empty (caller should use `getUsageSummary` instead).
 */
export async function getUsageBreakdown(
  orgId: string,
  dimensions: readonly UsageBreakdownDimension[],
  windowDays = DEFAULT_USAGE_WINDOW_DAYS,
): Promise<UsageBreakdownBucket[]> {
  if (dimensions.length === 0) return [];
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      metric: usageEvents.metric,
      quantity: usageEvents.quantity,
      metadata: usageEvents.metadata,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.orgId, orgId), gte(usageEvents.createdAt, since)))
    .limit(USAGE_QUERY_LIMIT);
  return aggregateUsageBreakdown(rows as UsageEventRow[], dimensions);
}
