/**
 * Pure-unit tests for the snippets repo's tenant-scoping contract.
 *
 * `@janusly/db` + `drizzle-orm` are mocked so no DB is hit — these prove the
 * branch logic AND that every read/write carries an `eq(snippets.orgId, …)`
 * predicate so a custom snippet can't leak across orgs. Real SQL execution
 * (the unique `(orgId, name)` index, ON CONFLICT) is exercised in the live
 * smoke; a mocked builder can't prove an index.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectWhereMock = vi.fn();
const insertValuesMock = vi.fn();
const updateWhereMock = vi.fn();
const deleteWhereMock = vi.fn();

// `select().from().where().limit()` (getById/findByName) and
// `select().from().where().orderBy().limit()` (list). `selectWhereMock` is the
// single capture+return seam: tests set its return value to the row array, and
// both terminal `.limit()` calls resolve to it.
function selectChain() {
  return {
    from: vi.fn(() => ({
      where: vi.fn((cond: unknown) => {
        const rows = selectWhereMock(cond) ?? [];
        return {
          limit: vi.fn(() => Promise.resolve(rows)),
          orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve(rows)) })),
        };
      }),
    })),
  };
}

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => selectChain()),
    insert: vi.fn(() => ({ values: insertValuesMock })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhereMock })) })),
    delete: vi.fn(() => ({ where: deleteWhereMock })),
  },
  snippets: {
    id: "id_col",
    orgId: "org_id_col",
    name: "name_col",
    updatedAt: "updated_at_col",
  } as Record<string, string>,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
  desc: (col: unknown) => ({ desc: col }),
  sql: (...args: unknown[]) => ({ sql: args }),
}));

import {
  createSnippet,
  deleteSnippet,
  getSnippetById,
  listSnippets,
  updateSnippet,
} from "./snippetsRepo";

beforeEach(() => {
  selectWhereMock.mockReset();
  insertValuesMock.mockReset();
  updateWhereMock.mockReset();
  deleteWhereMock.mockReset();
  insertValuesMock.mockResolvedValue(undefined);
  updateWhereMock.mockResolvedValue(undefined);
  deleteWhereMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Flatten a captured `and(...)` / `eq(...)` predicate into the eq tuples it contains. */
function eqTuples(predicate: unknown): Array<[unknown, unknown]> {
  const out: Array<[unknown, unknown]> = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (Array.isArray(rec.eq)) out.push(rec.eq as [unknown, unknown]);
    if (Array.isArray(rec.and)) for (const child of rec.and) visit(child);
  };
  visit(predicate);
  return out;
}

describe("listSnippets — tenant scope", () => {
  it("filters by orgId", async () => {
    await listSnippets("org-1");
    const tuples = eqTuples(selectWhereMock.mock.calls.at(-1)?.[0]);
    expect(tuples).toContainEqual(["org_id_col", "org-1"]);
  });
});

describe("getSnippetById — tenant scope", () => {
  it("filters by BOTH orgId and id", async () => {
    selectWhereMock.mockReturnValueOnce([]);
    await getSnippetById("org-2", "snip-9");
    const tuples = eqTuples(selectWhereMock.mock.calls.at(-1)?.[0]);
    expect(tuples).toContainEqual(["org_id_col", "org-2"]);
    expect(tuples).toContainEqual(["id_col", "snip-9"]);
  });
});

describe("createSnippet — tenant binding", () => {
  it("inserts with the caller orgId and builtin: false", async () => {
    // After the insert the repo re-reads via getSnippetById → return a row.
    selectWhereMock.mockReturnValue([
      {
        id: "x",
        orgId: "org-1",
        name: "x",
        description: "",
        category: "retry",
        tags: [],
        nodesJson: [{ id: "n1", type: "http", config: {} }],
        edgesJson: [],
        entryNodeId: null,
      },
    ]);
    await createSnippet("org-1", {
      name: "x",
      description: "",
      category: "retry",
      tags: [],
      nodes: [{ id: "n1", type: "http", config: {} }],
      edges: [],
      createdBy: "user-1",
    });
    const values = insertValuesMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(values.orgId).toBe("org-1");
    expect(values.builtin).toBe(false);
    expect(values.createdBy).toBe("user-1");
  });
});

describe("updateSnippet — tenant scope", () => {
  it("returns null without an UPDATE when the row isn't in the org", async () => {
    // getSnippetById (before) returns empty → null.
    selectWhereMock.mockReturnValue([]);
    const result = await updateSnippet("org-1", "ghost", { name: "y" });
    expect(result).toBeNull();
    expect(updateWhereMock).not.toHaveBeenCalled();
  });

  it("scopes the UPDATE predicate by orgId + id when the row exists", async () => {
    const row = {
      id: "snip-1",
      orgId: "org-1",
      name: "before",
      description: "",
      category: "retry",
      tags: [],
      nodesJson: [{ id: "n1", type: "http", config: {} }],
      edgesJson: [],
      entryNodeId: null,
    };
    selectWhereMock.mockReturnValue([row]);
    await updateSnippet("org-1", "snip-1", { name: "after" });
    const tuples = eqTuples(updateWhereMock.mock.calls.at(-1)?.[0]);
    expect(tuples).toContainEqual(["org_id_col", "org-1"]);
    expect(tuples).toContainEqual(["id_col", "snip-1"]);
  });
});

describe("deleteSnippet — tenant scope", () => {
  it("returns null without a DELETE when the row isn't in the org", async () => {
    selectWhereMock.mockReturnValue([]);
    const result = await deleteSnippet("org-9", "snip-1");
    expect(result).toBeNull();
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });

  it("scopes the DELETE predicate by orgId + id", async () => {
    selectWhereMock.mockReturnValue([
      { id: "snip-1", orgId: "org-1", name: "x", description: "", category: "retry", tags: [], nodesJson: [], edgesJson: [], entryNodeId: null },
    ]);
    await deleteSnippet("org-1", "snip-1");
    const tuples = eqTuples(deleteWhereMock.mock.calls.at(-1)?.[0]);
    expect(tuples).toContainEqual(["org_id_col", "org-1"]);
    expect(tuples).toContainEqual(["id_col", "snip-1"]);
  });
});
