/**
 * Tests for the eval-datasets routes:
 *   GET    /eval/datasets
 *   POST   /eval/datasets
 *   GET    /eval/datasets/:id
 *   GET    /eval/datasets/:id/export?format=jsonl|json
 *   DELETE /eval/datasets/:id
 *
 * Coverage targets (the ticket AC):
 * - Create delegates to the repo with `auth.orgId` (the opt-in gate lives
 *   in `createEvalDataset` → `queryEligibleFeedbackForEval`, unit-tested
 *   in the data layer) and writes the `eval.dataset.created` audit.
 * - Duplicate name → 409 with `eval_dataset_name_exists`.
 * - Export streams JSONL by default (one scrubbed object per line) with an
 *   attachment header, JSON when `?format=json`, and re-scrubs at READ
 *   time (a secret in a stored example never reaches the wire).
 * - A cross-org / missing dataset returns a uniform 404 on export, GET,
 *   and DELETE.
 * - Delete delegates to the repo + writes `eval.dataset.deleted`.
 *
 * The repo + the shared serializer have their own focused suites; this
 * suite mocks the repo at the barrel boundary so the route wiring is the
 * unit under test (the shared serializer runs FOR REAL so the read-time
 * scrub is exercised end-to-end through the route).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  createEvalDataset: vi.fn(),
  deleteEvalDataset: vi.fn(),
  findEvalDatasetByName: vi.fn(),
  getEvalDataset: vi.fn(),
  listEvalDatasets: vi.fn(),
  listEvalExamples: vi.fn(),
}));

vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  const sendJson = vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status }));
  return {
    ...actual,
    sendJson,
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      sendJson(_res, params === undefined ? { error: message, code } : { error: message, code, params }, status)),
    corsHeaders: vi.fn(() => ({})),
    readJson: vi.fn(),
  };
});

import {
  createEvalDataset,
  deleteEvalDataset,
  findEvalDatasetByName,
  getEvalDataset,
  listEvalDatasets,
  listEvalExamples,
} from "@janusly/data";

import { auditAction } from "../audit-helper";
import { readJson, sendJson } from "../http";
import type { Route } from "../routes";
import { evalDatasetsRoutes } from "./eval-datasets-routes";

const createMock = vi.mocked(createEvalDataset);
const deleteMock = vi.mocked(deleteEvalDataset);
const findByNameMock = vi.mocked(findEvalDatasetByName);
const getMock = vi.mocked(getEvalDataset);
const listMock = vi.mocked(listEvalDatasets);
const listExamplesMock = vi.mocked(listEvalExamples);
const auditMock = vi.mocked(auditAction);
const readJsonMock = vi.mocked(readJson);
const sendJsonMock = vi.mocked(sendJson);

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as const;

function findRoute(method: "GET" | "POST" | "DELETE", url: string): Route {
  const route = evalDatasetsRoutes.find((candidate) => {
    if (candidate.method !== method) return false;
    return typeof candidate.match === "string" ? candidate.match === url : candidate.match(url);
  });
  if (!route) throw new Error(`route not found: ${method} ${url}`);
  return route;
}

type CapturedRes = {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  headers: Record<string, string> | null;
  status: number | null;
  body: string | null;
};

function makeRes(): CapturedRes {
  const res: CapturedRes = { writeHead: vi.fn(), end: vi.fn(), headers: null, status: null, body: null };
  res.writeHead.mockImplementation((status: number, headers: Record<string, string>) => {
    res.status = status;
    res.headers = headers;
  });
  res.end.mockImplementation((body: string) => {
    res.body = body;
  });
  return res;
}

async function call(method: "GET" | "POST" | "DELETE", url: string, res: CapturedRes) {
  const route = findRoute(method, url);
  return route.handler({ req: { url } as never, res: res as never, auth: auth as never });
}

const dataset = {
  id: "ds-1",
  orgId: "org-1",
  name: "billing-failures",
  description: "",
  workflowId: null,
  exampleCount: 2,
  retentionDays: 90,
  createdBy: "user-1",
  createdAt: new Date("2026-05-29T00:00:00Z"),
};

beforeEach(() => {
  createMock.mockReset();
  deleteMock.mockReset();
  findByNameMock.mockReset();
  getMock.mockReset();
  listMock.mockReset();
  listExamplesMock.mockReset();
  auditMock.mockReset();
  readJsonMock.mockReset();
  sendJsonMock.mockClear();
  auditMock.mockResolvedValue(undefined as never);
});

describe("route gating", () => {
  it("create + delete require admin + evals.write; reads require evals.read", () => {
    const create = findRoute("POST", "/eval/datasets");
    expect(create.role).toBe("admin");
    expect(create.permission).toBe("evals.write");
    const del = findRoute("DELETE", "/eval/datasets/ds-1");
    expect(del.role).toBe("admin");
    expect(del.permission).toBe("evals.write");
    const list = findRoute("GET", "/eval/datasets");
    expect(list.permission).toBe("evals.read");
    const exportRoute = findRoute("GET", "/eval/datasets/ds-1/export");
    expect(exportRoute.permission).toBe("evals.read");
  });
});

describe("POST /eval/datasets", () => {
  it("delegates to createEvalDataset scoped to auth.orgId + writes the created audit", async () => {
    readJsonMock.mockResolvedValue({ name: "billing-failures", retentionDays: 90 });
    findByNameMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ dataset, exampleCount: 2 });

    const res = makeRes();
    const result = (await call("POST", "/eval/datasets", res)) as { status?: number; payload?: { dataset?: { id?: string } } };

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", name: "billing-failures", createdBy: "user-1", retentionDays: 90 }),
    );
    expect(result.status).toBe(201);
    expect(result.payload?.dataset?.id).toBe("ds-1");
    expect(auditMock).toHaveBeenCalledTimes(1);
    const [, action, opts] = auditMock.mock.calls[0] as [unknown, string, { targetId?: string; metadata?: Record<string, unknown> }];
    expect(action).toBe("eval.dataset.created");
    expect(opts.targetId).toBe("ds-1");
    expect(opts.metadata?.exampleCount).toBe(2);
  });

  it("returns 409 on a duplicate dataset name", async () => {
    readJsonMock.mockResolvedValue({ name: "billing-failures" });
    findByNameMock.mockResolvedValue(dataset);

    const res = makeRes();
    const result = (await call("POST", "/eval/datasets", res)) as { status?: number; payload?: { code?: string } };
    expect(result.status).toBe(409);
    expect(result.payload?.code).toBe("eval_dataset_name_exists");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects an empty name with 400 (no repo call)", async () => {
    readJsonMock.mockResolvedValue({ name: "   " });
    const res = makeRes();
    const result = (await call("POST", "/eval/datasets", res)) as { status?: number };
    expect(result.status).toBe(400);
    expect(findByNameMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("GET /eval/datasets/:id/export", () => {
  it("streams JSONL by default with an attachment header and re-scrubs secrets at read time", async () => {
    getMock.mockResolvedValue(dataset);
    listExamplesMock.mockResolvedValue([
      {
        id: "ex-1",
        datasetId: "ds-1",
        sourceFeedbackId: "fb-1",
        workflowId: "wf-1",
        deadLetterId: "dl-1",
        // A secret shape that (hypothetically) slipped the write-time scrub:
        inputContext: "leaked Bearer sk-ABCDEF1234567890ABCDEF1234567890 here",
        failureSignature: "HTTP 401 on http node",
        expectedApproachLabel: "swap_secret_ref",
        accepted: true,
        suggestionMode: "ai",
        createdAt: "2026-05-29T00:00:00.000Z",
      },
    ]);

    const res = makeRes();
    await call("GET", "/eval/datasets/ds-1/export", res);

    expect(res.status).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers?.["Content-Disposition"]).toContain("attachment");
    expect(res.headers?.["Content-Disposition"]).toContain(".jsonl");
    // One JSON object on the single line.
    const line = JSON.parse((res.body ?? "").split("\n")[0]!) as Record<string, unknown>;
    expect(line.expectedApproachLabel).toBe("swap_secret_ref");
    // Read-time scrub: the secret never reaches the wire.
    expect(res.body).not.toContain("sk-ABCDEF");
    expect(res.body).toContain("[redacted]");
    // Audit row written.
    const [, action] = auditMock.mock.calls[0] as [unknown, string];
    expect(action).toBe("eval.dataset.exported");
  });

  it("streams JSON when ?format=json", async () => {
    getMock.mockResolvedValue(dataset);
    listExamplesMock.mockResolvedValue([]);
    const res = makeRes();
    await call("GET", "/eval/datasets/ds-1/export?format=json", res);
    expect(res.status).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("application/json");
    const parsed = JSON.parse(res.body ?? "{}") as { dataset?: { id?: string }; examples?: unknown[] };
    expect(parsed.dataset?.id).toBe("ds-1");
    expect(parsed.examples).toEqual([]);
  });

  it("404s uniformly when the dataset is absent / cross-org", async () => {
    getMock.mockResolvedValue(null);
    const res = makeRes();
    const result = (await call("GET", "/eval/datasets/ds-x/export", res)) as { status?: number; payload?: { code?: string } };
    expect(result.status).toBe(404);
    expect(result.payload?.code).toBe("eval_dataset_not_found");
    expect(listExamplesMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown format with 400", async () => {
    const res = makeRes();
    const result = (await call("GET", "/eval/datasets/ds-1/export?format=csv", res)) as { status?: number };
    expect(result.status).toBe(400);
    expect(getMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /eval/datasets/:id", () => {
  it("delegates to the repo + writes the deleted audit", async () => {
    deleteMock.mockResolvedValue(true);
    const res = makeRes();
    const result = (await call("DELETE", "/eval/datasets/ds-1", res)) as { payload?: { ok?: boolean } };
    expect(deleteMock).toHaveBeenCalledWith("org-1", "ds-1");
    expect(result.payload?.ok).toBe(true);
    const [, action, opts] = auditMock.mock.calls[0] as [unknown, string, { targetId?: string }];
    expect(action).toBe("eval.dataset.deleted");
    expect(opts.targetId).toBe("ds-1");
  });

  it("404s when the dataset is missing / cross-org (no audit)", async () => {
    deleteMock.mockResolvedValue(false);
    const res = makeRes();
    const result = (await call("DELETE", "/eval/datasets/ds-x", res)) as { status?: number; payload?: { code?: string } };
    expect(result.status).toBe(404);
    expect(result.payload?.code).toBe("eval_dataset_not_found");
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("GET /eval/datasets", () => {
  it("lists the org's datasets", async () => {
    listMock.mockResolvedValue([dataset]);
    const res = makeRes();
    const result = (await call("GET", "/eval/datasets", res)) as { payload?: { datasets?: unknown[] } };
    expect(listMock).toHaveBeenCalledWith("org-1");
    expect(result.payload?.datasets).toHaveLength(1);
  });
});
