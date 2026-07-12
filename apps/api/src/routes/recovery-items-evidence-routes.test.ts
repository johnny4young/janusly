/**
 * Tests for the recovery-item audit-evidence routes:
 *   POST /recovery/items/:id/evidence?format=json|markdown
 *   POST /recovery/items/:id/evidence/deliver
 *
 * Coverage targets (the ticket AC):
 * - Tenant scope: the resolver is called with `auth.orgId`; a null bundle
 *   (cross-org / missing item) returns a uniform 404, no enumeration.
 * - The `report.evidence.exported` audit row is written on a successful
 *   export with the right target + metadata.
 * - JSON (default) streams the structured envelope with a
 *   Content-Disposition attachment header.
 * - Markdown streams the rendered artefact with the markdown MIME type.
 * - An unknown `format` is rejected with 400.
 * - Delivery uses the shared report-delivery chokepoint and writes
 *   `report.evidence.delivered` audit rows on failed attempts.
 *
 * The pure builder + the resolver have their own focused suites
 * (`packages/engine/src/recovery-evidence-report.test.ts`,
 * exercised via the data layer); this suite mocks both at the
 * module boundary so the route's wiring stays the unit under test.
 */

import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeToolMock, enforceRateLimitMock } = vi.hoisted(() => ({
  executeToolMock: vi.fn(),
  enforceRateLimitMock: vi.fn(),
}));

vi.mock("@janusly/engine/src/tool-registry", () => ({ executeTool: executeToolMock }));
vi.mock("../rate-limit", () => ({ enforceRateLimit: enforceRateLimitMock }));

vi.mock("@janusly/data", () => ({
  // Only the symbols the route file imports from the barrel are stubbed.
  acknowledgeRecoveryItem: vi.fn(),
  appendCommentToRecoveryItem: vi.fn(),
  assignOwnerRecoveryItem: vi.fn(),
  escalateRecoveryItem: vi.fn(),
  getRecoveryItemById: vi.fn(),
  listRecoveryItems: vi.fn(),
  reopenRecoveryItem: vi.fn(),
  resolveRecoveryItem: vi.fn(),
  setInProgressRecoveryItem: vi.fn(),
  setWaitingExternalRecoveryItem: vi.fn(),
  listHandoffsForItem: vi.fn(),
  listRecoveryItemChildren: vi.fn(),
  countRecoveryItemChildren: vi.fn(),
  getWorkflowMetadata: vi.fn(),
  resolveRecoveryEvidence: vi.fn(),
}));

vi.mock("@janusly/engine/src/recovery-evidence-report", () => ({
  buildRecoveryEvidenceReport: vi.fn(),
}));

vi.mock("../audit", () => ({ audit: vi.fn() }));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      ({ payload: params === undefined ? { error: message, code } : { error: message, code, params }, status })),
    corsHeaders: vi.fn(() => ({})),
  };
});

import { resolveRecoveryEvidence } from "@janusly/data";
import { buildRecoveryEvidenceReport } from "@janusly/engine/src/recovery-evidence-report";

import { audit } from "../audit";
import { sendJson } from "../http";
import type { Route } from "../routes";
import { recoveryItemsRoutes } from "./recovery-items-routes";

const resolveEvidenceMock = vi.mocked(resolveRecoveryEvidence);
const buildEvidenceMock = vi.mocked(buildRecoveryEvidenceReport);
const auditMock = vi.mocked(audit);
const sendJsonMock = vi.mocked(sendJson);
const executeToolMocked = executeToolMock;
const enforceRateLimitMocked = enforceRateLimitMock;

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as const;

function findEvidenceRoute(): Route {
  const route = recoveryItemsRoutes.find((candidate) => {
    if (candidate.method !== "POST") return false;
    return typeof candidate.match === "string"
      ? candidate.match === "/recovery/items/ri_1/evidence"
      : candidate.match("/recovery/items/ri_1/evidence");
  });
  if (!route) throw new Error("route not found: POST /recovery/items/:id/evidence");
  return route;
}

