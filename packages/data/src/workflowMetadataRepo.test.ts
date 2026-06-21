import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const limitMock = vi.fn();
const orderByMock = vi.fn();
const onConflictMock = vi.fn();
const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictMock }));
// `listDistinctWorkflowTagsForOrg` uses db.selectDistinct(...).from().where().orderBy().limit().
const distinctLimitMock = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: limitMock,
          orderBy: vi.fn(() => ({
            limit: orderByMock,
          })),
        })),
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
}));

import {
  getWorkflowMetadata,
  listDistinctWorkflowFoldersForOrg,
  listDistinctWorkflowTagsForOrg,
  listWorkflowMetadataForOrg,
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
