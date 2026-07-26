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

const softDeleteWorkflowMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  const sendJson = vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status }));
  return {
    ...actual,
    sendJson,
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      sendJson(_res, params === undefined ? { error: message, code } : { error: message, code, params }, status)),
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

vi.mock("@janusly/data/src/scheduleHistoryRepo", () => ({
  queryScheduleFires: vi.fn(),
  findScheduleEntriesForWorkflow: vi.fn(),
}));

vi.mock("@janusly/data/src/workflowsListRepo", () => ({
  listWorkflowsWithRunSummary: vi.fn(),
  listDeletedWorkflowsWithRunSummary: vi.fn(),
}));

vi.mock("@janusly/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@janusly/data")>();
  return { ...actual, softDeleteWorkflow: softDeleteWorkflowMock };
});

// `workflows-routes` reaches the trigger backfill on the resume path, which
// pulls `startRun` -> the BullMQ queue module. Stubbed here for the same
// reason the engine modules below are: this suite is about SLO routes.
vi.mock("./trigger-ingest-routes", () => ({
  backfillBufferedTriggerEvents: vi.fn(async () => ({ backfilled: 0, failed: 0, remaining: 0 })),
  TRIGGER_BACKFILL_MAX_PER_RESUME: 100,
  triggerIngestRoutes: [],
}));

vi.mock("@janusly/engine/src/schedule-scheduler", () => ({
  unregisterAllForWorkflow: vi.fn(),
  syncWorkflowSchedules: vi.fn(),
}));

// The schedule-history engine helpers are pure (no I/O) — import the real
// module so the route test exercises the genuine bucketing + cron-parser
// next-fire computation end-to-end.
vi.mock("@janusly/engine/src/schedule-history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@janusly/engine/src/schedule-history")>();
  return { ...actual };
});

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
// Soft-delete + restore both go through db.update(...).set(...).where().returning().
const updateMock = vi.hoisted(() => vi.fn(() => ({
  set: vi.fn(() => ({
    where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "wf-1" }]) })),
  })),
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
    update: updateMock,
    delete: deleteMock,
    transaction: vi.fn(),
  },
  workflows: { id: "id_col", orgId: "org_col", deletedAt: "deleted_col" },
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
import { findScheduleEntriesForWorkflow, queryScheduleFires } from "@janusly/data/src/scheduleHistoryRepo";
import { listDeletedWorkflowsWithRunSummary } from "@janusly/data/src/workflowsListRepo";
import { workflows } from "@janusly/db";
import type { Route } from "../routes";

const sendJsonMock = vi.mocked(sendJson);
const readJsonMock = vi.mocked(readJson);
const setWorkflowSloMock = vi.mocked(setWorkflowSlo);
const queryScheduleFiresMock = vi.mocked(queryScheduleFires);
const findScheduleEntriesMock = vi.mocked(findScheduleEntriesForWorkflow);
const listDeletedMock = vi.mocked(listDeletedWorkflowsWithRunSummary);
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
  queryScheduleFiresMock.mockReset();
  findScheduleEntriesMock.mockReset();
  listDeletedMock.mockReset();
  workflowsOwnedLimitMock.mockReset();
  deleteMock.mockClear();
  updateMock.mockClear();
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

describe("GET /workflows versions/latest soft-delete gate", () => {
  it("returns 404 for versions when the active-workflow ownership gate misses", async () => {
    mockWorkflowOwned(false);
    await callRoute("GET", "/workflows/versions?workflowId=wf-1", {});

    expect(sendJsonMock.mock.calls[0]?.[2]).toBe(404);
  });

  it("returns 404 for latest when the active-workflow ownership gate misses", async () => {
    mockWorkflowOwned(false);
    await callRoute("GET", "/workflows/latest?workflowId=wf-1", {});

    expect(sendJsonMock.mock.calls[0]?.[2]).toBe(404);
  });
});

describe("GET /workflows/trash route", () => {
  it("declares permission: workflows.read (matches the tags/folders siblings)", () => {
    const route = findRoute("GET", "/workflows/trash");
    expect(route.permission).toBe("workflows.read");
  });

  it("lists soft-deleted workflows via listDeletedWorkflowsWithRunSummary and returns the rows", async () => {
    const rows = [{ id: "wf-1", name: "Old", deletedAt: new Date("2026-03-01T00:00:00Z") }];
    listDeletedMock.mockResolvedValueOnce(rows as never);

    await callRoute("GET", "/workflows/trash", {});

    expect(listDeletedMock).toHaveBeenCalledWith("org-1", 100, undefined);
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toBe(rows);
  });

  it("clamps the limit to the 200 cap", async () => {
    listDeletedMock.mockResolvedValueOnce([] as never);

    await callRoute("GET", "/workflows/trash?limit=9999", {});

    expect(listDeletedMock).toHaveBeenCalledWith("org-1", 200, undefined);
  });

  it("threads a ?before=<deletedAt>|<id> keyset cursor into the repo", async () => {
    listDeletedMock.mockResolvedValueOnce([] as never);

    await callRoute("GET", "/workflows/trash?before=2026-03-01T00:00:00.000Z|wf-x", {});

    expect(listDeletedMock).toHaveBeenCalledWith("org-1", 100, {
      deletedAt: new Date("2026-03-01T00:00:00.000Z"),
      id: "wf-x",
    });
  });

  it("ignores a malformed ?before= cursor (unpaged)", async () => {
    listDeletedMock.mockResolvedValueOnce([] as never);

    await callRoute("GET", "/workflows/trash?before=not-a-cursor", {});

    expect(listDeletedMock).toHaveBeenCalledWith("org-1", 100, undefined);
  });

  it("is registered before the bare /workflows matcher (not shadowed)", () => {
    // The bare list matcher must NOT claim the trash path; first-match-wins in
    // the registry resolves /workflows/trash to the trash handler.
    const trash = findRoute("GET", "/workflows/trash");
    const bare = findRoute("GET", "/workflows");
    expect(trash).not.toBe(bare);
  });
});

