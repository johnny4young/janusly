/**
 * Unit tests for the upstream-health sources repo.
 *
 * Mocks `@janusly/db` so no Postgres is hit. Captures the predicate passed to
 * `.where(...)` so the multi-tenant scoping can be asserted, and drives the
 * latest-version tag-resolution + pause/resume returning logic.
 *
 * Covers the upstream-health awareness acceptance cases:
 *   - cross-org isolation: every read/write threads orgId into the predicate;
 *     `listWorkflowIdsTaggedWithSource` only returns workflows in the queried
 *     org and only those whose LATEST version carries the tag
 *   - pause/resume return the actually-flipped ids (idempotency surface)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the args passed to drizzle's `eq` / `and` / `inArray` so the
// predicate composition (and therefore the orgId scoping) is observable.
const eqCalls: Array<[unknown, unknown]> = [];
const inArrayCalls: Array<[unknown, unknown]> = [];

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      eqCalls.push([col, val]);
      return { __eq: [col, val] };
    },
    and: (...parts: unknown[]) => ({ __and: parts }),
    inArray: (col: unknown, vals: unknown) => {
      inArrayCalls.push([col, vals]);
      return { __inArray: [col, vals] };
    },
    sql: actual.sql,
  };
});

// Drizzle fluent-chain stub. Each query terminator resolves the queued rows;
// `.returning(...)` resolves the queued returning rows.
let selectRows: unknown[] = [];
let returningRows: unknown[] = [];
const whereSpy = vi.fn();

function makeSelectChain() {
  const terminal = {
    where: (predicate: unknown) => {
      whereSpy(predicate);
      return {
        orderBy: () => Promise.resolve(selectRows),
        then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(selectRows).then(resolve),
      };
    },
  };
  return { from: () => terminal };
}

function makeUpdateChain() {
  return {
    set: () => ({
      where: (predicate: unknown) => {
        whereSpy(predicate);
        return { returning: () => Promise.resolve(returningRows) };
      },
    }),
  };
}

vi.mock("@janusly/db", () => ({
  db: {
    select: () => makeSelectChain(),
    update: () => makeUpdateChain(),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    delete: () => ({ where: () => Promise.resolve(undefined) }),
  },
  upstreamHealthSources: { orgId: "uhs.org_id", id: "uhs.id", name: "uhs.name", enabled: "uhs.enabled" },
  workflows: { orgId: "wf.org_id", id: "wf.id", status: "wf.status", pausedReason: "wf.paused_reason" },
  workflowVersions: { orgId: "wv.org_id", workflowId: "wv.workflow_id", version: "wv.version", upstreamHealthSources: "wv.upstream_health_sources" },
}));

import {
  listWorkflowIdsTaggedWithSource,
  pauseWorkflowsForUpstream,
  resumeWorkflowsForUpstream,
  getWorkflowStatus,
} from "./upstreamHealthSourcesRepo";

beforeEach(() => {
  eqCalls.length = 0;
  inArrayCalls.length = 0;
  selectRows = [];
  returningRows = [];
  whereSpy.mockClear();
});

describe("listWorkflowIdsTaggedWithSource", () => {
  it("scopes the version read to the queried org", async () => {
    selectRows = [];
    await listWorkflowIdsTaggedWithSource("org-a", "stripe-prod");
    // The org predicate must be present with the caller's org, never another.
    expect(eqCalls).toContainEqual(["wv.org_id", "org-a"]);
    expect(eqCalls).not.toContainEqual(["wv.org_id", "org-b"]);
  });

  it("only returns workflows whose LATEST version carries the tag", async () => {
    selectRows = [
      // wf-1: tag present on v2 (latest) → matches
      { workflowId: "wf-1", version: 1, upstreamHealthSources: [] },
      { workflowId: "wf-1", version: 2, upstreamHealthSources: ["stripe-prod"] },
      // wf-2: tag was present on v1 but removed in v2 (latest) → NO match
      { workflowId: "wf-2", version: 1, upstreamHealthSources: ["stripe-prod"] },
      { workflowId: "wf-2", version: 2, upstreamHealthSources: [] },
      // wf-3: never tagged → no match
      { workflowId: "wf-3", version: 1, upstreamHealthSources: null },
    ];
    const matched = await listWorkflowIdsTaggedWithSource("org-a", "stripe-prod");
    expect(matched).toEqual(["wf-1"]);
  });

  it("matches a workflow tagged with the source among multiple tags", async () => {
    selectRows = [{ workflowId: "wf-9", version: 3, upstreamHealthSources: ["other", "stripe-prod", "github"] }];
    const matched = await listWorkflowIdsTaggedWithSource("org-a", "stripe-prod");
    expect(matched).toEqual(["wf-9"]);
  });
});

describe("pauseWorkflowsForUpstream", () => {
  it("returns the actually-flipped ids and scopes the update to org + status=active", async () => {
    returningRows = [{ id: "wf-1" }, { id: "wf-2" }];
    const flipped = await pauseWorkflowsForUpstream({ orgId: "org-a", workflowIds: ["wf-1", "wf-2", "wf-3"], reason: "degraded" });
    expect(flipped).toEqual(["wf-1", "wf-2"]);
    // The org + the id-list + the status guard are all in the predicate.
    expect(eqCalls).toContainEqual(["wf.org_id", "org-a"]);
    expect(eqCalls).toContainEqual(["wf.status", "active"]);
    expect(inArrayCalls).toContainEqual(["wf.id", ["wf-1", "wf-2", "wf-3"]]);
  });

  it("no-ops on an empty id list (no DB call)", async () => {
    const flipped = await pauseWorkflowsForUpstream({ orgId: "org-a", workflowIds: [], reason: "x" });
    expect(flipped).toEqual([]);
    expect(whereSpy).not.toHaveBeenCalled();
  });
});

describe("resumeWorkflowsForUpstream", () => {
  it("only flips rows currently paused-by-upstream", async () => {
    returningRows = [{ id: "wf-1" }];
    const flipped = await resumeWorkflowsForUpstream({ orgId: "org-a", workflowIds: ["wf-1", "wf-2"] });
    expect(flipped).toEqual(["wf-1"]);
    expect(eqCalls).toContainEqual(["wf.org_id", "org-a"]);
    expect(eqCalls).toContainEqual(["wf.status", "paused_upstream_degraded"]);
  });
});

describe("getWorkflowStatus", () => {
  it("scopes by org + workflow id", async () => {
    selectRows = [{ status: "active", pausedReason: null }];
    const status = await getWorkflowStatus("org-a", "wf-1");
    expect(status).toEqual({ status: "active", pausedReason: null });
    expect(eqCalls).toContainEqual(["wf.org_id", "org-a"]);
    expect(eqCalls).toContainEqual(["wf.id", "wf-1"]);
  });

  it("returns null when no row matches", async () => {
    selectRows = [];
    expect(await getWorkflowStatus("org-a", "missing")).toBeNull();
  });
});
