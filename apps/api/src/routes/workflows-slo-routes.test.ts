/**
 * Route-level tests for POST /workflows/:id/slo and the SLO surface in
 * GET /workflows/health.
 *
 * The dispatcher's role / permission gates are declarative — these tests
 * pin the route entry's shape (role: admin) and the handler's body
 * validation + audit emission.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowSlo } from "@janusly/shared";

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
    readJson: vi.fn(),
    asRecord: (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {}),
  };
});

vi.mock("@janusly/data/src/workflowSloRepo", () => ({
  getWorkflowSlo: vi.fn(),
  setWorkflowSlo: vi.fn(),
}));

vi.mock("@janusly/data/src/workflowHealthRepo", () => ({
  queryHealthSignals: vi.fn(),
  DEFAULT_HEALTH_WINDOW_DAYS: 30,
}));

vi.mock("@janusly/engine/src/schedule-scheduler", () => ({
  unregisterAllForWorkflow: vi.fn(),
}));

vi.mock("@janusly/engine/src/workflow-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@janusly/engine/src/workflow-health")>();
  return {
    ...actual,
  };
});

const workflowsOwnedLimitMock = vi.fn();
const deleteMock = vi.hoisted(() => vi.fn(() => ({
  where: vi.fn(),
})));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          0: { id: "wf-1" },
          orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
          limit: workflowsOwnedLimitMock,
        })),
      })),
    })),
    insert: vi.fn(),
    update: vi.fn(),
    delete: deleteMock,
    transaction: vi.fn(),
  },
  workflows: { id: "id_col", orgId: "org_col" },
  workflowMetadata: { orgId: "org_col", workflowId: "wf_col" },
  workflowVersions: { id: "id_col", orgId: "org_col", workflowId: "wf_col", version: "ver_col", dagJson: "dag_col" },
  runs: { id: "id_col" },
  deadLetters: { id: "id_col" },
}));

vi.mock("../audit", () => ({
  audit: vi.fn(),
}));

vi.mock("../workflows-save", () => ({ saveWorkflowVersion: vi.fn() }));
vi.mock("../workflows-rollback", () => ({
  rollbackAuditMetadata: vi.fn(),
  rollbackWorkflowToVersion: vi.fn(),
}));

import { workflowsRoutes } from "./workflows-routes";
import { sendJson, readJson } from "../http";
import { audit } from "../audit";
import { setWorkflowSlo } from "@janusly/data/src/workflowSloRepo";
import { workflowMetadata } from "@janusly/db";
import type { Route } from "../routes";

const sendJsonMock = vi.mocked(sendJson);
const readJsonMock = vi.mocked(readJson);
const setWorkflowSloMock = vi.mocked(setWorkflowSlo);
const auditMock = vi.mocked(audit);

function findRoute(method: string, path: string): Route {
  const route = workflowsRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

async function callRoute(method: string, path: string, body: unknown) {
  const route = findRoute(method, path);
  readJsonMock.mockResolvedValueOnce(body);
  return route.handler({
    req: { url: path } as never,
    res: {} as never,
    auth: { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as never,
  });
}

beforeEach(() => {
  readJsonMock.mockReset();
  setWorkflowSloMock.mockReset();
  workflowsOwnedLimitMock.mockReset();
  deleteMock.mockClear();
  sendJsonMock.mockClear();
  auditMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

function mockWorkflowOwned(owned: boolean) {
  workflowsOwnedLimitMock.mockResolvedValueOnce(owned ? [{ id: "wf-1" }] : []);
}

const validSlo: WorkflowSlo = {
  successRatePercent: 95,
  mttrSeconds: null,
  p95DurationMs: 10_000,
  budgetBlocksPerWindow: null,
  stuckWaitingNodesMax: null,
  windowDays: 7,
};

describe("POST /workflows/:id/slo route shape", () => {
  it("declares role: admin", () => {
    const route = findRoute("POST", "/workflows/wf-1/slo");
    expect(route.role).toBe("admin");
  });

  it("does not match unrelated suffixes (e.g. /workflows/wf-1/other)", () => {
    expect(() => findRoute("POST", "/workflows/wf-1/other")).toThrow();
  });

  it("does not match the bare /workflows/wf-1 path", () => {
    // /workflows/wf-1 with two segments after the prefix is /workflows/wf-1/(empty)
    // — POST /workflows/<id> with no trailing /slo should not match either.
    expect(() => findRoute("POST", "/workflows/wf-1")).toThrow();
  });
});

describe("POST /workflows/:id/slo handler", () => {
  it("rejects an invalid SLO body with 400", async () => {
    mockWorkflowOwned(true);
    await callRoute("POST", "/workflows/wf-1/slo", { slo: { windowDays: 5 } });
    const status = sendJsonMock.mock.calls[0]?.[2];
    expect(status).toBe(400);
    expect(setWorkflowSloMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the workflow does not belong to the caller's org", async () => {
    mockWorkflowOwned(false);
    await callRoute("POST", "/workflows/wf-1/slo", { slo: validSlo });
    const status = sendJsonMock.mock.calls[0]?.[2];
    expect(status).toBe(404);
    expect(setWorkflowSloMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 404 when no version row exists for the workflow", async () => {
    mockWorkflowOwned(true);
    setWorkflowSloMock.mockResolvedValueOnce(undefined);
    await callRoute("POST", "/workflows/wf-1/slo", { slo: validSlo });
    const status = sendJsonMock.mock.calls[0]?.[2];
    expect(status).toBe(404);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("persists the SLO + writes workflow.slo.set audit row with previous value", async () => {
    mockWorkflowOwned(true);
    setWorkflowSloMock.mockResolvedValueOnce({ versionId: "v3", previousSlo: null });
    await callRoute("POST", "/workflows/wf-1/slo", { slo: validSlo });

    expect(setWorkflowSloMock).toHaveBeenCalledWith("org-1", "wf-1", validSlo);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "workflow.slo.set",
      "workflow",
      "wf-1",
      expect.objectContaining({
        slo: validSlo,
        previousSlo: null,
        versionId: "v3",
      }),
    );
    const status = sendJsonMock.mock.calls[0]?.[2];
    expect(status ?? 200).toBe(200);
  });

  it("accepts null to clear the SLO declaration", async () => {
    mockWorkflowOwned(true);
    setWorkflowSloMock.mockResolvedValueOnce({ versionId: "v3", previousSlo: validSlo });
    await callRoute("POST", "/workflows/wf-1/slo", { slo: null });

    expect(setWorkflowSloMock).toHaveBeenCalledWith("org-1", "wf-1", null);
    const auditMeta = auditMock.mock.calls[0]?.[5] as { previousSlo: WorkflowSlo | null };
    expect(auditMeta.previousSlo).toEqual(validSlo);
  });
});

describe("DELETE /workflows/:id handler", () => {
  it("cleans per-workflow metadata when hard-deleting a workflow", async () => {
    mockWorkflowOwned(true);
    await callRoute("DELETE", "/workflows/wf-1", {});

    expect(deleteMock).toHaveBeenCalledWith(workflowMetadata);
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toMatchObject({ workflowId: "wf-1", ok: true });
  });
});
