/**
 * Tests for `experimentsRepo` — the persistence behind the prompt/model
 * experiment harness.
 *
 * `@janusly/db` is mocked with an awaitable Drizzle-shaped query builder
 * (same pattern as `evalDatasetsRepo.test.ts`): `db.insert().values().returning()`
 * stages the returned row, `db.update().set().where().returning()` stages
 * the updated row, and `eq`/`and` capture their args so we can assert the
 * multi-tenant scope predicates.
 *
 * Coverage targets:
 * - `createExperiment` inserts with `status: "running"` + the supplied refs.
 * - `recordExperimentResult` CAS-scopes on `(orgId, id)` and writes the
 *   summary verbatim (the route already ran `safePersistPayload`).
 * - NO PRODUCTION MUTATION: the repo only ever touches the `experiments`
 *   table (no prompt / org-config writer exists on the surface).
 * - The closed-enum guards (`isExperimentKind`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const insertedRowsBox = { rows: [] as unknown[][] };
const insertReturnBox = { rows: [] as unknown[][] };
const updateSetBox = { rows: [] as unknown[] };
const updateReturnBox = { rows: [] as unknown[][] };
const selectRowsBox = { rows: [] as unknown[][] };
const eqCalls: Array<[unknown, unknown]> = [];

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  desc: vi.fn(() => ({})),
  eq: vi.fn((col: unknown, val: unknown) => {
    eqCalls.push([col, val]);
    return { __eq: [col, val] };
  }),
}));

vi.mock("@janusly/db", () => {
  const makeSelectChain = () => {
    let cached: Promise<unknown[]> | null = null;
    const settle = (): Promise<unknown[]> => {
      if (!cached) cached = Promise.resolve(selectRowsBox.rows.shift() ?? []);
      return cached;
    };
    const chain: Record<string, unknown> = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      then: (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject),
    };
    return chain;
  };
  const makeInsertChain = () => ({
    values: vi.fn((rows: unknown) => {
      insertedRowsBox.rows.push(Array.isArray(rows) ? rows : [rows]);
      return { returning: vi.fn(() => Promise.resolve(insertReturnBox.rows.shift() ?? [])) };
    }),
  });
  const makeUpdateChain = () => ({
    set: vi.fn((patch: unknown) => {
      updateSetBox.rows.push(patch);
      return {
        where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(updateReturnBox.rows.shift() ?? [])) })),
      };
    }),
  });
  const db = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain()),
    update: vi.fn(() => makeUpdateChain()),
  };
  return {
    db,
    experiments: {
      id: "experiments.id",
      orgId: "experiments.org_id",
      name: "experiments.name",
      kind: "experiments.kind",
      controlRef: "experiments.control_ref",
      candidateRef: "experiments.candidate_ref",
      evalDatasetId: "experiments.eval_dataset_id",
      scorerKind: "experiments.scorer_kind",
      status: "experiments.status",
      summaryJson: "experiments.summary_json",
      createdBy: "experiments.created_by",
      createdAt: "experiments.created_at",
      completedAt: "experiments.completed_at",
    },
  };
});

import {
  EXPERIMENT_KINDS,
  createExperiment,
  getExperiment,
  isExperimentKind,
  listExperiments,
  recordExperimentResult,
} from "./experimentsRepo";

const row = {
  id: "exp-1",
  orgId: "org-a",
  name: "haiku-vs-sonnet",
  kind: "model",
  controlRef: "claude-haiku-4-5",
  candidateRef: "anthropic/claude-sonnet-4-5",
  evalDatasetId: "ds-1",
  scorerKind: "string_equality",
  status: "running",
  summaryJson: null,
  createdBy: "user-1",
  createdAt: new Date("2026-05-29T00:00:00Z"),
  completedAt: null,
};

beforeEach(() => {
  insertedRowsBox.rows = [];
  insertReturnBox.rows = [];
  updateSetBox.rows = [];
  updateReturnBox.rows = [];
  selectRowsBox.rows = [];
  eqCalls.length = 0;
});

describe("createExperiment", () => {
  it("inserts with status running + the supplied refs", async () => {
    insertReturnBox.rows = [[row]];
    const result = await createExperiment({
      orgId: "org-a",
      name: "haiku-vs-sonnet",
      kind: "model",
      controlRef: "claude-haiku-4-5",
      candidateRef: "anthropic/claude-sonnet-4-5",
      evalDatasetId: "ds-1",
      scorerKind: "string_equality",
      createdBy: "user-1",
    });
    const inserted = insertedRowsBox.rows[0]![0] as Record<string, unknown>;
    expect(inserted.status).toBe("running");
    expect(inserted.orgId).toBe("org-a");
    expect(inserted.controlRef).toBe("claude-haiku-4-5");
    expect(inserted.candidateRef).toBe("anthropic/claude-sonnet-4-5");
    expect(result.id).toBe("exp-1");
    expect(result.kind).toBe("model");
  });
});

describe("recordExperimentResult", () => {
  it("CAS-scopes on (orgId, id) + writes the summary verbatim + completed_at", async () => {
    const summary = { recommendation: "promote_candidate", scoreDelta: 0.3 };
    updateReturnBox.rows = [[{ ...row, status: "completed", summaryJson: summary, completedAt: new Date() }]];

    const result = await recordExperimentResult("org-a", "exp-1", "completed", summary);

    // Multi-tenant CAS scope.
    expect(eqCalls).toContainEqual(["experiments.org_id", "org-a"]);
    expect(eqCalls).toContainEqual(["experiments.id", "exp-1"]);
    // Summary written verbatim (route already sanitized) + status + completedAt.
    const patch = updateSetBox.rows[0] as Record<string, unknown>;
    expect(patch.status).toBe("completed");
    expect(patch.summaryJson).toEqual(summary);
    expect(patch.completedAt).toBeInstanceOf(Date);
    expect(result?.status).toBe("completed");
  });

  it("returns null when the CAS matched no row (cross-org / missing)", async () => {
    updateReturnBox.rows = [[]];
    const result = await recordExperimentResult("org-b", "exp-1", "completed", {});
    expect(result).toBeNull();
  });
});

describe("reads", () => {
  it("listExperiments scopes to orgId", async () => {
    selectRowsBox.rows = [[row]];
    const result = await listExperiments("org-a");
    expect(eqCalls).toContainEqual(["experiments.org_id", "org-a"]);
    expect(result).toHaveLength(1);
  });

  it("getExperiment scopes to (orgId, id) and returns null when absent", async () => {
    selectRowsBox.rows = [[]];
    const result = await getExperiment("org-a", "exp-x");
    expect(eqCalls).toContainEqual(["experiments.org_id", "org-a"]);
    expect(eqCalls).toContainEqual(["experiments.id", "exp-x"]);
    expect(result).toBeNull();
  });
});

describe("closed-enum guards", () => {
  it("isExperimentKind narrows the closed set", () => {
    for (const k of EXPERIMENT_KINDS) expect(isExperimentKind(k)).toBe(true);
    expect(isExperimentKind("bogus")).toBe(false);
    expect(isExperimentKind(7)).toBe(false);
  });
});