describe("DELETE /workflows/:id handler", () => {
  it("soft-deletes a workflow (tombstones via UPDATE; keeps versions + metadata)", async () => {
    await callRoute("DELETE", "/workflows/wf-1", {});

    // The data-layer transaction owns the tombstone + rollout cancellation;
    // the route must never fall back to the legacy hard delete.
    expect(softDeleteWorkflowMock).toHaveBeenCalledWith("org-1", "wf-1");
    expect(deleteMock).not.toHaveBeenCalled();
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toMatchObject({ workflowId: "wf-1", ok: true });
  });

  it("restore reverses a soft delete via UPDATE", async () => {
    mockWorkflowOwned(true);
    await callRoute("POST", "/workflows/wf-1/restore", {});

    expect(updateMock).toHaveBeenCalledWith(workflows);
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toMatchObject({ workflowId: "wf-1", ok: true });
  });

  it("does not treat a sibling sub-route name as a workflow id to delete", () => {
    // The DELETE matcher must exclude every single-segment `/workflows/<name>`
    // sub-route so `DELETE /workflows/trash` can't tombstone a workflow whose id
    // happens to equal a route name. Keep this list in sync with the matcher.
    for (const name of ["save", "rollback", "versions", "latest", "validate", "readiness", "health", "tags", "folders", "trash"]) {
      expect(() => findRoute("DELETE", `/workflows/${name}`)).toThrow();
    }
    // A real id still resolves to the soft-delete handler.
    expect(findRoute("DELETE", "/workflows/wf-1").method).toBe("DELETE");
  });
});

describe("GET /workflows/:id/schedule-history route shape", () => {
  it("declares role: viewer + permission: workflows.read", () => {
    const route = findRoute("GET", "/workflows/wf-1/schedule-history");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("workflows.read");
  });

  it("does not match the bare /workflows/wf-1 path or unrelated suffixes", () => {
    expect(() => findRoute("GET", "/workflows/wf-1")).toThrow();
    expect(() => findRoute("GET", "/workflows/wf-1/other")).toThrow();
  });

  it("matches with a trailing query string", () => {
    expect(() => findRoute("GET", "/workflows/wf-1/schedule-history?windowDays=30")).not.toThrow();
  });
});

