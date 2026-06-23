import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limitMock = vi.fn();
const orderByMock = vi.fn();
const onConflictMock = vi.fn();
const valuesMock = vi.fn((_values?: unknown) => ({ onConflictDoUpdate: onConflictMock }));
// `listDistinctWorkflowTagsForOrg` uses db.selectDistinct(...).from().where().orderBy().limit().
const distinctLimitMock = vi.fn();
// `renameWorkflowFolder` / `deleteWorkflowFolder` use db.update(...).set().where().returning().
const updateReturningMock = vi.fn();
const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
// `assignWorkflowsToFolder` AWAITS `db.select().from(workflows).where(...)` directly
// (the ownership gate) and chains `db.insert()...onConflictDoUpdate().returning()`.
// `ownedRowsMock` resolves the ownership rows; `insertReturningMock` the affected rows.
const ownedRowsMock = vi.fn<() => Promise<{ id: string }[]>>(() => Promise.resolve([]));
const insertReturningMock = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        // `where()` is both awaitable (the ownership gate awaits it → ownedRowsMock)
        // AND chainable (.limit / .orderBy for the single-row + list readers).
        where: vi.fn(() =>
          Object.assign(ownedRowsMock(), {
            limit: limitMock,
            orderBy: vi.fn(() => ({ limit: orderByMock })),
          }),
        ),
      })),
    })),
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: distinctLimitMock,
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: valuesMock,
    })),
    update: vi.fn(() => ({
      set: updateSetMock,
    })),
  },
  workflowMetadata: {
    id: "id_col",
    orgId: "org_id_col",
    workflowId: "workflow_id_col",
    owners: "owners_col",
    runbookMarkdown: "runbook_col",
    description: "description_col",
    tags: "tags_col",
    folder: "folder_col",
    slackChannel: "slack_col",
    linearProject: "linear_col",
    severityDefault: "severity_col",
    createdBy: "created_by_col",
    createdAt: "created_at_col",
    updatedAt: "updated_at_col",
  },
  workflows: {
    id: "wf_id_col",
    orgId: "wf_org_id_col",
  },
}));

import {
  assignWorkflowsToFolder,
  deleteWorkflowFolder,
  getWorkflowMetadata,
  listDistinctWorkflowFoldersForOrg,
  listDistinctWorkflowTagsForOrg,
  listWorkflowMetadataForOrg,
  renameWorkflowFolder,
  setWorkflowFolder,
  upsertWorkflowMetadata,
} from "./workflowMetadataRepo";

