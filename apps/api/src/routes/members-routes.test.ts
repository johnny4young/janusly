/**
 * Tests for org-member mutating routes.
 *
 * The two admin-only handlers (`POST /members/role` and
 * `DELETE /members`) MUST reject a request whose `userId` equals the
 * actor's own. Without that guard, an admin can demote themselves to
 * viewer or remove themselves from the org and lock a single-admin
 * org out unrecoverably. The mutating repo / db calls are mocked so
 * the gate is observable in isolation: the "still works" cases prove
 * the new check is a strictly narrower predicate (only the actor's
 * own row is blocked) while admin-on-admin operations stay byte-for-
 * byte equivalent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateWhere = vi.fn();
const updateSet = vi.fn();
const dbUpdate = vi.fn();
const deleteWhere = vi.fn();
const dbDelete = vi.fn();
const dbSelect = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    update: (table: unknown) => dbUpdate(table),
    delete: (table: unknown) => dbDelete(table),
    select: () => dbSelect(),
  },
  orgMembers: { orgId: "org_id", userId: "user_id", role: "role", email: "email" },
}));

const getOrgRole = vi.fn();
vi.mock("@janusly/data/src/orgRolesRepo", () => ({
  getOrgRole: (...a: unknown[]) => getOrgRole(...a),
}));

vi.mock("@janusly/data/src/invitationsRepo", () => ({
  createInvitation: vi.fn(),
  findPendingInvitation: vi.fn(),
  listInvitationsByOrg: vi.fn(),
  revokeInvitation: vi.fn(),
}));

const auditMock = vi.fn();
vi.mock("../audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

beforeEach(() => {
  vi.resetModules();
  dbUpdate.mockReset();
  updateSet.mockReset();
  updateWhere.mockReset();
  dbDelete.mockReset();
  deleteWhere.mockReset();
  dbSelect.mockReset();
  getOrgRole.mockReset();
  auditMock.mockReset();
  auditMock.mockResolvedValue(undefined);
  // Default chainable shapes — `db.update(orgMembers).set(...).where(...)`
  // and `db.delete(orgMembers).where(...)` mirror the production calls.
  updateWhere.mockResolvedValue(undefined);
  updateSet.mockReturnValue({ where: updateWhere });
  dbUpdate.mockReturnValue({ set: updateSet });
  deleteWhere.mockResolvedValue(undefined);
  dbDelete.mockReturnValue({ where: deleteWhere });
  dbSelect.mockReturnValue({ from: () => ({ where: vi.fn().mockResolvedValue([]) }) });
});

afterEach(() => {
  vi.clearAllMocks();
});

type FakeRes = {
  headers: Record<string, string>;
  statusCode: number;
  bodyText: string;
  setHeader: (k: string, v: string) => void;
  getHeader: (k: string) => string | undefined;
  writeHead: (c: number, h?: Record<string, string>) => void;
  end: (p?: string) => void;
  write: (p: string) => void;
};

function fakeRes(): FakeRes {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    bodyText: "",
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    writeHead(c, h) { this.statusCode = c; if (h) Object.assign(headers, h); },
    end(p) { if (p !== undefined) this.bodyText += p; },
    write(p) { this.bodyText += p; },
  };
}

function fakeReq(opts: { url: string; method?: string; body?: unknown }) {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = { data: [], end: [], error: [] };
  const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  const req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    on: (event: string, cb: (...a: unknown[]) => void) => typeof req;
    once: (event: string, cb: (...a: unknown[]) => void) => typeof req;
    destroy: () => void;
  } = {
    url: opts.url,
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json" },
    on(event, cb) { (listeners[event] ??= []).push(cb); return req; },
    once(event, cb) { return req.on(event, cb); },
    destroy() {},
  };
  queueMicrotask(() => {
    if (bodyText) for (const cb of listeners.data) cb(Buffer.from(bodyText));
    for (const cb of listeners.end) cb();
  });
  return req;
}

async function loadRoutes() {
  const mod = await import("./members-routes");
  return mod.membersRoutes;
}

function findRoute(routes: Awaited<ReturnType<typeof loadRoutes>>, method: string, url: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.match === "string") {
      if (route.match === url || url.startsWith(route.match + "?")) return route;
    } else if (route.match(url)) {
      return route;
    }
  }
  throw new Error(`route not found: ${method} ${url}`);
}

const ADMIN_AUTH = { orgId: "org-a", userId: "admin-1", mode: "dev-headers" as const, source: "dev" as const };

describe("GET /members route gate", () => {
  it("declares viewer role plus members.read permission", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/members");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("members.read");
  });
});

describe("POST /members/role self-modification guard", () => {
  it("rejects when the body userId matches the actor and audits the attempt", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/members/role");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/members/role", method: "POST", body: { userId: "admin-1", role: "viewer" } }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.bodyText);
    expect(body.code).toBe("self_membership_modification");
    expect(body.error).toMatch(/own membership/i);
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "admin-1",
      "member.self_modification_blocked",
      "member",
      "admin-1",
      expect.objectContaining({ action: "role_set", attemptedRole: "viewer" }),
    );
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it("allows demoting another admin and emits the standard role-update audit", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/members/role");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/members/role", method: "POST", body: { userId: "admin-2", role: "viewer" } }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(dbUpdate).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({ role: "viewer" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "admin-1",
      "member.role.updated",
      "member",
      "admin-2",
      expect.objectContaining({ role: "viewer" }),
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "member.self_modification_blocked",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("DELETE /members self-modification guard", () => {
  it("rejects when the query userId matches the actor and audits the attempt", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "DELETE", "/members?userId=admin-1");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/members?userId=admin-1", method: "DELETE" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.bodyText);
    expect(body.code).toBe("self_membership_modification");
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "admin-1",
      "member.self_modification_blocked",
      "member",
      "admin-1",
      expect.objectContaining({ action: "remove" }),
    );
    expect(dbDelete).not.toHaveBeenCalled();
  });

  it("allows removing another admin and emits the standard member-removed audit", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "DELETE", "/members?userId=admin-2");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/members?userId=admin-2", method: "DELETE" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(dbDelete).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "admin-1",
      "member.removed",
      "member",
      "admin-2",
      expect.objectContaining({ actor: expect.objectContaining({ userId: "admin-1" }) }),
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "member.self_modification_blocked",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
