/**
 * Tests for the health-signal repo. Coverage today is focused on
 * `computeP95Latency` — the helper that moved from a JS-side fan-in to
 * a Postgres `PERCENTILE_CONT` aggregate. The mocked `db.execute`
 * exercises the four threading paths (short-circuit on small sample,
 * SQL returns null, SQL returns number, SQL returns string-numeric,
 * and the generated SQL keeps the fan-in cap + SQL-side filters wired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbExecute = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    execute: (...args: unknown[]) => dbExecute(...args),
    select: vi.fn(),
  },
  runs: { id: "id", orgId: "org_id" },
  runEvents: { runId: "run_id", createdAt: "created_at" },
  deadLetters: { id: "id" },
  usageEvents: { metric: "metric" },
  workflowVersions: { id: "id", orgId: "org_id", workflowId: "workflow_id", version: "version" },
}));

import { computeP95Latency } from "./workflowHealthRepo";

function flattenSql(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(flattenSql).join("");
  if (typeof value === "object") {
    const record = value as { queryChunks?: unknown[]; value?: unknown[] };
    if (Array.isArray(record.queryChunks)) return record.queryChunks.map(flattenSql).join("");
    if (Array.isArray(record.value)) return record.value.map(flattenSql).join("");
  }
  return "";
}

beforeEach(() => {
  dbExecute.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("computeP95Latency", () => {
  it("returns null without hitting the database when fewer than 5 runIds are supplied", async () => {
    const result = await computeP95Latency(["r-1", "r-2", "r-3", "r-4"], 30);
    expect(result).toBeNull();
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it("returns null when Postgres reports no qualifying rows (cap kicks in or HAVING filters everything)", async () => {
    dbExecute.mockResolvedValueOnce([{ p95_ms: null }]);
    const result = await computeP95Latency(["r-1", "r-2", "r-3", "r-4", "r-5"], 30);
    expect(result).toBeNull();
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it("returns null when Postgres returns no rows at all (HAVING COUNT(*) >= 5 failed)", async () => {
    dbExecute.mockResolvedValueOnce([]);
    const result = await computeP95Latency(["r-1", "r-2", "r-3", "r-4", "r-5"], 30);
    expect(result).toBeNull();
  });

  it("builds the capped Postgres percentile query with zero-duration filtering", async () => {
    dbExecute.mockResolvedValueOnce([{ p95_ms: 4800 }]);
    const result = await computeP95Latency(["r-1", "r-2", "r-3", "r-4", "r-5"], 1);
    const query = flattenSql(dbExecute.mock.calls[0]?.[0]);

    expect(result).toBe(4800);
    expect(query).toContain("PERCENTILE_CONT(0.95)");
    expect(query).toContain("LIMIT 2880");
    expect(query).toContain("HAVING MAX(created_at) > MIN(created_at)");
    expect(query).toContain("HAVING COUNT(*) >= 5");
  });

  it("returns the numeric percentile when Postgres returns a number", async () => {
    dbExecute.mockResolvedValueOnce([{ p95_ms: 1234 }]);
    const result = await computeP95Latency(
      ["r-1", "r-2", "r-3", "r-4", "r-5", "r-6", "r-7"],
      30,
    );
    expect(result).toBe(1234);
  });

  it("coerces postgres-js string-numeric results into a JavaScript number", async () => {
    // postgres-js sometimes returns numeric / int4 aggregates as
    // strings depending on driver config; the helper must coerce.
    dbExecute.mockResolvedValueOnce([{ p95_ms: "1234" }]);
    const result = await computeP95Latency(
      ["r-1", "r-2", "r-3", "r-4", "r-5", "r-6", "r-7"],
      30,
    );
    expect(result).toBe(1234);
  });
});