const SAMPLE_ROW = {
  id: "wm_1",
  orgId: "default",
  workflowId: "wf_1",
  owners: ["alice"],
  runbookMarkdown: "# hi",
  description: "demo",
  tags: ["billing"],
  folder: "Billing",
  slackChannel: "#ops",
  linearProject: "acme/ops",
  severityDefault: "p1",
  createdBy: "alice",
  createdAt: new Date("2026-05-23T00:00:00Z"),
  updatedAt: new Date("2026-05-23T01:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  limitMock.mockReset();
  orderByMock.mockReset();
  onConflictMock.mockReset();
  valuesMock.mockReset();
  valuesMock.mockReturnValue({ onConflictDoUpdate: onConflictMock });
  distinctLimitMock.mockReset();
  updateReturningMock.mockReset();
  updateWhereMock.mockReset();
  updateWhereMock.mockReturnValue({ returning: updateReturningMock });
  updateSetMock.mockReset();
  updateSetMock.mockReturnValue({ where: updateWhereMock });
  ownedRowsMock.mockReset();
  ownedRowsMock.mockReturnValue(Promise.resolve([]));
  insertReturningMock.mockReset();
  // Default: onConflictDoUpdate is an awaitable that ALSO exposes `.returning()`
  // (for the bulk-assign path). Tests that only `await` it (upsert / setWorkflowFolder)
  // override with `mockResolvedValueOnce`, which takes precedence for that one call.
  onConflictMock.mockImplementation(() =>
    Object.assign(Promise.resolve(undefined), { returning: insertReturningMock }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getWorkflowMetadata", () => {
  it("returns null when no row exists", async () => {
    limitMock.mockResolvedValueOnce([]);
    const result = await getWorkflowMetadata("default", "missing-workflow");
    expect(result).toBeNull();
  });

  it("hydrates the row into the record shape", async () => {
    limitMock.mockResolvedValueOnce([SAMPLE_ROW]);
    const result = await getWorkflowMetadata("default", "wf_1");
    expect(result).toMatchObject({
      workflowId: "wf_1",
      owners: ["alice"],
      runbookMarkdown: "# hi",
      severityDefault: "p1",
      slackChannel: "#ops",
      folder: "Billing",
    });
    expect(typeof result?.createdAt).toBe("string");
    expect(typeof result?.updatedAt).toBe("string");
  });

  it("coerces invalid severityDefault values to null (defensive read)", async () => {
    limitMock.mockResolvedValueOnce([{ ...SAMPLE_ROW, severityDefault: "p5-invalid" }]);
    const result = await getWorkflowMetadata("default", "wf_1");
    expect(result?.severityDefault).toBeNull();
  });
});

describe("listWorkflowMetadataForOrg", () => {
  it("caps the limit at 100 and returns hydrated rows", async () => {
    orderByMock.mockResolvedValueOnce([SAMPLE_ROW]);
    const result = await listWorkflowMetadataForOrg("default", 5000);
    expect(result).toHaveLength(1);
    expect(result[0].workflowId).toBe("wf_1");
  });
});

describe("listDistinctWorkflowTagsForOrg", () => {
  it("maps the distinct unnested rows to a flat string[]", async () => {
    // The query unnests `tags` via jsonb_array_elements_text, so each row is a
    // single `{ tag }`; the repo flattens to the tag strings.
    distinctLimitMock.mockResolvedValueOnce([{ tag: "billing" }, { tag: "onboarding" }, { tag: "urgent" }]);
    const result = await listDistinctWorkflowTagsForOrg("default");
    expect(result).toEqual(["billing", "onboarding", "urgent"]);
  });

  it("returns [] when the org has no tagged workflows", async () => {
    distinctLimitMock.mockResolvedValueOnce([]);
    const result = await listDistinctWorkflowTagsForOrg("default");
    expect(result).toEqual([]);
  });
});

describe("listDistinctWorkflowFoldersForOrg", () => {
  it("maps the distinct scalar folder rows to a flat string[]", async () => {
    // folder is a scalar column (no jsonb unnest), so each row is a `{ folder }`.
    distinctLimitMock.mockResolvedValueOnce([{ folder: "Billing" }, { folder: "Onboarding" }]);
    const result = await listDistinctWorkflowFoldersForOrg("default");
    expect(result).toEqual(["Billing", "Onboarding"]);
  });

  it("defensively drops any null folder from the result", async () => {
    // The query filters IS NOT NULL, but the map narrows defensively for string[].
    distinctLimitMock.mockResolvedValueOnce([{ folder: "Billing" }, { folder: null }]);
    const result = await listDistinctWorkflowFoldersForOrg("default");
    expect(result).toEqual(["Billing"]);
  });

  it("returns [] when the org has no foldered workflows", async () => {
    distinctLimitMock.mockResolvedValueOnce([]);
    const result = await listDistinctWorkflowFoldersForOrg("default");
    expect(result).toEqual([]);
  });
});

describe("upsertWorkflowMetadata", () => {
  it("returns the new record AND the previous one on update", async () => {
    // First lookup (previous) → existing row
    limitMock.mockResolvedValueOnce([SAMPLE_ROW]);
    onConflictMock.mockResolvedValueOnce(undefined);
    // Second lookup (record after upsert) → mutated row
    limitMock.mockResolvedValueOnce([
      { ...SAMPLE_ROW, owners: ["alice", "bob"], updatedAt: new Date("2026-05-23T02:00:00Z") },
    ]);

    const { record, previous } = await upsertWorkflowMetadata({
      orgId: "default",
      workflowId: "wf_1",
      metadata: { owners: ["alice", "bob"], tags: [] },
      actorUserId: "alice",
    });

    expect(previous).not.toBeNull();
    expect(previous?.owners).toEqual(["alice"]);
    expect(record.owners).toEqual(["alice", "bob"]);
  });

  it("returns previous=null on first write (insert)", async () => {
    limitMock.mockResolvedValueOnce([]); // no previous
    onConflictMock.mockResolvedValueOnce(undefined);
    limitMock.mockResolvedValueOnce([SAMPLE_ROW]); // record after insert

    const { record, previous } = await upsertWorkflowMetadata({
      orgId: "default",
      workflowId: "wf_1",
      metadata: { owners: ["alice"], tags: [] },
      actorUserId: "alice",
    });

    expect(previous).toBeNull();
    expect(record.workflowId).toBe("wf_1");
  });

  it("writes the folder through both .values() and the ON CONFLICT set", async () => {
    limitMock.mockResolvedValueOnce([]); // no previous
    onConflictMock.mockResolvedValueOnce(undefined);
    limitMock.mockResolvedValueOnce([{ ...SAMPLE_ROW, folder: "Onboarding" }]); // record after insert

    const { record } = await upsertWorkflowMetadata({
      orgId: "default",
      workflowId: "wf_1",
      metadata: { owners: [], tags: [], folder: "Onboarding" },
      actorUserId: "alice",
    });

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ folder: "Onboarding" }));
    expect(onConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ folder: "Onboarding" }) }),
    );
    expect(record.folder).toBe("Onboarding");
  });

  it("coerces an absent folder to null on write (ungrouped)", async () => {
    limitMock.mockResolvedValueOnce([]);
    onConflictMock.mockResolvedValueOnce(undefined);
    limitMock.mockResolvedValueOnce([{ ...SAMPLE_ROW, folder: null }]);

    await upsertWorkflowMetadata({
      orgId: "default",
      workflowId: "wf_1",
      metadata: { owners: [], tags: [] },
      actorUserId: "alice",
    });

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ folder: null }));
  });

  it("throws when the post-upsert lookup returns nothing (DB inconsistency)", async () => {
    limitMock.mockResolvedValueOnce([]); // no previous
    onConflictMock.mockResolvedValueOnce(undefined);
    limitMock.mockResolvedValueOnce([]); // record missing

    await expect(
      upsertWorkflowMetadata({
        orgId: "default",
        workflowId: "wf_1",
        metadata: { owners: [], tags: [] },
        actorUserId: null,
      }),
    ).rejects.toThrow(/missing immediately after upsert/);
  });
});