function findEvidenceDeliverRoute(): Route {
  const route = recoveryItemsRoutes.find((candidate) => {
    if (candidate.method !== "POST") return false;
    return typeof candidate.match === "string"
      ? candidate.match === "/recovery/items/ri_1/evidence/deliver"
      : candidate.match("/recovery/items/ri_1/evidence/deliver");
  });
  if (!route) throw new Error("route not found: POST /recovery/items/:id/evidence/deliver");
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

async function callEvidence(url: string, res: CapturedRes) {
  const route = findEvidenceRoute();
  return route.handler({ req: { url } as never, res: res as never, auth: auth as never });
}

async function callEvidenceDeliver(body: unknown, url = "/recovery/items/ri_1/evidence/deliver") {
  const route = findEvidenceDeliverRoute();
  const req = Readable.from([JSON.stringify(body)]) as never as NodeJS.ReadableStream & { url?: string };
  req.url = url;
  return route.handler({ req: req as never, res: makeRes() as never, auth: auth as never });
}

const bundle = {
  recoveryItem: {
    id: "ri_1",
    deadLetterId: "dlq_1",
    workflowId: "wf_billing",
    owner: null,
    severity: "p2",
    status: "resolved",
    slaTargetAt: new Date("2026-05-20T16:00:00Z"),
    resolutionReason: "fixed_by_patch",
    resolvedBy: "user-1",
    resolvedAt: new Date("2026-05-20T11:30:00Z"),
    errorSignature: "HTTP 401 on http node",
    occurrenceCount: 1,
    comments: [],
    createdAt: new Date("2026-05-20T09:00:00Z"),
    updatedAt: new Date("2026-05-20T11:30:00Z"),
  },
  deadLetter: { id: "dlq_1", runId: "run_orig", nodeId: "call_api", attempt: 3, status: "open", workflowJson: {}, nodeJson: {}, errorJson: {}, replayedAt: null, createdAt: new Date() },
  originalRun: null,
  originalRunNodes: [],
  originalRunEvents: [],
  originalRunEventsTruncated: false,
  validationRun: { id: "run_val" },
  validationRunNodes: [],
  auditRows: [],
  rollback: null,
} as never;

const report = {
  markdown: "# Recovery Evidence Report — ri_1\n\n## Incident\n",
  json: {
    generatedAt: "2026-05-20T12:00:00.000Z",
    incident: { recoveryItemId: "ri_1", workflowId: "wf_billing", severity: "p2", status: "resolved", failureSignature: "HTTP 401 on http node" },
    patchDiff: { summary: { totalChanges: 2 } },
    sandboxValidation: { validationRunId: "run_val", status: "succeeded" },
    auditTrail: [{ action: "recovery.item.resolved" }, { action: "ai.workflow.patch_suggested" }],
  },
} as never;

beforeEach(() => {
  resolveEvidenceMock.mockReset();
  buildEvidenceMock.mockReset();
  auditMock.mockReset();
  sendJsonMock.mockClear();
  executeToolMocked.mockReset();
  enforceRateLimitMocked.mockReset();
  enforceRateLimitMocked.mockResolvedValue(undefined);
  auditMock.mockResolvedValue(undefined);
  resolveEvidenceMock.mockResolvedValue(bundle);
  buildEvidenceMock.mockReturnValue(report);
});

describe("POST /recovery/items/:id/evidence", () => {
  it("scopes the resolver to auth.orgId (tenant isolation)", async () => {
    const res = makeRes();
    await callEvidence("/recovery/items/ri_1/evidence", res);
    expect(resolveEvidenceMock).toHaveBeenCalledWith("org-1", "ri_1");
  });

  it("404s uniformly when the recovery item is absent / cross-org", async () => {
    resolveEvidenceMock.mockResolvedValue(null);
    const res = makeRes();
    const result = (await callEvidence("/recovery/items/ri_unknown/evidence", res)) as { status?: number; payload?: { code?: string } };
    expect(result.status).toBe(404);
    expect(result.payload?.code).toBe("recovery_item_not_found");
    // No artefact built, no audit row, no body streamed.
    expect(buildEvidenceMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("defaults to JSON and streams the structured envelope as an attachment", async () => {
    const res = makeRes();
    await callEvidence("/recovery/items/ri_1/evidence", res);
    expect(res.status).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("application/json");
    expect(res.headers?.["Content-Disposition"]).toContain("attachment");
    expect(res.headers?.["Content-Disposition"]).toContain(".json");
    expect(res.headers?.["Access-Control-Expose-Headers"]).toBe("Content-Disposition, X-Request-Id");
    expect(JSON.parse(res.body ?? "{}").incident.recoveryItemId).toBe("ri_1");
  });

  it("streams Markdown when ?format=markdown", async () => {
    const res = makeRes();
    await callEvidence("/recovery/items/ri_1/evidence?format=markdown", res);
    expect(res.status).toBe(200);
    expect(res.headers?.["Content-Type"]).toBe("text/markdown; charset=utf-8");
    expect(res.headers?.["Content-Disposition"]).toContain(".md");
    expect(res.body).toContain("# Recovery Evidence Report");
  });

  it("rejects an unknown format with 400", async () => {
    const res = makeRes();
    const result = (await callEvidence("/recovery/items/ri_1/evidence?format=pdf", res)) as { status?: number };
    expect(result.status).toBe(400);
    expect(resolveEvidenceMock).not.toHaveBeenCalled();
  });

  it("writes a report.evidence.exported audit row with the right target + metadata", async () => {
    const res = makeRes();
    await callEvidence("/recovery/items/ri_1/evidence", res);
    expect(auditMock).toHaveBeenCalledTimes(1);
    const [orgId, userId, action, targetType, targetId, metadata] = auditMock.mock.calls[0] as [
      string, string, string, string, string, Record<string, unknown>,
    ];
    expect(orgId).toBe("org-1");
    expect(userId).toBe("user-1");
    expect(action).toBe("report.evidence.exported");
    expect(targetType).toBe("recovery-item");
    expect(targetId).toBe("ri_1");
    expect(metadata.format).toBe("json");
    expect(metadata.deadLetterId).toBe("dlq_1");
    expect(metadata.runId).toBe("run_orig");
    expect(metadata.validationRunId).toBe("run_val");
    expect(metadata.hasPatchDiff).toBe(true);
    expect(metadata.auditRowCount).toBe(2);
  });

  it("declares editor role + recovery.read permission (defense in depth)", () => {
    const route = findEvidenceRoute();
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("recovery.read");
  });
});


describe("POST /recovery/items/:id/evidence/deliver", () => {
  it("declares editor role + recovery.read permission (defense in depth)", () => {
    const route = findEvidenceDeliverRoute();
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("recovery.read");
  });

  it("scopes the evidence resolver to auth.orgId and dispatches through the shared tool chokepoint", async () => {
    executeToolMocked.mockResolvedValueOnce({ ok: false, error: "credential secret missing for ops", latencyMs: 5 });

    const result = (await callEvidenceDeliver({
      destination: { kind: "slack", credentialName: "ops" },
    })) as { payload?: { ok?: boolean; error?: string; destination?: string }; status?: number };

    expect(enforceRateLimitMocked).toHaveBeenCalledWith("org-1", expect.objectContaining({ name: "reports.deliver" }));
    expect(resolveEvidenceMock).toHaveBeenCalledWith("org-1", "ri_1");
    expect(executeToolMocked).toHaveBeenCalledWith(
      "slack.post",
      expect.objectContaining({ credential: "ops", text: expect.stringContaining("Janusly incident evidence") }),
      {},
      { orgId: "org-1", runId: "run_orig" },
    );
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({ ok: false, error: "credential secret missing for ops", destination: "slack" });
  });

  it("writes report.evidence.delivered audit rows for failed delivery without leaking env var names", async () => {
    executeToolMocked.mockResolvedValueOnce({ ok: false, error: "credential secret missing for ops", latencyMs: 5 });

    await callEvidenceDeliver({ destination: { kind: "slack", credentialName: "ops" } });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [orgId, userId, action, targetType, targetId, metadata] = auditMock.mock.calls[0] as [
      string, string, string, string, string, Record<string, unknown>,
    ];
    expect(orgId).toBe("org-1");
    expect(userId).toBe("user-1");
    expect(action).toBe("report.evidence.delivered");
    expect(targetType).toBe("recovery-item");
    expect(targetId).toBe("ri_1");
    expect(metadata).toMatchObject({
      destination: "slack",
      ok: false,
      error: "credential secret missing for ops",
      latencyMs: 5,
      deadLetterId: "dlq_1",
      workflowId: "wf_billing",
      runId: "run_orig",
      credentialName: "ops",
    });
    expect(JSON.stringify(metadata)).not.toContain("SECRET");
  });

  it("404s uniformly when the recovery item is absent / cross-org", async () => {
    resolveEvidenceMock.mockResolvedValue(null);

    const result = (await callEvidenceDeliver({
      destination: { kind: "slack", credentialName: "ops" },
    }, "/recovery/items/ri_unknown/evidence/deliver")) as { status?: number; payload?: { code?: string } };

    expect(result.status).toBe(404);
    expect(result.payload?.code).toBe("recovery_item_not_found");
    expect(executeToolMocked).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
