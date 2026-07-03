/**
 * Tests for GET /billing/usage/export — the CSV usage rollup. The
 * `getUsageBreakdown` engine query and `auditAction` are mocked so the
 * route's CSV serialization, dimension parsing, headers, and audit write are
 * tested in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getUsageBreakdownMock = vi.fn();
const auditActionMock = vi.fn();

vi.mock("@janusly/engine/src/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@janusly/engine/src/billing")>();
  return { ...actual, getUsageBreakdown: (...a: unknown[]) => getUsageBreakdownMock(...a) };
});
vi.mock("@janusly/engine/src/budget", () => ({ checkBudget: vi.fn() }));
vi.mock("@janusly/data", () => ({ getWorkflowBudget: vi.fn(), upsertWorkflowBudget: vi.fn() }));
vi.mock("@janusly/db", () => ({ db: {}, workflows: {} }));
vi.mock("../audit-helper", () => ({ auditAction: (...a: unknown[]) => auditActionMock(...a) }));

import { billingRoutes } from "./billing-routes";
import type { Route } from "../routes";
import type { AuthContext } from "../auth";

const auth = { orgId: "org-1", userId: "u1", mode: "dev-headers", source: "dev" } as AuthContext;

function findRoute(url: string): Route {
  const r = billingRoutes.find((x) => x.method === "GET" && (typeof x.match === "string" ? x.match === url : x.match(url)));
  if (!r) throw new Error(`no route for ${url}`);
  return r;
}

function mockRes() {
  const captured: { status: number; headers: Record<string, string>; body: string } = { status: 0, headers: {}, body: "" };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) { captured.status = status; Object.assign(captured.headers, headers ?? {}); return res; },
    setHeader(k: string, v: string) { captured.headers[k] = v; },
    getHeader(k: string) { return captured.headers[k]; },
    end(body?: string) { if (typeof body === "string") captured.body += body; },
    write(body: string) { captured.body += body; },
    writableEnded: false,
  } as never;
  return { res, captured };
}

const req = { url: "/billing/usage/export", method: "GET", headers: {} } as never;

beforeEach(() => {
  getUsageBreakdownMock.mockReset();
  auditActionMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("GET /billing/usage/export", () => {
  it("streams a CSV with the header + one row per bucket and a download disposition", async () => {
    getUsageBreakdownMock.mockResolvedValueOnce([
      { key: "k1", workflow: "wf-1", model: "claude-haiku-4-5-20251001", day: "2026-07-01", quantity: 1200, callCount: 4, fallbackCount: 1, costUsd: 0.012, latency: { p50Ms: 300, p95Ms: 900, avgMs: 420 } },
      { key: "k2", workflow: "wf-2", model: "claude-haiku-4-5-20251001", day: "2026-07-02", quantity: 50, callCount: 1, fallbackCount: 0, costUsd: null, latency: { p50Ms: null, p95Ms: null, avgMs: null } },
    ]);
    const { res, captured } = mockRes();
    await findRoute("/billing/usage/export").handler({ req, res, auth });

    expect(captured.status).toBe(200);
    expect(captured.headers["Content-Type"]).toContain("text/csv");
    expect(captured.headers["Content-Disposition"]).toMatch(/attachment; filename="janusly-usage-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = captured.body.trim().split("\r\n");
    expect(lines[0]).toBe("workflow,model,day,quantity,callCount,fallbackCount,costUsd,latencyP50Ms,latencyP95Ms,latencyAvgMs");
    expect(lines[1]).toBe("wf-1,claude-haiku-4-5-20251001,2026-07-01,1200,4,1,0.012,300,900,420");
    // Null costUsd / latency render as empty cells, never coerced to 0.
    expect(lines[2]).toBe("wf-2,claude-haiku-4-5-20251001,2026-07-02,50,1,0,,,,");
    // Default dimensions used when ?breakdown= omitted.
    expect(getUsageBreakdownMock).toHaveBeenCalledWith("org-1", ["workflow", "model", "day"]);
    expect(auditActionMock).toHaveBeenCalledWith(auth, "billing.usage.exported", expect.objectContaining({ metadata: expect.objectContaining({ rowCount: 2 }) }));
  });

  it("honors ?breakdown= and rejects an unknown dimension", async () => {
    const badReq = { url: "/billing/usage/export?breakdown=provider,bogus", method: "GET", headers: {} } as never;
    const sendErrorRes = mockRes();
    await findRoute("/billing/usage/export?breakdown=provider,bogus").handler({ req: badReq, res: sendErrorRes.res, auth });
    // The 400 goes through sendError → writeHead(400) with a JSON body carrying the code.
    expect(sendErrorRes.captured.status).toBe(400);
    expect(sendErrorRes.captured.body).toContain("billing_unknown_breakdown_dimension");
    expect(getUsageBreakdownMock).not.toHaveBeenCalled();
  });

  it("quotes CSV cells that contain commas or quotes (RFC 4180)", async () => {
    getUsageBreakdownMock.mockResolvedValueOnce([
      { key: "k", workflow: 'wf,"weird"', model: "m", day: "d", quantity: 1, callCount: 1, fallbackCount: 0, costUsd: 0, latency: { p50Ms: 1, p95Ms: 1, avgMs: 1 } },
    ]);
    const { res, captured } = mockRes();
    await findRoute("/billing/usage/export").handler({ req, res, auth });
    expect(captured.body).toContain('"wf,""weird"""');
  });
});