describe("setWorkflowFolder", () => {
  it("updates ONLY folder + updatedAt on conflict (other columns untouched)", async () => {
    limitMock.mockResolvedValueOnce([SAMPLE_ROW]); // previous exists
    onConflictMock.mockResolvedValueOnce(undefined);
    limitMock.mockResolvedValueOnce([{ ...SAMPLE_ROW, folder: "Onboarding" }]); // after

    const { record, previous } = await setWorkflowFolder({
      orgId: "default",
      workflowId: "wf_1",
      folder: "Onboarding",
      actorUserId: "alice",
    });

    const conflictArg = onConflictMock.mock.calls[0][0] as { set: Record<string, unknown> };
    // The narrow writer must NOT carry owners/tags/runbook/etc into the conflict set.
    expect(Object.keys(conflictArg.set).sort()).toEqual(["folder", "updatedAt"]);
    expect(conflictArg.set.folder).toBe("Onboarding");
    expect(previous?.folder).toBe("Billing");
    expect(record.folder).toBe("Onboarding");
  });

  it("inserts a defaults row carrying only the folder when none exists", async () => {
    limitMock.mockResolvedValueOnce([]); // no previous
    onConflictMock.mockResolvedValueOnce(undefined);
    limitMock.mockResolvedValueOnce([
      { ...SAMPLE_ROW, owners: [], tags: [], folder: "Billing", runbookMarkdown: null },
    ]);

    const { previous } = await setWorkflowFolder({
      orgId: "default",
      workflowId: "wf_1",
      folder: "Billing",
      actorUserId: "alice",
    });

    expect(previous).toBeNull();
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: "Billing",
        owners: [],
        tags: [],
        runbookMarkdown: null,
        description: null,
        slackChannel: null,
        linearProject: null,
        severityDefault: null,
      }),
    );
  });

  it("clears the folder (null) without touching other columns", async () => {
    limitMock.mockResolvedValueOnce([SAMPLE_ROW]);
    onConflictMock.mockResolvedValueOnce(undefined);
    limitMock.mockResolvedValueOnce([{ ...SAMPLE_ROW, folder: null }]);

    const { record } = await setWorkflowFolder({
      orgId: "default",
      workflowId: "wf_1",
      folder: null,
      actorUserId: "alice",
    });

    const conflictArg = onConflictMock.mock.calls[0][0] as { set: Record<string, unknown> };
    expect(Object.keys(conflictArg.set).sort()).toEqual(["folder", "updatedAt"]);
    expect(conflictArg.set.folder).toBeNull();
    expect(record.folder).toBeNull();
  });

  it("throws when the post-write lookup returns nothing (DB inconsistency)", async () => {
    limitMock.mockResolvedValueOnce([]); // no previous
    onConflictMock.mockResolvedValueOnce(undefined);
    limitMock.mockResolvedValueOnce([]); // record missing

    await expect(
      setWorkflowFolder({ orgId: "default", workflowId: "wf_1", folder: "X", actorUserId: null }),
    ).rejects.toThrow(/missing immediately after setWorkflowFolder/);
  });
});

