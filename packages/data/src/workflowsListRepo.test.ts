/**
 * Tests for the Flows-list repo. The DB select-builder is mocked with a
 * single chainable stub: the base list resolves at `.limit()`, the run
 * aggregate resolves at `.groupBy()`. Coverage: empty-org short-circuit
 * (no aggregate query) and the LEFT fold (agg passthrough + zero-run
 * workflows defaulting to runCount 0 / lastRunStatus null).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let baseRows: Array<Record<string, unknown>> = [];
let aggRows: Array<Record<string, unknown>> = [];

// One chainable stub shared by both queries: base ends at .limit(), the
// aggregate ends at .groupBy(). Every other builder method returns `this`.
const chain: Record<string, unknown> = {
  from: () => chain,
  where: () => chain,
  orderBy: () => chain,
  innerJoin: () => chain,
  limit: () => Promise.resolve(baseRows),
  groupBy: () => Promise.resolve(aggRows),
};

vi.mock("@janusly/db", () => ({
  db: { select: () => chain },
  runs: { id: "id", status: "status", createdAt: "created_at", replayMode: "replay_mode", workflowVersionId: "workflow_version_id" },
  workflows: { id: "id", orgId: "org_id", name: "name", createdBy: "created_by", createdAt: "created_at" },
  workflowVersions: { id: "id", orgId: "org_id", workflowId: "workflow_id" },
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
      { id: "wf-a", orgId: "org-1", name: "A", createdBy: "u", createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "wf-b", orgId: "org-1", name: "B", createdBy: null, createdAt: new Date("2026-01-02T00:00:00Z") },
    ];
    aggRows = [{ workflowId: "wf-a", runCount: 3, lastRunStatus: "failed" }];

    const rows = await listWorkflowsWithRunSummary("org-1", 100);

    expect(rows).toEqual([
      { id: "wf-a", orgId: "org-1", name: "A", createdBy: "u", createdAt: new Date("2026-01-01T00:00:00Z"), lastRunStatus: "failed", runCount: 3 },
      { id: "wf-b", orgId: "org-1", name: "B", createdBy: null, createdAt: new Date("2026-01-02T00:00:00Z"), lastRunStatus: null, runCount: 0 },
    ]);
  });
});
