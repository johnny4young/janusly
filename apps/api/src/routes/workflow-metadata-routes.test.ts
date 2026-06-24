/**
 * Route-level tests for /workflows/:id/metadata.
 *
 * Confirms:
 *  - Route entry declares the right gate (viewer + workflows.read for GET,
 *    editor + workflows.write for POST).
 *  - 404 when the workflow doesn't belong to the caller's org.
 *  - 422 on Zod body failure (oversized runbook, malformed slack channel).
 *  - Audit row fires on POST with `{ before, after, workflowId }`.
 *  - GET returns `{ metadata: null }` when no row exists (no 404).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
    readJson: vi.fn(),
  };
});

vi.mock("@janusly/data/src/workflowMetadataRepo", () => ({
  getWorkflowMetadata: vi.fn(),
  upsertWorkflowMetadata: vi.fn(),
  setWorkflowFolder: vi.fn(),
  renameWorkflowFolder: vi.fn(),
  deleteWorkflowFolder: vi.fn(),
  assignWorkflowsToFolder: vi.fn(),
  assignTagToWorkflows: vi.fn(),
  listWorkflowMetadataForOrg: vi.fn(),
}));

const limitMock = vi.fn();
vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: limitMock })),
      })),
    })),
  },
  workflows: { id: "id", orgId: "org_id" },
}));

vi.mock("../audit", () => ({
  audit: vi.fn(),
}));

import { workflowMetadataRoutes } from "./workflow-metadata-routes";
import { readJson, sendJson } from "../http";
import {
  assignTagToWorkflows,
  assignWorkflowsToFolder,
  deleteWorkflowFolder,
  getWorkflowMetadata,
  renameWorkflowFolder,
  setWorkflowFolder,
  upsertWorkflowMetadata,
} from "@janusly/data/src/workflowMetadataRepo";
import { audit } from "../audit";
import type { Route } from "../routes";

const sendJsonMock = vi.mocked(sendJson);
const readJsonMock = vi.mocked(readJson);
const getMetadataMock = vi.mocked(getWorkflowMetadata);
const upsertMock = vi.mocked(upsertWorkflowMetadata);
const setFolderMock = vi.mocked(setWorkflowFolder);
const renameFolderMock = vi.mocked(renameWorkflowFolder);
const deleteFolderMock = vi.mocked(deleteWorkflowFolder);
const assignFolderMock = vi.mocked(assignWorkflowsToFolder);
const assignTagMock = vi.mocked(assignTagToWorkflows);
const auditMock = vi.mocked(audit);

function findRoute(method: string, path: string): Route {
  const route = workflowMetadataRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

const auth = {
  orgId: "org-1",
  userId: "user-1",
  mode: "dev-headers",
  source: "dev",
} as never;

async function callRoute(method: string, path: string) {
  const route = findRoute(method, path);
  return route.handler({ req: { url: path } as never, res: {} as never, auth });
}

afterEach(() => {
  vi.clearAllMocks();
  limitMock.mockReset();
  // Reset the readJson mock queue so a test that never reaches the body
  // parse (e.g., the 404 path) doesn't leak its queued resolve into the
  // next test's readJson call.
  readJsonMock.mockReset();
});

describe("GET /workflows/:id/metadata", () => {
  it("declares role: viewer + permission: workflows.read", () => {
    const route = findRoute("GET", "/workflows/wf-1/metadata");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("workflows.read");
  });

  it("returns 404 when the workflow doesn't belong to the caller's org", async () => {
    limitMock.mockResolvedValueOnce([]);
    await callRoute("GET", "/workflows/wf-1/metadata");
    const lastCall = sendJsonMock.mock.calls.at(-1);
    expect(lastCall?.[2]).toBe(404);
  });

  it("returns metadata: null when no row exists (not a 404)", async () => {
    limitMock.mockResolvedValueOnce([{ id: "wf-1" }]);
    getMetadataMock.mockResolvedValueOnce(null);
    await callRoute("GET", "/workflows/wf-1/metadata");
    const lastCall = sendJsonMock.mock.calls.at(-1);
    expect(lastCall?.[2] ?? 200).toBe(200);
    expect(lastCall?.[1]).toMatchObject({ workflowId: "wf-1", metadata: null });
  });

  it("returns the hydrated metadata record when one exists", async () => {
    limitMock.mockResolvedValueOnce([{ id: "wf-1" }]);
    getMetadataMock.mockResolvedValueOnce({
      workflowId: "wf-1",
      owners: ["alice"],
      runbookMarkdown: "# hi",
      description: null,
      tags: [],
      slackChannel: "#ops",
      linearProject: null,
      severityDefault: "p1",
      createdBy: "alice",
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    });
    await callRoute("GET", "/workflows/wf-1/metadata");
    const lastCall = sendJsonMock.mock.calls.at(-1);
    expect(lastCall?.[1]).toMatchObject({
      workflowId: "wf-1",
      metadata: expect.objectContaining({ owners: ["alice"], severityDefault: "p1" }),
    });
  });
});

describe("POST /workflows/:id/metadata", () => {
  it("declares role: editor + permission: workflows.write", () => {
    const route = findRoute("POST", "/workflows/wf-1/metadata");
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("workflows.write");
  });

  it("returns 404 when the workflow doesn't belong to the caller's org", async () => {
    limitMock.mockResolvedValueOnce([]);
    readJsonMock.mockResolvedValueOnce({ metadata: { owners: [] } });
    await callRoute("POST", "/workflows/wf-1/metadata");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(404);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("returns 422 on Zod validation failure (malformed slack channel)", async () => {
    limitMock.mockResolvedValueOnce([{ id: "wf-1" }]);
    readJsonMock.mockResolvedValueOnce({ metadata: { slackChannel: "no-prefix" } });
    await callRoute("POST", "/workflows/wf-1/metadata");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(422);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("returns 422 on Zod validation failure (oversized runbook)", async () => {
    limitMock.mockResolvedValueOnce([{ id: "wf-1" }]);
    readJsonMock.mockResolvedValueOnce({
      metadata: { runbookMarkdown: "x".repeat(33 * 1024) },
    });
    await callRoute("POST", "/workflows/wf-1/metadata");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(422);
  });

  it("upserts + audits with { before, after, workflowId } on success", async () => {
    limitMock.mockResolvedValueOnce([{ id: "wf-1" }]);
    readJsonMock.mockResolvedValueOnce({
      metadata: { owners: ["alice"], tags: ["billing"], severityDefault: "p1" },
    });
    upsertMock.mockResolvedValueOnce({
      record: {
        workflowId: "wf-1",
        owners: ["alice"],
        runbookMarkdown: null,
        description: null,
        tags: ["billing"],
        slackChannel: null,
        linearProject: null,
        severityDefault: "p1",
        createdBy: "user-1",
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:00:00.000Z",
      },
      previous: null,
    });
    await callRoute("POST", "/workflows/wf-1/metadata");
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        workflowId: "wf-1",
        actorUserId: "user-1",
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "workflow.metadata.set",
      "workflow",
      "wf-1",
      expect.objectContaining({
        workflowId: "wf-1",
        before: null,
        after: expect.objectContaining({ owners: ["alice"] }),
      }),
    );
  });
});

describe("POST /workflows/:id/folder", () => {
  it("declares role: editor + permission: workflows.write", () => {
    const route = findRoute("POST", "/workflows/wf-1/folder");
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("workflows.write");
  });

  it("returns 404 when the workflow doesn't belong to the caller's org", async () => {
    limitMock.mockResolvedValueOnce([]);
    readJsonMock.mockResolvedValueOnce({ folder: "Billing" });
    await callRoute("POST", "/workflows/wf-1/folder");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(404);
    expect(setFolderMock).not.toHaveBeenCalled();
  });

  it("returns 422 on an invalid folder body (empty string)", async () => {
    limitMock.mockResolvedValueOnce([{ id: "wf-1" }]);
    readJsonMock.mockResolvedValueOnce({ folder: "" });
    await callRoute("POST", "/workflows/wf-1/folder");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(422);
    expect(setFolderMock).not.toHaveBeenCalled();
  });

  it("reassigns the folder + audits workflow.metadata.set on success", async () => {
    limitMock.mockResolvedValueOnce([{ id: "wf-1" }]);
    readJsonMock.mockResolvedValueOnce({ folder: "Onboarding" });
    setFolderMock.mockResolvedValueOnce({
      record: {
        workflowId: "wf-1",
        owners: ["alice"],
        runbookMarkdown: "# keep me",
        description: null,
        tags: ["billing"],
        folder: "Onboarding",
        slackChannel: "#ops",
        linearProject: null,
        severityDefault: "p1",
        createdBy: "user-1",
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T01:00:00.000Z",
      },
      previous: {
        workflowId: "wf-1",
        owners: ["alice"],
        runbookMarkdown: "# keep me",
        description: null,
        tags: ["billing"],
        folder: "Billing",
        slackChannel: "#ops",
        linearProject: null,
        severityDefault: "p1",
        createdBy: "user-1",
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T00:30:00.000Z",
      },
    });
    await callRoute("POST", "/workflows/wf-1/folder");
    expect(setFolderMock).toHaveBeenCalledWith({
      orgId: "org-1",
      workflowId: "wf-1",
      folder: "Onboarding",
      actorUserId: "user-1",
    });
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "workflow.metadata.set",
      "workflow",
      "wf-1",
      expect.objectContaining({
        workflowId: "wf-1",
        before: expect.objectContaining({ folder: "Billing" }),
        after: expect.objectContaining({ folder: "Onboarding" }),
      }),
    );
  });

  it("accepts folder: null (ungroup)", async () => {
    limitMock.mockResolvedValueOnce([{ id: "wf-1" }]);
    readJsonMock.mockResolvedValueOnce({ folder: null });
    setFolderMock.mockResolvedValueOnce({
      record: {
        workflowId: "wf-1",
        owners: [],
        runbookMarkdown: null,
        description: null,
        tags: [],
        folder: null,
        slackChannel: null,
        linearProject: null,
        severityDefault: null,
        createdBy: "user-1",
        createdAt: "2026-05-23T00:00:00.000Z",
        updatedAt: "2026-05-23T01:00:00.000Z",
      },
      previous: null,
    });
    await callRoute("POST", "/workflows/wf-1/folder");
    expect(setFolderMock).toHaveBeenCalledWith(
      expect.objectContaining({ folder: null }),
    );
  });
});

describe("POST /workflows/folders/rename", () => {
  it("declares role: editor + permission: workflows.write", () => {
    const route = findRoute("POST", "/workflows/folders/rename");
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("workflows.write");
  });

  it("returns 422 on an invalid body (missing 'to')", async () => {
    readJsonMock.mockResolvedValueOnce({ from: "Billing" });
    await callRoute("POST", "/workflows/folders/rename");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(422);
    expect(renameFolderMock).not.toHaveBeenCalled();
  });

  it("renames + audits workflow.folder.renamed with the affected ids", async () => {
    readJsonMock.mockResolvedValueOnce({ from: "Billing", to: "Invoicing" });
    renameFolderMock.mockResolvedValueOnce({ workflowIds: ["wf-1", "wf-2"] });
    await callRoute("POST", "/workflows/folders/rename");
    expect(renameFolderMock).toHaveBeenCalledWith({ orgId: "org-1", from: "Billing", to: "Invoicing" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "workflow.folder.renamed",
      "folder",
      "Invoicing",
      expect.objectContaining({ from: "Billing", to: "Invoicing", count: 2, workflowIds: ["wf-1", "wf-2"] }),
    );
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toMatchObject({ from: "Billing", to: "Invoicing", count: 2 });
  });
});

describe("POST /workflows/folders/delete", () => {
  it("declares role: editor + permission: workflows.write", () => {
    const route = findRoute("POST", "/workflows/folders/delete");
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("workflows.write");
  });

  it("returns 422 on an invalid body (empty folder)", async () => {
    readJsonMock.mockResolvedValueOnce({ folder: "" });
    await callRoute("POST", "/workflows/folders/delete");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(422);
    expect(deleteFolderMock).not.toHaveBeenCalled();
  });

  it("deletes + audits workflow.folder.deleted with the affected ids", async () => {
    readJsonMock.mockResolvedValueOnce({ folder: "Billing" });
    deleteFolderMock.mockResolvedValueOnce({ workflowIds: ["wf-1"] });
    await callRoute("POST", "/workflows/folders/delete");
    expect(deleteFolderMock).toHaveBeenCalledWith({ orgId: "org-1", folder: "Billing" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "workflow.folder.deleted",
      "folder",
      "Billing",
      expect.objectContaining({ folder: "Billing", count: 1, workflowIds: ["wf-1"] }),
    );
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toMatchObject({ folder: "Billing", count: 1 });
  });
});

describe("POST /workflows/folders/assign", () => {
  it("declares role: editor + permission: workflows.write", () => {
    const route = findRoute("POST", "/workflows/folders/assign");
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("workflows.write");
  });

  it("returns 422 on an invalid body (empty workflowIds)", async () => {
    readJsonMock.mockResolvedValueOnce({ workflowIds: [], folder: "Billing" });
    await callRoute("POST", "/workflows/folders/assign");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(422);
    expect(assignFolderMock).not.toHaveBeenCalled();
  });

  it("assigns + audits workflow.folder.bulk_assigned with the affected ids", async () => {
    readJsonMock.mockResolvedValueOnce({ workflowIds: ["wf-1", "wf-2"], folder: "Billing" });
    assignFolderMock.mockResolvedValueOnce({ workflowIds: ["wf-1", "wf-2"] });
    await callRoute("POST", "/workflows/folders/assign");
    expect(assignFolderMock).toHaveBeenCalledWith({
      orgId: "org-1",
      workflowIds: ["wf-1", "wf-2"],
      folder: "Billing",
      actorUserId: "user-1",
    });
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "workflow.folder.bulk_assigned",
      "folder",
      "Billing",
      expect.objectContaining({ folder: "Billing", count: 2, workflowIds: ["wf-1", "wf-2"] }),
    );
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toMatchObject({ folder: "Billing", count: 2 });
  });

  it("accepts folder: null (bulk ungroup) and audits with the (ungrouped) target", async () => {
    readJsonMock.mockResolvedValueOnce({ workflowIds: ["wf-1"], folder: null });
    assignFolderMock.mockResolvedValueOnce({ workflowIds: ["wf-1"] });
    await callRoute("POST", "/workflows/folders/assign");
    expect(assignFolderMock).toHaveBeenCalledWith(expect.objectContaining({ folder: null }));
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "workflow.folder.bulk_assigned",
      "folder",
      "(ungrouped)",
      expect.objectContaining({ folder: null, count: 1 }),
    );
  });
});

describe("POST /workflows/tags/assign", () => {
  it("declares role: editor + permission: workflows.write", () => {
    const route = findRoute("POST", "/workflows/tags/assign");
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("workflows.write");
  });

  it("returns 422 on an invalid op", async () => {
    readJsonMock.mockResolvedValueOnce({ workflowIds: ["wf-1"], tag: "urgent", op: "toggle" });
    await callRoute("POST", "/workflows/tags/assign");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(422);
    expect(assignTagMock).not.toHaveBeenCalled();
  });

  it("adds + audits workflow.tags.bulk_assigned with the tag, op, and affected ids", async () => {
    readJsonMock.mockResolvedValueOnce({ workflowIds: ["wf-1", "wf-2"], tag: "urgent", op: "add" });
    assignTagMock.mockResolvedValueOnce({ workflowIds: ["wf-1", "wf-2"] });
    await callRoute("POST", "/workflows/tags/assign");
    expect(assignTagMock).toHaveBeenCalledWith({
      orgId: "org-1",
      workflowIds: ["wf-1", "wf-2"],
      tag: "urgent",
      op: "add",
      actorUserId: "user-1",
    });
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "workflow.tags.bulk_assigned",
      "tag",
      "urgent",
      expect.objectContaining({ tag: "urgent", op: "add", count: 2, workflowIds: ["wf-1", "wf-2"] }),
    );
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toMatchObject({ tag: "urgent", op: "add", count: 2 });
  });

  it("supports op: remove", async () => {
    readJsonMock.mockResolvedValueOnce({ workflowIds: ["wf-1"], tag: "urgent", op: "remove" });
    assignTagMock.mockResolvedValueOnce({ workflowIds: ["wf-1"] });
    await callRoute("POST", "/workflows/tags/assign");
    expect(assignTagMock).toHaveBeenCalledWith(expect.objectContaining({ op: "remove" }));
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "workflow.tags.bulk_assigned",
      "tag",
      "urgent",
      expect.objectContaining({ op: "remove", count: 1 }),
    );
  });
});

describe("route matcher", () => {
  it("matches /workflows/:id/metadata exactly", () => {
    const route = findRoute("GET", "/workflows/wf-1/metadata");
    const matcher = typeof route.match === "string" ? () => true : route.match;
    expect(matcher("/workflows/wf-1/metadata")).toBe(true);
    expect(matcher("/workflows/wf-1/metadata?include=x")).toBe(true);
    expect(matcher("/workflows/wf-1/slo")).toBe(false);
    expect(matcher("/workflows/wf-1/folder")).toBe(false);
    expect(matcher("/workflows/wf-1/metadata/extra")).toBe(false);
    expect(matcher("/workflows/wf-1")).toBe(false);
  });

  it("matches /workflows/:id/folder exactly (and not /metadata or /slo)", () => {
    const route = findRoute("POST", "/workflows/wf-1/folder");
    const matcher = typeof route.match === "string" ? () => true : route.match;
    expect(matcher("/workflows/wf-1/folder")).toBe(true);
    expect(matcher("/workflows/wf-1/folder?x=1")).toBe(true);
    expect(matcher("/workflows/wf-1/metadata")).toBe(false);
    expect(matcher("/workflows/wf-1/slo")).toBe(false);
    expect(matcher("/workflows/wf-1/folder/extra")).toBe(false);
    expect(matcher("/workflows/folders")).toBe(false);
    expect(matcher("/workflows/wf-1")).toBe(false);
    // The per-id folder matcher must NOT swallow the collection routes.
    expect(matcher("/workflows/folders/rename")).toBe(false);
    expect(matcher("/workflows/folders/delete")).toBe(false);
  });

  it("matches the folder collection ops exactly (rename ≠ delete ≠ per-id)", () => {
    const rename = findRoute("POST", "/workflows/folders/rename");
    const del = findRoute("POST", "/workflows/folders/delete");
    const renameMatch = typeof rename.match === "string" ? () => true : rename.match;
    const delMatch = typeof del.match === "string" ? () => true : del.match;
    expect(renameMatch("/workflows/folders/rename")).toBe(true);
    expect(renameMatch("/workflows/folders/rename?x=1")).toBe(true);
    expect(renameMatch("/workflows/folders/delete")).toBe(false);
    expect(renameMatch("/workflows/wf-1/folder")).toBe(false);
    expect(delMatch("/workflows/folders/delete")).toBe(true);
    expect(delMatch("/workflows/folders/rename")).toBe(false);
    expect(delMatch("/workflows/wf-1/folder")).toBe(false);

    const assign = findRoute("POST", "/workflows/folders/assign");
    const assignMatch = typeof assign.match === "string" ? () => true : assign.match;
    expect(assignMatch("/workflows/folders/assign")).toBe(true);
    expect(assignMatch("/workflows/folders/rename")).toBe(false);
    expect(assignMatch("/workflows/wf-1/folder")).toBe(false);
    // The per-id folder matcher must not swallow the assign collection route.
    const folderRoute = findRoute("POST", "/workflows/wf-1/folder");
    const folderMatch = typeof folderRoute.match === "string" ? () => true : folderRoute.match;
    expect(folderMatch("/workflows/folders/assign")).toBe(false);
  });

  it("matches /workflows/tags/assign exactly (and no per-id matcher swallows it)", () => {
    const tagAssign = findRoute("POST", "/workflows/tags/assign");
    const tagMatch = typeof tagAssign.match === "string" ? () => true : tagAssign.match;
    expect(tagMatch("/workflows/tags/assign")).toBe(true);
    expect(tagMatch("/workflows/tags/assign?x=1")).toBe(true);
    expect(tagMatch("/workflows/folders/assign")).toBe(false);
    expect(tagMatch("/workflows/wf-1/folder")).toBe(false);
    // The per-id folder + metadata matchers must not swallow the tag collection route.
    const folderRoute = findRoute("POST", "/workflows/wf-1/folder");
    const folderMatch = typeof folderRoute.match === "string" ? () => true : folderRoute.match;
    expect(folderMatch("/workflows/tags/assign")).toBe(false);
    const metaRoute = findRoute("GET", "/workflows/wf-1/metadata");
    const metaMatch = typeof metaRoute.match === "string" ? () => true : metaRoute.match;
    expect(metaMatch("/workflows/tags/assign")).toBe(false);
  });
});
