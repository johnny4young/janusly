/**
 * Tests for the audit-log read route. The repo (`queryAuditLogs`) is mocked
 * so the route's parsing (action / cursor / limit), admin gate, and envelope
 * shape are tested in isolation from the DB. The keyset page-builder is
 * covered separately by `audit-pagination.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryAuditLogs = vi.fn();
vi.mock("@janusly/data/src/auditLogsRepo", () => ({
  queryAuditLogs: (...args: unknown[]) => queryAuditLogs(...args),
  AUDIT_LOG_PAGE_MAX: 200,
}));

type FakeRes = {
  statusCode: number;
  bodyText: string;
  setHeader: (k: string, v: string) => void;
  getHeader: (k: string) => string | undefined;
  writeHead: (code: number, hdrs?: Record<string, string>) => void;
  end: (payload?: string) => void;
  write: (payload: string) => void;
};

function fakeRes(): FakeRes {
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    bodyText: "",
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    writeHead(code) { this.statusCode = code; },
    end(payload) { if (payload !== undefined) this.bodyText += payload; },
    write(payload) { this.bodyText += payload; },
  };
}

function fakeReq(url: string) {
  return { url, method: "GET", headers: {}, on() { return this; }, once() { return this; }, destroy() {} };
}

async function loadRoutes() {
  const mod = await import("./audit-routes");
  return mod.auditRoutes;
}

const ADMIN_AUTH = { orgId: "org-a", userId: "admin-1", mode: "dev-headers" as const, source: "dev" as const };

beforeEach(() => {
  vi.resetModules();
  queryAuditLogs.mockReset();
  queryAuditLogs.mockResolvedValue({ rows: [], nextCursor: null, hasMore: false });
});

describe("GET /audit", () => {
  it("is admin-gated", async () => {
    const routes = await loadRoutes();
    const route = routes[0];
    expect(route?.role).toBe("admin");
  });

  it("defaults the limit and passes null action/cursor on a bare request", async () => {
    queryAuditLogs.mockResolvedValueOnce({
      rows: [{ id: "a1", action: "workflow.saved" }],
      nextCursor: null,
      hasMore: false,
    });
    const routes = await loadRoutes();
    const res = fakeRes();
    await routes[0]!.handler({ req: fakeReq("/audit") as never, res: res as never, auth: ADMIN_AUTH });
    expect(queryAuditLogs).toHaveBeenCalledWith("org-a", { action: null, cursor: null, limit: 100 });
    const body = JSON.parse(res.bodyText);
    expect(body.rows).toHaveLength(1);
    expect(body.hasMore).toBe(false);
  });

  it("parses ?action=, ?cursor=, and ?limit= and scopes to the caller's org", async () => {
    const routes = await loadRoutes();
    const res = fakeRes();
    await routes[0]!.handler({
      req: fakeReq("/audit?action=org.scim&cursor=2026-06-01T00:00:00.000Z|x1&limit=50") as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(queryAuditLogs).toHaveBeenCalledWith("org-a", {
      action: "org.scim",
      cursor: { createdAt: new Date("2026-06-01T00:00:00.000Z"), id: "x1" },
      limit: 50,
    });
  });

  it("clamps an over-large limit to the page max", async () => {
    const routes = await loadRoutes();
    const res = fakeRes();
    await routes[0]!.handler({
      req: fakeReq("/audit?limit=9999") as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(queryAuditLogs).toHaveBeenCalledWith("org-a", expect.objectContaining({ limit: 200 }));
  });
});
