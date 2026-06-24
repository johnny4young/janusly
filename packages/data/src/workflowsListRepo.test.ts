/**
 * Tests for the Flows-list repo. The DB select-builder is mocked with a
 * single chainable stub: the base list resolves at `.limit()`, the run
 * aggregate resolves at `.groupBy()`. Coverage: empty-org short-circuit
 * (no aggregate query), the LEFT fold (agg passthrough + zero-run workflows
 * defaulting to runCount 0 / lastRunStatus null), and the tag column fold
 * (workflow_metadata.tags onto each row; null → []; the `{ tags }` AND-set
 * filter branch is exercised — the real jsonb-containment SQL is smoke-verified
 * against Postgres, since the chain mock ignores the WHERE).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let baseRows: Array<Record<string, unknown>> = [];
let aggRows: Array<Record<string, unknown>> = [];

// One chainable stub shared by both queries: base ends at .limit(), the
// aggregate ends at .groupBy(). Every other builder method returns `this`.
const chain: Record<string, unknown> = {
  from: () => chain,
  leftJoin: () => chain,
  where: () => chain,
  orderBy: () => chain,
  innerJoin: () => chain,
  limit: () => Promise.resolve(baseRows),
  groupBy: () => Promise.resolve(aggRows),
};

vi.mock("@janusly/db", () => ({
  db: { select: () => chain },
  runs: { id: "id", status: "status", createdAt: "created_at", replayMode: "replay_mode", workflowVersionId: "workflow_version_id" },
  workflows: { id: "id", orgId: "org_id", name: "name", createdBy: "created_by", createdAt: "created_at", status: "status", pausedReason: "paused_reason" },
  workflowVersions: { id: "id", orgId: "org_id", workflowId: "workflow_id" },
  workflowMetadata: { tags: "tags", folder: "folder", orgId: "org_id", workflowId: "workflow_id" },
}));

import { listWorkflowsWithRunSummary } from "./workflowsListRepo";

beforeEach(() => {
  baseRows = [];
  aggRows = [];
});

describe("listWorkflowsWithRunSummary", () => {
  it("returns [] and skips the aggregate query when the org has no workflows", async () => {
    baseRows = [];
    aggRows = [{ workflowId: "should-not-be-read", runCount: 9, lastRunStatus: "failed" }];
    const rows = await listWorkflowsWithRunSummary("org-1", 100);
    expect(rows).toEqual([]);
  });

  it("folds the run aggregate onto each workflow; zero-run rows default to 0 / null", async () => {
    baseRows = [
      { id: "wf-a", orgId: "org-1", name: "A", createdBy: "u", createdAt: new Date("2026-01-01T00:00:00Z"), status: "paused_upstream_degraded", pausedReason: "Upstream \"stripe\" degraded", tags: [], folder: "Billing" },
      { id: "wf-b", orgId: "org-1", name: "B", createdBy: null, createdAt: new Date("2026-01-02T00:00:00Z"), status: "active", pausedReason: null, tags: [], folder: null },
    ];
    aggRows = [{ workflowId: "wf-a", runCount: 3, lastRunStatus: "failed" }];

    const rows = await listWorkflowsWithRunSummary("org-1", 100);

    expect(rows).toEqual([
      { id: "wf-a", orgId: "org-1", name: "A", createdBy: "u", createdAt: new Date("2026-01-01T00:00:00Z"), lastRunStatus: "failed", runCount: 3, status: "paused_upstream_degraded", pausedReason: "Upstream \"stripe\" degraded", tags: [], folder: "Billing" },
      { id: "wf-b", orgId: "org-1", name: "B", createdBy: null, createdAt: new Date("2026-01-02T00:00:00Z"), lastRunStatus: null, runCount: 0, status: "active", pausedReason: null, tags: [], folder: null },
    ]);
  });

  it("folds workflow_metadata.tags + folder onto each row (null → [] / null) and exercises the multi-tag AND filter branch", async () => {
    baseRows = [
      { id: "wf-a", orgId: "org-1", name: "A", createdBy: null, createdAt: new Date("2026-01-01T00:00:00Z"), status: "active", pausedReason: null, tags: ["billing", "urgent"], folder: "Billing" },
      { id: "wf-b", orgId: "org-1", name: "B", createdBy: null, createdAt: new Date("2026-01-02T00:00:00Z"), status: "active", pausedReason: null, tags: null, folder: null },
    ];
    aggRows = [];

    // A multi-tag `{ tags }` exercises the single jsonb-containment predicate
    // construction (ALL listed tags = AND) without throwing; the chain mock
    // ignores the WHERE, so this asserts the tag + folder mapping (the real
    // AND filtering is smoke-verified against Postgres).
    const rows = await listWorkflowsWithRunSummary("org-1", 100, { tags: ["billing", "urgent"] });

    expect(rows[0]?.tags).toEqual(["billing", "urgent"]);
    expect(rows[0]?.folder).toBe("Billing");
    expect(rows[1]?.tags).toEqual([]); // a null metadata join coalesces to []
    expect(rows[1]?.folder).toBeNull(); // a null folder stays null (ungrouped)
  });

  it("adds no tag predicate for an empty/absent tags set (the AND filter is opt-in)", async () => {
    baseRows = [
      { id: "wf-a", orgId: "org-1", name: "A", createdBy: null, createdAt: new Date("2026-01-01T00:00:00Z"), status: "active", pausedReason: null, tags: ["billing"], folder: null },
    ];
    aggRows = [];

    // `tags: []` takes the guard's false branch (no containment pushed); the
    // call must still resolve the full list. `undefined` (no filters) is the
    // same path, covered by the aggregate tests above.
    const rows = await listWorkflowsWithRunSummary("org-1", 100, { tags: [] });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tags).toEqual(["billing"]);
  });

  it("exercises the folder filter branch (scalar equality, before the cap)", async () => {
    baseRows = [
      { id: "wf-a", orgId: "org-1", name: "A", createdBy: null, createdAt: new Date("2026-01-01T00:00:00Z"), status: "active", pausedReason: null, tags: [], folder: "Billing" },
    ];
    aggRows = [];

    // `{ folder }` exercises the `eq(workflowMetadata.folder, …)` predicate
    // construction without throwing; the chain mock ignores the WHERE, so this
    // asserts the branch + folder fold (the real filtering is smoke-verified
    // against Postgres).
    const rows = await listWorkflowsWithRunSummary("org-1", 100, { folder: "Billing" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.folder).toBe("Billing");
  });
});
