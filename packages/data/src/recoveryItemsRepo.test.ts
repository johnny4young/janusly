/**
 * Pure-unit tests for the debounce helpers in the recovery-items repo.
 *
 * `@janusly/db` is mocked so no DB is hit — these cover branch logic and the
 * idempotent-attach contract (a duplicate occurrence must NOT bump the
 * parent counter). SQL-filter correctness (window boundary, multi-workflow
 * signature collision, tenant scope) is exercised against real Postgres in
 * the live smoke, since those are predicate behaviors a mocked builder can't
 * prove.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insertValuesMock = vi.fn();
const updateSetMock = vi.fn();
const selectFromMock = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValuesMock })),
    update: vi.fn(() => ({ set: updateSetMock })),
    select: vi.fn(() => ({ from: selectFromMock })),
  },
  recoveryItems: {
    id: "id_col",
    orgId: "org_id_col",
    deadLetterId: "dead_letter_id_col",
    workflowId: "workflow_id_col",
    errorSignature: "error_signature_col",
    status: "status_col",
    lastOccurredAt: "last_occurred_at_col",
    occurrenceCount: "occurrence_count_col",
    updatedAt: "updated_at_col",
  } as Record<string, string>,
  recoveryItemChildren: {
    id: "child_id_col",
    orgId: "child_org_id_col",
    recoveryItemId: "child_recovery_item_id_col",
    deadLetterId: "child_dead_letter_id_col",
    occurredAt: "child_occurred_at_col",
  } as Record<string, string>,
}));

import { db } from "@janusly/db";
import {
  findOpenRecoveryItemForDebounce,
  attachDeadLetterToRecoveryItem,
  listRecoveryItemChildren,
  countRecoveryItemChildren,
} from "./recoveryItemsRepo";

const dbSelectMock = vi.mocked(db.select);
const dbInsertMock = vi.mocked(db.insert);
const dbUpdateMock = vi.mocked(db.update);

beforeEach(() => {
  insertValuesMock.mockReset();
  updateSetMock.mockReset();
  selectFromMock.mockReset();
  dbSelectMock.mockClear();
  dbInsertMock.mockClear();
  dbUpdateMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** A full recovery_items row so `hydrate` maps cleanly. */
function fakeItemRow(over: Record<string, unknown> = {}) {
  const now = new Date("2026-05-28T12:00:00Z");
  return {
    id: "ri_1",
    orgId: "org-1",
    deadLetterId: "dl_parent",
    workflowId: "wf_1",
    owner: null,
    severity: "p3",
    status: "open",
    slaTargetAt: now,
    resolutionReason: null,
    resolvedBy: null,
    resolvedAt: null,
    comments: [],
    errorSignature: "HTTP 500 on http node",
    occurrenceCount: 1,
    firstOccurredAt: now,
    lastOccurredAt: now,
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** Wire a `select().from().where().orderBy().limit()` chain that resolves to `rows`. */
function mockSelectChainWithLimit(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  selectFromMock.mockReturnValue({ where });
  return { where, orderBy, limit };
}

describe("findOpenRecoveryItemForDebounce", () => {
  it("short-circuits to null WITHOUT a DB read when errorSignature is null", async () => {
    const result = await findOpenRecoveryItemForDebounce({
      orgId: "org-1",
      workflowId: "wf_1",
      errorSignature: null,
      notBefore: new Date(),
    });
    expect(result).toBeNull();
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it("returns the hydrated parent when a recent open item matches", async () => {
    const chain = mockSelectChainWithLimit([fakeItemRow()]);
    const result = await findOpenRecoveryItemForDebounce({
      orgId: "org-1",
      workflowId: "wf_1",
      errorSignature: "HTTP 500 on http node",
      notBefore: new Date("2026-05-28T11:55:00Z"),
    });
    expect(result?.id).toBe("ri_1");
    expect(result?.occurrenceCount).toBe(1);
    // Freshest storm wins, and we only need the single best match.
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when no open item is within the window", async () => {
    mockSelectChainWithLimit([]);
    const result = await findOpenRecoveryItemForDebounce({
      orgId: "org-1",
      workflowId: "wf_1",
      errorSignature: "HTTP 500 on http node",
      notBefore: new Date(),
    });
    expect(result).toBeNull();
  });
});

describe("attachDeadLetterToRecoveryItem", () => {
  function mockChildInsert(returningRows: unknown[]) {
    const returning = vi.fn().mockResolvedValue(returningRows);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    insertValuesMock.mockReturnValue({ onConflictDoNothing });
    return { onConflictDoNothing, returning };
  }

  function mockParentBump(occurrenceCount: number) {
    const returning = vi.fn().mockResolvedValue([{ occurrenceCount }]);
    const where = vi.fn(() => ({ returning }));
    updateSetMock.mockReturnValue({ where });
    return { where, returning };
  }

  it("bumps the parent and returns the new count when a child row is inserted", async () => {
    mockChildInsert([{ id: "child_1" }]);
    mockParentBump(2);
    const result = await attachDeadLetterToRecoveryItem({
      orgId: "org-1",
      recoveryItemId: "ri_1",
      deadLetterId: "dl_new",
    });
    expect(result).toEqual({ occurrenceCount: 2 });
    expect(dbUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a duplicate occurrence returns null and does NOT bump the counter", async () => {
    mockChildInsert([]); // ON CONFLICT DO NOTHING returned no row
    const result = await attachDeadLetterToRecoveryItem({
      orgId: "org-1",
      recoveryItemId: "ri_1",
      deadLetterId: "dl_dup",
    });
    expect(result).toBeNull();
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it("returns null when the parent vanished between insert and bump", async () => {
    mockChildInsert([{ id: "child_2" }]);
    const returning = vi.fn().mockResolvedValue([]); // parent gone
    const where = vi.fn(() => ({ returning }));
    updateSetMock.mockReturnValue({ where });
    const result = await attachDeadLetterToRecoveryItem({
      orgId: "org-1",
      recoveryItemId: "ri_missing",
      deadLetterId: "dl_x",
    });
    expect(result).toBeNull();
  });
});

describe("listRecoveryItemChildren / countRecoveryItemChildren", () => {
  it("maps child rows newest-first and caps the limit", async () => {
    const chain = mockSelectChainWithLimit([
      { id: "c1", recoveryItemId: "ri_1", deadLetterId: "dl_a", occurredAt: new Date("2026-05-28T12:01:00Z") },
      { id: "c2", recoveryItemId: "ri_1", deadLetterId: "dl_b", occurredAt: new Date("2026-05-28T12:00:00Z") },
    ]);
    const children = await listRecoveryItemChildren("org-1", "ri_1", 9_999);
    expect(children).toHaveLength(2);
    expect(children[0]).toEqual({
      id: "c1",
      recoveryItemId: "ri_1",
      deadLetterId: "dl_a",
      occurredAt: new Date("2026-05-28T12:01:00Z"),
    });
    // An over-large requested limit is clamped to the 200 max.
    expect(chain.limit).toHaveBeenCalledWith(200);
  });

  it("counts attached occurrences", async () => {
    const where = vi.fn().mockResolvedValue([{ value: 7 }]);
    selectFromMock.mockReturnValue({ where });
    const total = await countRecoveryItemChildren("org-1", "ri_1");
    expect(total).toBe(7);
  });
});
