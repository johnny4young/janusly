/**
 * Tests for the cron-observability history repo. Coverage focuses on the
 * two invariants that can't be asserted from the engine's pure bucketing
 * tests: (1) the fire query is multi-tenant + workflow scoped AND filters to
 * scheduler-created runs, and (2) the window/row caps are clamped before they
 * reach the query builder. The drizzle builder chain is mocked (mirrors
 * `workflowSloRepo.test.ts`) and the captured `.where()` / `.limit()`
 * arguments are flattened to assert the predicate shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fireWhereMock = vi.fn();
const fireLimitMock = vi.fn();
const entriesWhereMock = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // queryScheduleFires: .innerJoin().where().orderBy().limit()
        innerJoin: vi.fn(() => ({
          where: fireWhereMock,
        })),
        // findScheduleEntriesForWorkflow: .where()
        where: entriesWhereMock,
      })),
    })),
  },
  runs: { id: "runs.id", createdAt: "runs.created_at", status: "runs.status", inputJson: "runs.input_json", replayMode: "runs.replay_mode", workflowVersionId: "runs.workflow_version_id" },
  scheduleEntries: { orgId: "schedule_entries.org_id", workflowId: "schedule_entries.workflow_id", nodeId: "schedule_entries.node_id", cronExpression: "schedule_entries.cron_expression", enabled: "schedule_entries.enabled", lastRunAt: "schedule_entries.last_run_at", lastRunId: "schedule_entries.last_run_id", workflowVersionId: "schedule_entries.workflow_version_id" },
  workflowVersions: { id: "workflow_versions.id", orgId: "workflow_versions.org_id", workflowId: "workflow_versions.workflow_id" },
}));

import {
  findScheduleEntriesForWorkflow,
  queryScheduleFires,
  MAX_SCHEDULE_FIRE_ROWS,
} from "./scheduleHistoryRepo";

/** Flatten a drizzle SQL / predicate object into a comparable string. */
function flattenSql(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(flattenSql).join(" ");
  if (typeof value === "object") {
    const record = value as { queryChunks?: unknown[]; value?: unknown[]; left?: unknown; right?: unknown };
    const parts: string[] = [];
    if (Array.isArray(record.queryChunks)) parts.push(record.queryChunks.map(flattenSql).join(" "));
    if (Array.isArray(record.value)) parts.push(record.value.map(flattenSql).join(" "));
    if (record.left !== undefined) parts.push(flattenSql(record.left));
    if (record.right !== undefined) parts.push(flattenSql(record.right));
    return parts.join(" ");
  }
  return "";
}

beforeEach(() => {
  vi.clearAllMocks();
  fireWhereMock.mockReset();
  fireLimitMock.mockReset();
  entriesWhereMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function mockFireQuery(rows: Array<{ firedAt: Date; status: string }>) {
  fireWhereMock.mockReturnValueOnce({
    orderBy: vi.fn().mockReturnValueOnce({
      limit: fireLimitMock.mockResolvedValueOnce(rows),
    }),
  });
}

describe("queryScheduleFires", () => {
  it("scopes the fire query to the org + workflow and filters to scheduler-created runs", async () => {
    mockFireQuery([]);
    await queryScheduleFires("org-1", "wf-billing", 30);

    const whereArg = flattenSql(fireWhereMock.mock.calls[0]?.[0]);
    // Multi-tenant + workflow scope (joined through workflow_versions).
    expect(whereArg).toContain("workflow_versions.org_id");
    expect(whereArg).toContain("workflow_versions.workflow_id");
    // Only runs the scheduler created.
    expect(whereArg).toContain("triggeredBy");
    expect(whereArg).toContain("schedule");
    // Validation runs excluded.
    expect(whereArg).toContain("runs.replay_mode");
  });

  it("clamps windowDays to [1, 90] and the row cap to MAX_SCHEDULE_FIRE_ROWS", async () => {
    mockFireQuery([]);
    await queryScheduleFires("org-1", "wf", 9999, 99999);
    // The clamped row cap reaches `.limit()`.
    expect(fireLimitMock).toHaveBeenCalledWith(MAX_SCHEDULE_FIRE_ROWS);
  });

  it("clamps a sub-1 window up to 1 day and a sub-1 cap up to 1 row", async () => {
    mockFireQuery([]);
    await queryScheduleFires("org-1", "wf", 0, 0);
    expect(fireLimitMock).toHaveBeenCalledWith(1);
  });

  it("maps rows to { firedAt, status } and drops malformed rows", async () => {
    mockFireQuery([
      { firedAt: new Date("2024-01-01T09:00:00Z"), status: "succeeded" },
      { firedAt: new Date("2024-01-01T10:00:00Z"), status: "failed" },
      // malformed — non-Date firedAt is dropped
      { firedAt: "nope" as unknown as Date, status: "succeeded" },
    ]);
    const result = await queryScheduleFires("org-1", "wf", 30);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ firedAt: new Date("2024-01-01T09:00:00Z"), status: "succeeded" });
  });

  it("returns an empty array when the workflow has no scheduled runs", async () => {
    mockFireQuery([]);
    const result = await queryScheduleFires("org-1", "wf", 30);
    expect(result).toEqual([]);
  });
});

describe("findScheduleEntriesForWorkflow", () => {
  it("scopes the entry read to the caller's org + workflow", async () => {
    entriesWhereMock.mockResolvedValueOnce([]);
    await findScheduleEntriesForWorkflow("org-1", "wf-billing");
    const whereArg = flattenSql(entriesWhereMock.mock.calls[0]?.[0]);
    expect(whereArg).toContain("schedule_entries.org_id");
    expect(whereArg).toContain("schedule_entries.workflow_id");
  });

  it("normalizes nullable last-fire fields to null", async () => {
    entriesWhereMock.mockResolvedValueOnce([
      { nodeId: "cron-1", cronExpression: "0 9 * * *", enabled: true, lastRunAt: undefined, lastRunId: undefined, workflowVersionId: "v1" },
    ]);
    const result = await findScheduleEntriesForWorkflow("org-1", "wf");
    expect(result).toEqual([
      { nodeId: "cron-1", cronExpression: "0 9 * * *", enabled: true, lastRunAt: null, lastRunId: null, workflowVersionId: "v1" },
    ]);
  });
});
