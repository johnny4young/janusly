/**
 * Unit tests for `confidenceCalibrationRepo`'s branch + shaping logic.
 *
 * `@janusly/db` is mocked so no DB is hit — these prove the JS-side
 * behavior: the sample mapper drops null `raw_confidence` rows, the
 * org-discovery read subtracts the opted-out set (the opt-out gate), and
 * `listCalibrations` returns whatever the scoped query yields (empty →
 * the read side falls back to raw). SQL predicate correctness (the
 * org-scoped WHERE, the `IS NOT NULL` filter, the `'false'::jsonb` match)
 * is exercised against real Postgres in the live smoke, since a mocked
 * builder can't prove a WHERE clause.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each query returns a deterministic stub; the test sets the resolved
// rows per call. `select` and `selectDistinct` each terminate at a
// `where` (some) or at the chained builder (others) — we shape the mock
// so the awaited result is whatever the test queues.
const sampleRowsMock = vi.fn();
const distinctApproachRowsMock = vi.fn();
const calibrationsRowsMock = vi.fn();
const feedbackOrgsRowsMock = vi.fn();
const optedOutRowsMock = vi.fn();
const insertOnConflictMock = vi.fn();

// `db.select(...)` is used by both `listCalibrationSamples` (terminates
// at `.where(...)` returning a thenable) and `listCalibrations`
// (terminates at `.where(...)`), and the opted-out read in
// `listOrgIdsWithCalibrationEnabled`. We route by call order via a queue.
const selectWhereQueue: Array<() => Promise<unknown>> = [];
const selectDistinctWhereQueue: Array<() => Promise<unknown>> = [];

// A `.where(...)` result that is BOTH awaitable (terminates a
// `select().from().where()` read) AND chainable via `.limit(...)` (the
// sample read appends a LIMIT). Both surfaces resolve the SAME queued
// promise so a test queues exactly one row-set per query.
function whereHandle(queue: Array<() => Promise<unknown>>) {
  const next = queue.shift();
  const resolved = next ? next() : Promise.resolve([]);
  return {
    limit: () => resolved,
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      resolved.then(onFulfilled, onRejected),
  };
}

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => whereHandle(selectWhereQueue)),
      })),
    })),
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => whereHandle(selectDistinctWhereQueue)),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ onConflictDoUpdate: insertOnConflictMock })),
    })),
  },
  confidenceCalibrations: {
    id: "id_col",
    orgId: "org_id_col",
    approachLabel: "approach_label_col",
    acceptRate: "accept_rate_col",
    sampleSize: "sample_size_col",
    curveSlope: "curve_slope_col",
    curveIntercept: "curve_intercept_col",
    lastComputedAt: "last_computed_at_col",
  } as Record<string, string>,
  recoveryFeedback: {
    orgId: "org_id_col",
    approachLabel: "approach_label_col",
    accepted: "accepted_col",
    rawConfidence: "raw_confidence_col",
    createdAt: "created_at_col",
  } as Record<string, string>,
  orgConfigs: {
    orgId: "org_id_col",
    key: "key_col",
    valueJson: "value_json_col",
  } as Record<string, string>,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
  gte: (col: unknown, val: unknown) => ({ gte: [col, val] }),
  isNotNull: (col: unknown) => ({ isNotNull: col }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: [strings, vals] }),
}));

import {
  listCalibrations,
  listCalibrationSamples,
  listOrgIdsWithCalibrationEnabled,
  upsertCalibration,
} from "./confidenceCalibrationRepo";

beforeEach(() => {
  selectWhereQueue.length = 0;
  selectDistinctWhereQueue.length = 0;
  sampleRowsMock.mockReset();
  distinctApproachRowsMock.mockReset();
  calibrationsRowsMock.mockReset();
  feedbackOrgsRowsMock.mockReset();
  optedOutRowsMock.mockReset();
  insertOnConflictMock.mockReset();
  insertOnConflictMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listCalibrationSamples — shaping + null filtering", () => {
  it("maps rows and drops those with a null raw_confidence", async () => {
    selectWhereQueue.push(() => Promise.resolve([
      { rawConfidence: 80, accepted: true },
      { rawConfidence: null, accepted: false }, // dropped — no x-coordinate
      { rawConfidence: 20, accepted: false },
    ]));

    const samples = await listCalibrationSamples("org-1", "add_retry");
    expect(samples).toEqual([
      { rawConfidence: 80, accepted: true },
      { rawConfidence: 20, accepted: false },
    ]);
  });

  it("returns an empty array when there is no feedback (no rows)", async () => {
    selectWhereQueue.push(() => Promise.resolve([]));
    const samples = await listCalibrationSamples("org-1", "fix_url");
    expect(samples).toEqual([]);
  });
});

describe("listCalibrations — read side", () => {
  it("returns the scoped rows verbatim", async () => {
    const row = {
      approachLabel: "raise_timeout",
      acceptRate: 0.6,
      sampleSize: 42,
      curveSlope: 0.7,
      curveIntercept: 5,
      lastComputedAt: new Date("2026-05-29T00:00:00.000Z"),
    };
    selectWhereQueue.push(() => Promise.resolve([row]));
    const rows = await listCalibrations("org-1");
    expect(rows).toEqual([row]);
  });

  it("returns empty when the org has never been calibrated (raw fallback upstream)", async () => {
    selectWhereQueue.push(() => Promise.resolve([]));
    const rows = await listCalibrations("org-empty");
    expect(rows).toEqual([]);
  });
});

describe("listOrgIdsWithCalibrationEnabled — opt-out subtraction", () => {
  it("returns feedback orgs MINUS those explicitly opted out", async () => {
    // First query (selectDistinct on recovery_feedback) → orgs with feedback.
    selectDistinctWhereQueue.push(() => Promise.resolve([
      { orgId: "org-a" },
      { orgId: "org-b" },
      { orgId: "org-c" },
    ]));
    // Second query (select on org_configs) → orgs that set the flag false.
    selectWhereQueue.push(() => Promise.resolve([
      { orgId: "org-b" },
    ]));

    const orgs = await listOrgIdsWithCalibrationEnabled();
    expect(orgs.sort()).toEqual(["org-a", "org-c"]);
  });

  it("returns all feedback orgs when none opted out (default-on)", async () => {
    selectDistinctWhereQueue.push(() => Promise.resolve([
      { orgId: "org-a" },
      { orgId: "org-b" },
    ]));
    selectWhereQueue.push(() => Promise.resolve([]));

    const orgs = await listOrgIdsWithCalibrationEnabled();
    expect(orgs.sort()).toEqual(["org-a", "org-b"]);
  });

  it("returns empty when no org has calibratable feedback", async () => {
    selectDistinctWhereQueue.push(() => Promise.resolve([]));
    selectWhereQueue.push(() => Promise.resolve([]));
    const orgs = await listOrgIdsWithCalibrationEnabled();
    expect(orgs).toEqual([]);
  });
});

describe("upsertCalibration — write path", () => {
  it("inserts with ON CONFLICT keyed by (orgId, approachLabel)", async () => {
    await upsertCalibration({
      orgId: "org-1",
      approachLabel: "add_retry",
      acceptRate: 0.55,
      sampleSize: 30,
      curveSlope: 0.8,
      curveIntercept: 4,
    });
    expect(insertOnConflictMock).toHaveBeenCalledTimes(1);
    const conflictArg = insertOnConflictMock.mock.calls[0]![0] as { set: Record<string, unknown> };
    expect(conflictArg.set).toMatchObject({
      acceptRate: 0.55,
      sampleSize: 30,
      curveSlope: 0.8,
      curveIntercept: 4,
    });
  });
});