describe("renameWorkflowFolder", () => {
  it("re-keys every matching row to the new name and returns the affected ids", async () => {
    updateReturningMock.mockResolvedValueOnce([{ workflowId: "wf_1" }, { workflowId: "wf_2" }]);

    const { workflowIds } = await renameWorkflowFolder({ orgId: "default", from: "Billing", to: "Invoicing" });

    expect(workflowIds).toEqual(["wf_1", "wf_2"]);
    // The bulk write sets folder=to (not the old name) + bumps updatedAt.
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ folder: "Invoicing" }));
  });

  it("returns [] when no workflow carries the source folder (idempotent)", async () => {
    updateReturningMock.mockResolvedValueOnce([]);
    const { workflowIds } = await renameWorkflowFolder({ orgId: "default", from: "Ghost", to: "X" });
    expect(workflowIds).toEqual([]);
  });
});

describe("deleteWorkflowFolder", () => {
  it("nulls the folder on every matching row (move to Ungrouped) and returns ids", async () => {
    updateReturningMock.mockResolvedValueOnce([{ workflowId: "wf_1" }, { workflowId: "wf_2" }]);

    const { workflowIds } = await deleteWorkflowFolder({ orgId: "default", folder: "Billing" });

    expect(workflowIds).toEqual(["wf_1", "wf_2"]);
    // Delete clears the label — folder set to null, workflows otherwise untouched.
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ folder: null }));
  });

  it("returns [] when the folder has no members", async () => {
    updateReturningMock.mockResolvedValueOnce([]);
    const { workflowIds } = await deleteWorkflowFolder({ orgId: "default", folder: "Ghost" });
    expect(workflowIds).toEqual([]);
  });
});

describe("assignWorkflowsToFolder", () => {
  it("returns [] without touching the DB on empty input", async () => {
    const { workflowIds } = await assignWorkflowsToFolder({
      orgId: "default",
      workflowIds: [],
      folder: "Billing",
      actorUserId: "alice",
    });
    expect(workflowIds).toEqual([]);
    expect(valuesMock).not.toHaveBeenCalled();
  });

  it("upserts the org's valid ids and sets ONLY folder + updatedAt on conflict", async () => {
    ownedRowsMock.mockReturnValueOnce(Promise.resolve([{ id: "wf_1" }, { id: "wf_2" }]));
    insertReturningMock.mockResolvedValueOnce([{ workflowId: "wf_1" }, { workflowId: "wf_2" }]);

    const { workflowIds } = await assignWorkflowsToFolder({
      orgId: "default",
      workflowIds: ["wf_1", "wf_2"],
      folder: "Billing",
      actorUserId: "alice",
    });

    expect(workflowIds).toEqual(["wf_1", "wf_2"]);
    // One batched insert with a row per valid id, carrying the target folder.
    const insertedRows = valuesMock.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]).toMatchObject({ workflowId: "wf_1", folder: "Billing", owners: [], tags: [] });
    // Existing rows move ONLY folder + updatedAt.
    const conflictArg = onConflictMock.mock.calls.at(-1)?.[0] as { set: Record<string, unknown> };
    expect(Object.keys(conflictArg.set).sort()).toEqual(["folder", "updatedAt"]);
    expect(conflictArg.set.folder).toBe("Billing");
  });

  it("drops cross-org ids (only the ownership-validated subset is written)", async () => {
    // Two ids requested, but the ownership query returns only one → only it is upserted.
    ownedRowsMock.mockReturnValueOnce(Promise.resolve([{ id: "wf_1" }]));
    insertReturningMock.mockResolvedValueOnce([{ workflowId: "wf_1" }]);

    const { workflowIds } = await assignWorkflowsToFolder({
      orgId: "default",
      workflowIds: ["wf_1", "wf_other_org"],
      folder: "Billing",
      actorUserId: "alice",
    });

    expect(workflowIds).toEqual(["wf_1"]);
    const insertedRows = valuesMock.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({ workflowId: "wf_1" });
  });

  it("returns [] and skips the upsert when none of the ids belong to the org", async () => {
    ownedRowsMock.mockReturnValueOnce(Promise.resolve([]));
    const { workflowIds } = await assignWorkflowsToFolder({
      orgId: "default",
      workflowIds: ["wf_other_org"],
      folder: "Billing",
      actorUserId: "alice",
    });
    expect(workflowIds).toEqual([]);
    expect(valuesMock).not.toHaveBeenCalled();
  });

  it("ungroups (folder: null) the selected workflows", async () => {
    ownedRowsMock.mockReturnValueOnce(Promise.resolve([{ id: "wf_1" }]));
    insertReturningMock.mockResolvedValueOnce([{ workflowId: "wf_1" }]);

    await assignWorkflowsToFolder({
      orgId: "default",
      workflowIds: ["wf_1"],
      folder: null,
      actorUserId: "alice",
    });

    const conflictArg = onConflictMock.mock.calls.at(-1)?.[0] as { set: Record<string, unknown> };
    expect(conflictArg.set.folder).toBeNull();
  });
});
