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
  getWorkflowMetadata,
  upsertWorkflowMetadata,
} from "@janusly/data/src/workflowMetadataRepo";
import { audit } from "../audit";
import type { Route } from "../routes";

const sendJsonMock = vi.mocked(sendJson);
const readJsonMock = vi.mocked(readJson);
const getMetadataMock = vi.mocked(getWorkflowMetadata);
const upsertMock = vi.mocked(upsertWorkflowMetadata);
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

describe("route matcher", () => {
  it("matches /workflows/:id/metadata exactly", () => {
    const route = findRoute("GET", "/workflows/wf-1/metadata");
    const matcher = typeof route.match === "string" ? () => true : route.match;
    expect(matcher("/workflows/wf-1/metadata")).toBe(true);
    expect(matcher("/workflows/wf-1/metadata?include=x")).toBe(true);
    expect(matcher("/workflows/wf-1/slo")).toBe(false);
    expect(matcher("/workflows/wf-1/metadata/extra")).toBe(false);
    expect(matcher("/workflows/wf-1")).toBe(false);
  });
});