describe("GET /workflows/:id/schedule-history handler", () => {
  it("returns 404 when the workflow does not belong to the caller's org", async () => {
    mockWorkflowOwned(false);
    await callRoute("GET", "/workflows/wf-1/schedule-history", {});
    const status = sendJsonMock.mock.calls[0]?.[2];
    expect(status).toBe(404);
    // Tenant gate fails closed BEFORE any history read.
    expect(queryScheduleFiresMock).not.toHaveBeenCalled();
    expect(findScheduleEntriesMock).not.toHaveBeenCalled();
  });

  it("buckets fires into the heatmap and previews next fires for enabled schedules", async () => {
    mockWorkflowOwned(true);
    // 2024-01-01 is a Monday (UTC dayOfWeek = 1).
    queryScheduleFiresMock.mockResolvedValueOnce([
      { firedAt: new Date("2024-01-01T09:00:00.000Z"), status: "succeeded" },
      { firedAt: new Date("2024-01-01T09:30:00.000Z"), status: "failed" },
    ]);
    findScheduleEntriesMock.mockResolvedValueOnce([
      { nodeId: "cron-1", cronExpression: "0 9 * * *", enabled: true, lastRunAt: new Date("2024-01-01T09:30:00.000Z"), lastRunId: "run-9", workflowVersionId: "v1" },
      { nodeId: "cron-2", cronExpression: "0 12 * * *", enabled: false, lastRunAt: null, lastRunId: null, workflowVersionId: "v1" },
    ]);

    await callRoute("GET", "/workflows/wf-1/schedule-history?windowDays=30&nextFires=3", {});

    const payload = sendJsonMock.mock.calls.at(-1)?.[1] as {
      workflowId: string;
      windowDays: number;
      capped: boolean;
      heatmap: { cells: Array<{ dayOfWeek: number; hour: number; total: number; success: number; fail: number; anomaly: boolean }>; totalFires: number; totalSuccess: number; totalFail: number; timezone: string };
      schedules: Array<{ nodeId: string; cronExpression: string; enabled: boolean; lastRunAt: string | null; lastRunId: string | null; nextFires: string[] }>;
    };

    expect(payload.workflowId).toBe("wf-1");
    expect(payload.windowDays).toBe(30);
    expect(payload.capped).toBe(false);
    expect(payload.heatmap.totalFires).toBe(2);
    expect(payload.heatmap.totalSuccess).toBe(1);
    expect(payload.heatmap.totalFail).toBe(1);
    expect(payload.heatmap.timezone).toBe("UTC");
    expect(payload.heatmap.cells).toHaveLength(1);
    expect(payload.heatmap.cells[0]).toMatchObject({ dayOfWeek: 1, hour: 9, total: 2, success: 1, fail: 1, anomaly: false });

    // Enabled schedule gets a 3-entry preview; disabled schedule gets none.
    const enabled = payload.schedules.find((s) => s.nodeId === "cron-1");
    const disabled = payload.schedules.find((s) => s.nodeId === "cron-2");
    expect(enabled?.nextFires).toHaveLength(3);
    expect(enabled?.lastRunAt).toBe("2024-01-01T09:30:00.000Z");
    expect(disabled?.nextFires).toEqual([]);
    expect(disabled?.cronExpression).toBe("0 12 * * *");

    // The repo received the clamped window + the org/workflow scope.
    expect(queryScheduleFiresMock).toHaveBeenCalledWith("org-1", "wf-1", 30, expect.any(Number));
    expect(findScheduleEntriesMock).toHaveBeenCalledWith("org-1", "wf-1");
  });

  it("renders an empty heatmap when the workflow has no scheduled history", async () => {
    mockWorkflowOwned(true);
    queryScheduleFiresMock.mockResolvedValueOnce([]);
    findScheduleEntriesMock.mockResolvedValueOnce([]);

    await callRoute("GET", "/workflows/wf-1/schedule-history", {});

    const payload = sendJsonMock.mock.calls.at(-1)?.[1] as {
      heatmap: { cells: unknown[]; totalFires: number };
      schedules: unknown[];
      windowDays: number;
    };
    expect(payload.heatmap.cells).toEqual([]);
    expect(payload.heatmap.totalFires).toBe(0);
    expect(payload.schedules).toEqual([]);
    // Default window is the full 90-day lookback.
    expect(payload.windowDays).toBe(90);
  });

  it("clamps an out-of-range windowDays into [1, 90]", async () => {
    mockWorkflowOwned(true);
    queryScheduleFiresMock.mockResolvedValueOnce([]);
    findScheduleEntriesMock.mockResolvedValueOnce([]);

    await callRoute("GET", "/workflows/wf-1/schedule-history?windowDays=9999", {});

    const payload = sendJsonMock.mock.calls.at(-1)?.[1] as { windowDays: number };
    expect(payload.windowDays).toBe(90);
    expect(queryScheduleFiresMock).toHaveBeenCalledWith("org-1", "wf-1", 90, expect.any(Number));
  });
});

describe("GET /workflows/schedule-preview", () => {
  it("declares the read gates and stable contract", () => {
    const route = findRoute("GET", "/workflows/schedule-preview?cron=0%209%20*%20*%20*");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("workflows.read");
    expect(route.contract?.operationId).toBe("getSchedulePreview");
    expect(route.contract?.response.safeParse({ valid: true, nextFires: [] }).success).toBe(false);
    expect(route.contract?.response.safeParse({ valid: false, nextFires: ["2026-07-15T09:00:00.000Z"] }).success).toBe(false);
    expect(route.contract?.response.safeParse({
      valid: true,
      nextFires: [
        "2026-07-15T09:00:00.000Z",
        "2026-07-16T09:00:00.000Z",
        "2026-07-17T09:00:00.000Z",
      ],
    }).success).toBe(true);
    expect(() => findRoute("GET", "/workflows/schedule-preview-extra?cron=0%209%20*%20*%20*")).toThrow();
  });

  it("returns three canonical future instants for a valid cron", async () => {
    await callRoute("GET", "/workflows/schedule-preview?cron=0%209%20*%20*%20*", {});

    const payload = sendJsonMock.mock.calls.at(-1)?.[1] as { valid: boolean; nextFires: string[] };
    expect(payload.valid).toBe(true);
    expect(payload.nextFires).toHaveLength(3);
    expect(payload.nextFires.every((value) => Number.isFinite(Date.parse(value)))).toBe(true);
  });

  it("degrades malformed or oversized expressions to an invalid preview", async () => {
    await callRoute("GET", "/workflows/schedule-preview?cron=not-a-cron", {});
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toEqual({ valid: false, nextFires: [] });

    await callRoute("GET", "/workflows/schedule-preview?cron=0%200%209%20*%20*%20*", {});
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toEqual({ valid: false, nextFires: [] });

    await callRoute("GET", `/workflows/schedule-preview?cron=${"x".repeat(101)}`, {});
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toEqual({ valid: false, nextFires: [] });
  });
});
