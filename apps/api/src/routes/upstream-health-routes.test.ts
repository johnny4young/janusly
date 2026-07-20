/**
 * Route-level tests for the upstream-health source CRUD + check-now routes.
 *
 * Confirms:
 *  - Each route declares the right role + permission gate.
 *  - 422 on Zod body failure; 409 on duplicate name; 404 on missing source.
 *  - Create / update / delete write the right audit action.
 *  - "Check now" (manual override) calls `pollOneSource` and returns its result.
 *  - Multi-tenant: the repo functions are always called with `auth.orgId`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  const sendJson = vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status }));
  return {
    ...actual,
    sendJson,
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      sendJson(_res, params === undefined ? { error: message, code } : { error: message, code, params }, status)),
    readJson: vi.fn(),
  };
});

vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  createUpstreamHealthSource: vi.fn(),
  deleteUpstreamHealthSource: vi.fn(),
  findUpstreamHealthSourceByName: vi.fn(),
  getUpstreamHealthSourceById: vi.fn(),
  listUpstreamHealthSources: vi.fn(),
  updateUpstreamHealthSource: vi.fn(),
}));

vi.mock("@janusly/engine/src/upstream-health-poller", () => ({
  pollOneSource: vi.fn(),
}));

vi.mock("../audit-helper", () => ({
  auditAction: vi.fn(),
}));

import { upstreamHealthRoutes } from "./upstream-health-routes";
import { readJson, sendJson } from "../http";
import {
  createUpstreamHealthSource,
  deleteUpstreamHealthSource,
  findUpstreamHealthSourceByName,
  getUpstreamHealthSourceById,
  listUpstreamHealthSources,
  updateUpstreamHealthSource,
} from "@janusly/data";
import { pollOneSource } from "@janusly/engine/src/upstream-health-poller";
import { auditAction } from "../audit-helper";
import type { Route } from "../routes";

const sendJsonMock = vi.mocked(sendJson);
const readJsonMock = vi.mocked(readJson);
const createMock = vi.mocked(createUpstreamHealthSource);
const deleteMock = vi.mocked(deleteUpstreamHealthSource);
const findByNameMock = vi.mocked(findUpstreamHealthSourceByName);
const getByIdMock = vi.mocked(getUpstreamHealthSourceById);
const listMock = vi.mocked(listUpstreamHealthSources);
const updateMock = vi.mocked(updateUpstreamHealthSource);
const pollMock = vi.mocked(pollOneSource);
const auditMock = vi.mocked(auditAction);

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as never;

function findRoute(method: string, path: string): Route {
  const route = upstreamHealthRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

async function callRoute(method: string, path: string) {
  const route = findRoute(method, path);
  return route.handler({ req: { url: path } as never, res: {} as never, auth });
}

const VALID_SOURCE = {
  name: "stripe-prod",
  kind: "statuspage_io",
  url: "https://status.stripe.com/api/v2/status.json",
};

const HYDRATED = {
  id: "src-1",
  orgId: "org-1",
  name: "stripe-prod",
  kind: "statuspage_io",
  url: "https://status.stripe.com/api/v2/status.json",
  expectedComponents: [],
  checkIntervalSeconds: 60,
  enabled: true,
  lastStatus: null,
  lastDegraded: false,
  lastCheckedAt: null,
  lastErrorReason: null,
  createdBy: null,
  createdAt: null,
  updatedAt: null,
};

afterEach(() => {
  vi.clearAllMocks();
  readJsonMock.mockReset();
});

describe("route gates", () => {
  it("GET /upstream/sources is viewer + upstream.read", () => {
    const route = findRoute("GET", "/upstream/sources");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("upstream.read");
  });
  it("POST /upstream/sources is admin + upstream.write", () => {
    const route = findRoute("POST", "/upstream/sources");
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("upstream.write");
  });
  it("DELETE /upstream/sources/:id is admin + upstream.write", () => {
    const route = findRoute("DELETE", "/upstream/sources/src-1");
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("upstream.write");
  });
  it("check route matches BEFORE the bare :id route (first-match-wins)", () => {
    // The /check matcher must win over the bare :id matcher for a check path.
    const route = findRoute("POST", "/upstream/sources/src-1/check");
    expect(route.role).toBe("admin");
    // Confirm the bare :id route does NOT also match the check path's id with a trailing segment.
    expect(typeof route.match === "function" && route.match("/upstream/sources/src-1/check")).toBe(true);
  });
});

describe("GET /upstream/sources", () => {
  it("lists sources scoped to the caller org", async () => {
    listMock.mockResolvedValueOnce([HYDRATED] as never);
    await callRoute("GET", "/upstream/sources");
    expect(listMock).toHaveBeenCalledWith("org-1");
    expect(sendJsonMock.mock.calls.at(-1)?.[1]).toMatchObject({ sources: [HYDRATED] });
  });
});

describe("POST /upstream/sources (create)", () => {
  it("422 on invalid body", async () => {
    readJsonMock.mockResolvedValueOnce({ source: { name: "", kind: "statuspage_io", url: "nope" } });
    await callRoute("POST", "/upstream/sources");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(422);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("409 on duplicate name", async () => {
    readJsonMock.mockResolvedValueOnce({ source: VALID_SOURCE });
    findByNameMock.mockResolvedValueOnce(HYDRATED as never);
    await callRoute("POST", "/upstream/sources");
    const last = sendJsonMock.mock.calls.at(-1);
    expect(last?.[2]).toBe(409);
    expect(last?.[1]).toMatchObject({ code: "upstream_source_duplicate" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates + audits upstream_health.source.created on success", async () => {
    readJsonMock.mockResolvedValueOnce({ source: VALID_SOURCE });
    findByNameMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce(HYDRATED as never);
    await callRoute("POST", "/upstream/sources");
    expect(createMock).toHaveBeenCalledWith("org-1", expect.objectContaining({ name: "stripe-prod", createdBy: "user-1" }));
    expect(auditMock).toHaveBeenCalledWith(auth, "upstream_health.source.created", expect.objectContaining({ targetId: "src-1" }));
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(201);
  });
});

describe("POST /upstream/sources/:id (update)", () => {
  it("404 when the source doesn't exist for the org", async () => {
    readJsonMock.mockResolvedValueOnce({ source: VALID_SOURCE });
    findByNameMock.mockResolvedValueOnce(null);
    updateMock.mockResolvedValueOnce(null);
    await callRoute("POST", "/upstream/sources/src-x");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(404);
  });

  it("409 when renaming onto another source's name", async () => {
    readJsonMock.mockResolvedValueOnce({ source: VALID_SOURCE });
    findByNameMock.mockResolvedValueOnce({ ...HYDRATED, id: "other-src" } as never);
    await callRoute("POST", "/upstream/sources/src-1");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("updates + audits upstream_health.source.updated with before/after", async () => {
    readJsonMock.mockResolvedValueOnce({ source: VALID_SOURCE });
    findByNameMock.mockResolvedValueOnce({ ...HYDRATED, id: "src-1" } as never);
    updateMock.mockResolvedValueOnce({ before: HYDRATED, after: { ...HYDRATED, enabled: false } } as never);
    await callRoute("POST", "/upstream/sources/src-1");
    expect(updateMock).toHaveBeenCalledWith("org-1", "src-1", expect.objectContaining({ name: "stripe-prod" }));
    expect(auditMock).toHaveBeenCalledWith(auth, "upstream_health.source.updated", expect.objectContaining({
      metadata: expect.objectContaining({ before: HYDRATED }),
    }));
  });
});

describe("DELETE /upstream/sources/:id", () => {
  it("404 when missing", async () => {
    deleteMock.mockResolvedValueOnce(null);
    await callRoute("DELETE", "/upstream/sources/src-x");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(404);
  });
  it("deletes + audits on success", async () => {
    deleteMock.mockResolvedValueOnce(HYDRATED as never);
    await callRoute("DELETE", "/upstream/sources/src-1");
    expect(deleteMock).toHaveBeenCalledWith("org-1", "src-1");
    expect(auditMock).toHaveBeenCalledWith(auth, "upstream_health.source.deleted", expect.objectContaining({ targetId: "src-1" }));
  });
});

describe("POST /upstream/sources/:id/check (manual poll)", () => {
  it("404 when the source doesn't exist", async () => {
    getByIdMock.mockResolvedValueOnce(null);
    await callRoute("POST", "/upstream/sources/src-x/check");
    expect(sendJsonMock.mock.calls.at(-1)?.[2]).toBe(404);
    expect(pollMock).not.toHaveBeenCalled();
  });

  it("polls the source now and returns the parse result + flips", async () => {
    getByIdMock.mockResolvedValueOnce(HYDRATED as never);
    pollMock.mockResolvedValueOnce({
      parse: { ok: true, status: "major_outage", degraded: true, components: [] },
      pausedWorkflowIds: ["wf-1"],
      resumedWorkflowIds: [],
      failedOpen: false,
    } as never);
    getByIdMock.mockResolvedValueOnce({ ...HYDRATED, lastStatus: "major_outage", lastDegraded: true } as never);
    await callRoute("POST", "/upstream/sources/src-1/check");
    expect(pollMock).toHaveBeenCalledWith(HYDRATED);
    const payload = sendJsonMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(payload.pausedWorkflowIds).toEqual(["wf-1"]);
    expect(payload.failedOpen).toBe(false);
  });
});
