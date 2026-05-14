/**
 * Tests for the roles + permission-grants admin CRUD. Mocks the repo
 * + audit so the HTTP shape is tested in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOrgRole = vi.fn();
const listOrgRoles = vi.fn();
const createOrgRole = vi.fn();
const updateOrgRole = vi.fn();
const deleteOrgRole = vi.fn();
const countMembersInRole = vi.fn();

vi.mock("@janusly/data/src/orgRolesRepo", () => ({
  getOrgRole: (...a: unknown[]) => getOrgRole(...a),
  listOrgRoles: (...a: unknown[]) => listOrgRoles(...a),
  createOrgRole: (...a: unknown[]) => createOrgRole(...a),
  updateOrgRole: (...a: unknown[]) => updateOrgRole(...a),
  deleteOrgRole: (...a: unknown[]) => deleteOrgRole(...a),
  countMembersInRole: (...a: unknown[]) => countMembersInRole(...a),
}));

const auditMock = vi.fn();
vi.mock("./audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));

beforeEach(() => {
  vi.resetModules();
  getOrgRole.mockReset();
  listOrgRoles.mockReset();
  createOrgRole.mockReset();
  updateOrgRole.mockReset();
  deleteOrgRole.mockReset();
  countMembersInRole.mockReset();
  auditMock.mockReset();
  auditMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
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
  const mod = await import("./routes/roles-routes");
  return mod.rolesRoutes;
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

describe("GET /org/permissions/catalog", () => {
  it("returns the closed catalog + mandatory-admin permissions", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/org/permissions/catalog");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/permissions/catalog" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    const body = JSON.parse(res.bodyText);
    expect(Array.isArray(body.catalog)).toBe(true);
    expect(body.catalog.length).toBeGreaterThan(0);
    expect(body.mandatoryAdminPermissions).toContain("org.permissions.write");
    expect(body.mandatoryAdminPermissions).toContain("members.write");
  });
});

describe("GET /org/roles", () => {
  it("returns built-ins with default permissions when no override rows exist", async () => {
    listOrgRoles.mockResolvedValueOnce([]);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/org/roles");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    const body = JSON.parse(res.bodyText);
    expect(body.roles).toHaveLength(3);
    expect(body.roles.map((r: { name: string }) => r.name).sort()).toEqual(["admin", "editor", "viewer"]);
    const editor = body.roles.find((r: { name: string }) => r.name === "editor");
    expect(editor.isOverride).toBe(false);
    expect(editor.grantedPermissions).toContain("workflows.write");
  });

  it("surfaces an override on a built-in plus a custom role in the same list", async () => {
    listOrgRoles.mockResolvedValueOnce([
      {
        id: "r-1", orgId: "org-a", name: "editor", inheritsFrom: "editor",
        description: null, isBuiltin: true, grantedPermissions: ["workflows.read"],
        createdBy: null, updatedBy: null, createdAt: null, updatedAt: null,
      },
      {
        id: "r-2", orgId: "org-a", name: "compliance", inheritsFrom: "viewer",
        description: "audit only", isBuiltin: false, grantedPermissions: ["reports.read"],
        createdBy: null, updatedBy: null, createdAt: null, updatedAt: null,
      },
    ]);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/org/roles");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    const body = JSON.parse(res.bodyText);
    const editor = body.roles.find((r: { name: string }) => r.name === "editor");
    expect(editor.isOverride).toBe(true);
    expect(editor.grantedPermissions).toEqual(["workflows.read"]);
    const compliance = body.roles.find((r: { name: string }) => r.name === "compliance");
    expect(compliance.isBuiltin).toBe(false);
    expect(compliance.inheritsFrom).toBe("viewer");
  });
});

describe("POST /org/roles (create custom)", () => {
  it("creates a custom role with valid input and audits", async () => {
    getOrgRole.mockResolvedValueOnce(null);
    createOrgRole.mockResolvedValueOnce({
      id: "r-new", orgId: "org-a", name: "compliance", inheritsFrom: "viewer",
      description: null, isBuiltin: false, grantedPermissions: ["reports.read"],
      createdBy: "admin-1", updatedBy: "admin-1", createdAt: null, updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/roles");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/roles",
        method: "POST",
        body: { name: "compliance", inheritsFrom: "viewer", grantedPermissions: ["reports.read"] },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(createOrgRole).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-a", name: "compliance", inheritsFrom: "viewer", isBuiltin: false,
    }));
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.role.created", "org_role", "r-new",
      expect.objectContaining({ name: "compliance" }),
    );
  });

  it("defaults inheritsFrom to viewer (fail-closed) when omitted", async () => {
    getOrgRole.mockResolvedValueOnce(null);
    createOrgRole.mockResolvedValueOnce({ id: "r-new", orgId: "org-a", name: "compliance", inheritsFrom: "viewer", description: null, isBuiltin: false, grantedPermissions: [], createdBy: null, updatedBy: null, createdAt: null, updatedAt: null });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/roles");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles", method: "POST", body: { name: "compliance", grantedPermissions: [] } }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(createOrgRole).toHaveBeenCalledWith(expect.objectContaining({ inheritsFrom: "viewer" }));
  });

  it("rejects invalid name format", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/roles");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles", method: "POST", body: { name: "Has Spaces", grantedPermissions: [] } }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(createOrgRole).not.toHaveBeenCalled();
  });

  it("rejects built-in names (use the update endpoint to override built-ins)", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/roles");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles", method: "POST", body: { name: "editor", grantedPermissions: [] } }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid permission keys", async () => {
    getOrgRole.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/roles");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles", method: "POST", body: { name: "compliance", grantedPermissions: ["totally.fake"] } }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /org/roles/:name (update / override)", () => {
  it("coerces the admin floor when admin built-in is updated to omit mandatory permissions", async () => {
    getOrgRole.mockResolvedValueOnce(null); // first call: no row → first-time override
    createOrgRole.mockResolvedValueOnce({
      id: "r-admin-override", orgId: "org-a", name: "admin", inheritsFrom: "admin",
      description: null, isBuiltin: true,
      grantedPermissions: ["workflows.write", "org.permissions.write", "members.write"],
      createdBy: "admin-1", updatedBy: "admin-1", createdAt: null, updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/roles/admin");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/roles/admin",
        method: "POST",
        body: { grantedPermissions: ["workflows.write"] },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    // createOrgRole called with mandatory floor merged in
    const callArg = createOrgRole.mock.calls[0][0] as { grantedPermissions: string[] };
    expect(callArg.grantedPermissions).toContain("org.permissions.write");
    expect(callArg.grantedPermissions).toContain("members.write");
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.permissions.override_set", "org_role", "r-admin-override",
      expect.objectContaining({ coerced: expect.arrayContaining(["org.permissions.write", "members.write"]) }),
    );
  });

  it("rejects inheritsFrom changes on built-in roles", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/roles/editor");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles/editor", method: "POST", body: { inheritsFrom: "admin" } }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when updating a custom role that doesn't exist", async () => {
    getOrgRole.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/roles/nonexistent");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles/nonexistent", method: "POST", body: { grantedPermissions: [] } }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /org/roles/:name", () => {
  it("hard-deletes a custom role with no active members", async () => {
    getOrgRole.mockResolvedValueOnce({
      id: "r-1", orgId: "org-a", name: "compliance", inheritsFrom: "viewer", isBuiltin: false,
      description: null, grantedPermissions: [], createdBy: null, updatedBy: null, createdAt: null, updatedAt: null,
    });
    countMembersInRole.mockResolvedValueOnce(0);
    const routes = await loadRoutes();
    const route = findRoute(routes, "DELETE", "/org/roles/compliance");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles/compliance", method: "DELETE" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(deleteOrgRole).toHaveBeenCalledWith({ orgId: "org-a", name: "compliance" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.role.deleted", "org_role", "r-1",
      expect.objectContaining({ name: "compliance" }),
    );
  });

  it("rejects deletion of a custom role with active members (409 + count)", async () => {
    getOrgRole.mockResolvedValueOnce({
      id: "r-1", orgId: "org-a", name: "compliance", inheritsFrom: "viewer", isBuiltin: false,
      description: null, grantedPermissions: [], createdBy: null, updatedBy: null, createdAt: null, updatedAt: null,
    });
    countMembersInRole.mockResolvedValueOnce(3);
    const routes = await loadRoutes();
    const route = findRoute(routes, "DELETE", "/org/roles/compliance");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles/compliance", method: "DELETE" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.bodyText);
    expect(body.membersAffected).toBe(3);
    expect(deleteOrgRole).not.toHaveBeenCalled();
  });

  it("DELETE on a built-in name reverts the override (deletes the override row)", async () => {
    getOrgRole.mockResolvedValueOnce({
      id: "r-1", orgId: "org-a", name: "editor", inheritsFrom: "editor", isBuiltin: true,
      description: null, grantedPermissions: ["workflows.read"], createdBy: null, updatedBy: null, createdAt: null, updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "DELETE", "/org/roles/editor");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles/editor", method: "DELETE" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(deleteOrgRole).toHaveBeenCalledWith({ orgId: "org-a", name: "editor" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.permissions.override_cleared", "org_role", "r-1",
      expect.objectContaining({ name: "editor" }),
    );
  });

  it("DELETE on a built-in with no override returns 404", async () => {
    getOrgRole.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "DELETE", "/org/roles/admin");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/roles/admin", method: "DELETE" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(404);
  });
});
