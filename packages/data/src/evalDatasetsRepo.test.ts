/**
 * Tests for `evalDatasetsRepo` — the surface that turns opted-in,
 * accepted recovery decisions into reusable eval datasets.
 *
 * `@janusly/db` is mocked with an awaitable Drizzle-shaped query builder:
 * each `db.select()` resolves the NEXT staged row set from
 * `selectRowsBox`; `db.insert().values()` captures the inserted rows;
 * `db.transaction(fn)` runs the handler against a tx with the same
 * chainable shape. `drizzle-orm`'s `eq`/`and` are stubbed to capture
 * their args so we can assert the opt-in gate + tenant scope predicates.
 *
 * Coverage targets (the ticket AC):
 * - Opt-in enforcement: the eligible-feedback query carries BOTH
 *   `eq(accepted, true)` AND `eq(evalConsent, true)` — a non-consented
 *   (or non-accepted) row is never pulled.
 * - Scrubbing at WRITE time: a secret shape in the captured comment /
 *   derived signature lands `[redacted]` in the inserted example.
 * - Cross-org isolation: every read/write carries
 *   `eq(<table>.orgId, orgId)`; a build for org A never references org B.
 * - Deletion cascade: `deleteEvalDataset` removes the examples AND the
 *   dataset row (children first).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRowsBox = { rows: [] as unknown[][] };
const insertedRowsBox = { rows: [] as unknown[][] };
const insertReturnBox = { rows: [] as unknown[][] };
const deleteCalls: unknown[] = [];
const eqCalls: Array<[unknown, unknown]> = [];

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  asc: vi.fn(() => ({})),
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
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      // oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are intentionally thenable.
      then: (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
        settle().then(resolve, reject),
    };
    return chain;
  };
  const makeInsertChain = () => {
    const chain: Record<string, unknown> = {
      values: vi.fn((rows: unknown) => {
        insertedRowsBox.rows.push(Array.isArray(rows) ? rows : [rows]);
        // `.returning()` resolves a staged return set; a bare insert resolves void.
        const ret = Object.assign(Promise.resolve(undefined), {
          returning: vi.fn(() => Promise.resolve(insertReturnBox.rows.shift() ?? [])),
        });
        return ret;
      }),
    };
    return chain;
  };
  const makeDeleteChain = () => ({
    where: vi.fn((cond: unknown) => {
      deleteCalls.push(cond);
      return Promise.resolve(undefined);
    }),
  });
  const db = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain()),
    delete: vi.fn(() => makeDeleteChain()),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: vi.fn(() => makeSelectChain()),
        insert: vi.fn(() => makeInsertChain()),
        delete: vi.fn(() => makeDeleteChain()),
      }),
    ),
  };
  return {
    db,
    recoveryFeedback: {
      id: "recovery_feedback.id",
      orgId: "recovery_feedback.org_id",
      accepted: "recovery_feedback.accepted",
      evalConsent: "recovery_feedback.eval_consent",
      workflowId: "recovery_feedback.workflow_id",
      deadLetterId: "recovery_feedback.dead_letter_id",
      approachLabel: "recovery_feedback.approach_label",
      suggestionMode: "recovery_feedback.suggestion_mode",
      comment: "recovery_feedback.comment",
      createdAt: "recovery_feedback.created_at",
    },
    deadLetters: {
      id: "dead_letters.id",
      orgId: "dead_letters.org_id",
      errorJson: "dead_letters.error_json",
      nodeJson: "dead_letters.node_json",
    },
    evalDatasets: {
      id: "eval_datasets.id",
      orgId: "eval_datasets.org_id",
      name: "eval_datasets.name",
      createdAt: "eval_datasets.created_at",
    },
    evalExamples: {
      id: "eval_examples.id",
      orgId: "eval_examples.org_id",
      datasetId: "eval_examples.dataset_id",
      createdAt: "eval_examples.created_at",
    },
  };
});

import {
  createEvalDataset,
  deleteEvalDataset,
  queryEligibleFeedbackForEval,
} from "./evalDatasetsRepo";

beforeEach(() => {
  selectRowsBox.rows = [];
  insertedRowsBox.rows = [];
  insertReturnBox.rows = [];
  deleteCalls.length = 0;
  eqCalls.length = 0;
});

describe("queryEligibleFeedbackForEval (opt-in gate)", () => {
  it("filters on accepted = true AND eval_consent = true AND orgId", async () => {
    selectRowsBox.rows = [[]]; // empty eligible set
    await queryEligibleFeedbackForEval("org-a", null);

    // Opt-in gate: both predicates present.
    expect(eqCalls).toContainEqual(["recovery_feedback.accepted", true]);
    expect(eqCalls).toContainEqual(["recovery_feedback.eval_consent", true]);
    // Tenant scope.
    expect(eqCalls).toContainEqual(["recovery_feedback.org_id", "org-a"]);
    // No workflow filter when workflowId is null.
    expect(eqCalls.find(([c]) => c === "recovery_feedback.workflow_id")).toBeUndefined();
  });

  it("adds the workflow filter when scoped", async () => {
    selectRowsBox.rows = [[]];
    await queryEligibleFeedbackForEval("org-a", "wf-1");
    expect(eqCalls).toContainEqual(["recovery_feedback.workflow_id", "wf-1"]);
  });

  it("scopes the LEFT JOIN to dead_letters within the same org", async () => {
    selectRowsBox.rows = [[]];
    await queryEligibleFeedbackForEval("org-a", null);
    // The join condition re-scopes dead_letters to the same org so a
    // corrupt dead_letter_id can't pull a foreign tenant's failure.
    expect(eqCalls).toContainEqual(["dead_letters.org_id", "org-a"]);
  });
});

describe("createEvalDataset", () => {
  it("returns exampleCount = 0 and writes only the dataset row when no eligible feedback exists", async () => {
    selectRowsBox.rows = [[]]; // queryEligibleFeedbackForEval → empty
    insertReturnBox.rows = [
      [
        {
          id: "ds-1",
          orgId: "org-a",
          name: "empty",
          description: "",
          workflowId: null,
          exampleCount: 0,
          retentionDays: null,
          createdBy: "u1",
          createdAt: new Date("2026-05-29T00:00:00Z"),
        },
      ],
    ];

    const result = await createEvalDataset({
      orgId: "org-a",
      name: "empty",
      createdBy: "u1",
    });

    expect(result.exampleCount).toBe(0);
    expect(result.dataset.id).toBe("ds-1");
    // Only the dataset row was inserted (no examples insert).
    expect(insertedRowsBox.rows).toHaveLength(1);
    expect((insertedRowsBox.rows[0]![0] as { name?: string }).name).toBe("empty");
  });

  it("distills eligible feedback into examples and scrubs secrets at WRITE time", async () => {
    selectRowsBox.rows = [
      [
        {
          feedbackId: "fb-1",
          workflowId: "wf-1",
          deadLetterId: "dl-1",
          approachLabel: "swap_secret_ref",
          suggestionMode: "ai",
          comment: "rotated Bearer sk-ABCDEF1234567890ABCDEF1234567890 yesterday",
          errorJson: { message: "401 Unauthorized" },
          nodeJson: { type: "http" },
        },
      ],
    ];
    insertReturnBox.rows = [
      [
        {
          id: "ds-2",
          orgId: "org-a",
          name: "ds",
          description: "",
          workflowId: null,
          exampleCount: 1,
          retentionDays: null,
          createdBy: "u1",
          createdAt: new Date(),
        },
      ],
    ];

    const result = await createEvalDataset({ orgId: "org-a", name: "ds", createdBy: "u1" });
    expect(result.exampleCount).toBe(1);

    // Two inserts: dataset row, then the examples batch.
    expect(insertedRowsBox.rows).toHaveLength(2);
    const exampleRows = insertedRowsBox.rows[1] as Array<{
      orgId: string;
      inputContext: string;
      expectedApproachLabel: string;
      accepted: boolean;
      sourceFeedbackId: string;
    }>;
    expect(exampleRows).toHaveLength(1);
    const ex = exampleRows[0]!;
    // Tenant scope on the written example.
    expect(ex.orgId).toBe("org-a");
    expect(ex.sourceFeedbackId).toBe("fb-1");
    expect(ex.expectedApproachLabel).toBe("swap_secret_ref");
    expect(ex.accepted).toBe(true);
    // Secret scrubbed at write time.
    expect(ex.inputContext).not.toContain("sk-ABCDEF");
    expect(ex.inputContext).toContain("[redacted]");
  });

  it("only references the requesting org (cross-org isolation)", async () => {
    selectRowsBox.rows = [
      [
        {
          feedbackId: "fb-1",
          workflowId: "wf-1",
          deadLetterId: "dl-1",
          approachLabel: "add_retry",
          suggestionMode: "ai",
          comment: null,
          errorJson: {},
          nodeJson: { type: "http" },
        },
      ],
    ];
    insertReturnBox.rows = [
      [{ id: "ds-3", orgId: "org-a", name: "ds", description: "", workflowId: null, exampleCount: 1, retentionDays: null, createdBy: null, createdAt: new Date() }],
    ];

    await createEvalDataset({ orgId: "org-a", name: "ds", createdBy: null });

    const datasetRow = insertedRowsBox.rows[0]![0] as { orgId: string };
    const exampleRow = (insertedRowsBox.rows[1] as Array<{ orgId: string }>)[0]!;
    expect(datasetRow.orgId).toBe("org-a");
    expect(exampleRow.orgId).toBe("org-a");
    // The eligible-feedback read was org-scoped to org-a.
    expect(eqCalls).toContainEqual(["recovery_feedback.org_id", "org-a"]);
  });
});

describe("deleteEvalDataset (cascade)", () => {
  it("deletes examples AND the dataset row when the dataset exists, org-scoped", async () => {
    // First tx select: dataset exists.
    selectRowsBox.rows = [[{ id: "ds-1" }]];
    const ok = await deleteEvalDataset("org-a", "ds-1");
    expect(ok).toBe(true);
    // Two deletes ran (examples first, then dataset).
    expect(deleteCalls).toHaveLength(2);
    // Both reads/writes carried the org filter.
    expect(eqCalls).toContainEqual(["eval_datasets.org_id", "org-a"]);
    expect(eqCalls).toContainEqual(["eval_examples.org_id", "org-a"]);
  });

  it("returns false and deletes nothing when the dataset is missing / cross-org", async () => {
    selectRowsBox.rows = [[]]; // no dataset for this org
    const ok = await deleteEvalDataset("org-a", "ds-nope");
    expect(ok).toBe(false);
    expect(deleteCalls).toHaveLength(0);
  });
});
