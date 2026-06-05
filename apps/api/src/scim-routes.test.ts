/**
 * Tests for SCIM routes — admin CRUD + webhook receiver. Mocks the
 * repos + WorkOS verifier + handler so the route's HTTP shape is
 * tested in isolation from the data + event dispatch layers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const getScimDirectoryByOrgId = vi.fn();
const getScimDirectoryByProviderDirectoryId = vi.fn();
const getScimDirectoryById = vi.fn();
const listScimDirectories = vi.fn();
const createScimDirectory = vi.fn();
const updateScimDirectory = vi.fn();
const revokeScimDirectory = vi.fn();
const recordScimDirectorySync = vi.fn();
const getScimGroupState = vi.fn();
const listScimGroupState = vi.fn();
const listActiveScimUserState = vi.fn();
const findMemberByEmail = vi.fn();
// SCIM v2 group→role mapping repos
const listScimGroupRoleMappings = vi.fn();
const getScimGroupRoleMappingById = vi.fn();
const findScimGroupRoleMappingByGroup = vi.fn();
const createScimGroupRoleMapping = vi.fn();
const updateScimGroupRoleMapping = vi.fn();
const deleteScimGroupRoleMapping = vi.fn();
const getScimGroupRoleMappingsMap = vi.fn();
const listScimUserGroupIds = vi.fn();
const listScimUserIdsForGroup = vi.fn();
const addScimUserGroup = vi.fn();
const removeScimUserGroup = vi.fn();
const deleteScimUserGroupsForUser = vi.fn();
const deleteScimUserGroupsForGroup = vi.fn();

vi.mock("@janusly/data/src/scimDirectoriesRepo", () => ({
  getScimDirectoryByOrgId: (...args: unknown[]) => getScimDirectoryByOrgId(...args),
  getScimDirectoryByProviderDirectoryId: (...args: unknown[]) =>
    getScimDirectoryByProviderDirectoryId(...args),
  getScimDirectoryById: (...args: unknown[]) => getScimDirectoryById(...args),
  listScimDirectories: (...args: unknown[]) => listScimDirectories(...args),
  createScimDirectory: (...args: unknown[]) => createScimDirectory(...args),
  updateScimDirectory: (...args: unknown[]) => updateScimDirectory(...args),
  revokeScimDirectory: (...args: unknown[]) => revokeScimDirectory(...args),
  recordScimDirectorySync: (...args: unknown[]) => recordScimDirectorySync(...args),
}));

vi.mock("@janusly/data/src/scimUserStateRepo", () => ({
  getScimUserState: vi.fn().mockResolvedValue(null),
  upsertScimUserState: vi.fn().mockResolvedValue(null),
  markScimUserInactive: vi.fn().mockResolvedValue(undefined),
  listActiveScimUserState: (...args: unknown[]) => listActiveScimUserState(...args),
  SCIM_RESYNC_MAX_MEMBERS: 5000,
}));
vi.mock("@janusly/data/src/scimGroupStateRepo", () => ({
  SCIM_GROUP_STATE_DEFAULT_LIMIT: 100,
  SCIM_GROUP_STATE_MAX_LIMIT: 200,
  upsertScimGroupState: vi.fn().mockResolvedValue(null),
  deleteScimGroupState: vi.fn().mockResolvedValue(undefined),
  getScimGroupState: (...args: unknown[]) => getScimGroupState(...args),
  listScimGroupState: (...args: unknown[]) => listScimGroupState(...args),
}));
vi.mock("@janusly/data/src/scimGroupRoleMappingsRepo", () => ({
  listScimGroupRoleMappings: (...args: unknown[]) => listScimGroupRoleMappings(...args),
  getScimGroupRoleMappingById: (...args: unknown[]) => getScimGroupRoleMappingById(...args),
  findScimGroupRoleMappingByGroup: (...args: unknown[]) => findScimGroupRoleMappingByGroup(...args),
  createScimGroupRoleMapping: (...args: unknown[]) => createScimGroupRoleMapping(...args),
  updateScimGroupRoleMapping: (...args: unknown[]) => updateScimGroupRoleMapping(...args),
  deleteScimGroupRoleMapping: (...args: unknown[]) => deleteScimGroupRoleMapping(...args),
  getScimGroupRoleMappingsMap: (...args: unknown[]) => getScimGroupRoleMappingsMap(...args),
}));
vi.mock("@janusly/data/src/scimUserGroupsRepo", () => ({
  listScimUserGroupIds: (...args: unknown[]) => listScimUserGroupIds(...args),
  listScimUserIdsForGroup: (...args: unknown[]) => listScimUserIdsForGroup(...args),
  addScimUserGroup: (...args: unknown[]) => addScimUserGroup(...args),
  removeScimUserGroup: (...args: unknown[]) => removeScimUserGroup(...args),
  deleteScimUserGroupsForUser: (...args: unknown[]) => deleteScimUserGroupsForUser(...args),
  deleteScimUserGroupsForGroup: (...args: unknown[]) => deleteScimUserGroupsForGroup(...args),
}));
vi.mock("@janusly/data/src/scimProcessedEventsRepo", () => ({
  recordProcessedEvent: vi.fn().mockResolvedValue({ fresh: true }),
  deleteProcessedEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@janusly/data/src/orgMembersRepo", () => ({
  upsertMembershipByEmail: vi.fn().mockResolvedValue({ id: "m-1" }),
  deleteMembership: vi.fn().mockResolvedValue(1),
  findMemberByEmail: (...args: unknown[]) => findMemberByEmail(...args),
}));
vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getAuthPolicyConfig: vi.fn().mockResolvedValue({
    allowedEmailDomains: [],
    mfaRequired: false,
    sessionTtlSeconds: 28800,
  }),
}));

const auditMock = vi.fn();
vi.mock("./audit", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

const SECRET = "test-webhook-secret";

beforeEach(() => {
  vi.resetModules();
  getScimDirectoryByOrgId.mockReset();
  getScimDirectoryByProviderDirectoryId.mockReset();
  getScimDirectoryById.mockReset();
  listScimDirectories.mockReset();
  createScimDirectory.mockReset();
  updateScimDirectory.mockReset();
  revokeScimDirectory.mockReset();
  recordScimDirectorySync.mockReset();
  getScimGroupState.mockReset();
  listScimGroupState.mockReset();
  listActiveScimUserState.mockReset();
  findMemberByEmail.mockReset();
  listScimGroupRoleMappings.mockReset();
  getScimGroupRoleMappingById.mockReset();
  findScimGroupRoleMappingByGroup.mockReset();
  createScimGroupRoleMapping.mockReset();
  updateScimGroupRoleMapping.mockReset();
  deleteScimGroupRoleMapping.mockReset();
  getScimGroupRoleMappingsMap.mockReset();
  listScimUserGroupIds.mockReset();
  listScimUserIdsForGroup.mockReset();
  addScimUserGroup.mockReset();
  removeScimUserGroup.mockReset();
  deleteScimUserGroupsForUser.mockReset();
  deleteScimUserGroupsForGroup.mockReset();
  auditMock.mockReset();
  auditMock.mockResolvedValue(undefined);
  recordScimDirectorySync.mockResolvedValue(undefined);
  // Safe defaults so webhook dispatch of a user.created event (which now
  // runs role derivation) doesn't touch the real DB; CRUD tests override.
  getScimGroupState.mockResolvedValue(null);
  getScimGroupRoleMappingsMap.mockResolvedValue(new Map());
  listScimUserGroupIds.mockResolvedValue([]);
  listScimUserIdsForGroup.mockResolvedValue([]);
  addScimUserGroup.mockResolvedValue(undefined);
  removeScimUserGroup.mockResolvedValue(undefined);
  deleteScimUserGroupsForUser.mockResolvedValue(undefined);
  deleteScimUserGroupsForGroup.mockResolvedValue(undefined);
  listScimGroupState.mockResolvedValue([]);
  listActiveScimUserState.mockResolvedValue([]);
  findMemberByEmail.mockResolvedValue(null);
  vi.stubEnv("WORKOS_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type FakeRes = {
  headers: Record<string, string>;
  statusCode: number;
  bodyText: string;
  setHeader: (key: string, value: string) => void;
  getHeader: (key: string) => string | undefined;
  writeHead: (code: number, hdrs?: Record<string, string>) => void;
  end: (payload?: string) => void;
  write: (payload: string) => void;
};

function fakeRes(): FakeRes {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    bodyText: "",
    setHeader(key, value) { headers[key.toLowerCase()] = value; },
    getHeader(key) { return headers[key.toLowerCase()]; },
    writeHead(code, hdrs) {
      this.statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    },
    end(payload) { if (payload !== undefined) this.bodyText += payload; },
    write(payload) { this.bodyText += payload; },
  };
}

function fakeReq(opts: {
  url: string;
  method?: string;
  rawBody?: string;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = { data: [], end: [], error: [] };
  const bodyText = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : "");
  const req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    on: (event: string, cb: (...args: unknown[]) => void) => typeof req;
    once: (event: string, cb: (...args: unknown[]) => void) => typeof req;
    destroy: () => void;
  } = {
    url: opts.url,
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    on(event, cb) { (listeners[event] ??= []).push(cb); return req; },
    once(event, cb) { return req.on(event, cb); },
    destroy() {},
  };
  queueMicrotask(() => {
    if (bodyText) {
      for (const cb of listeners.data) cb(Buffer.from(bodyText));
    }
    for (const cb of listeners.end) cb();
  });
  return req;
}

async function loadRoutes() {
  const mod = await import("./routes/scim-routes");
  return mod.scimRoutes;
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

function signedHeader(body: string): string {
  const t = Date.now();
  const hex = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${hex}`;
}

const ADMIN_AUTH = { orgId: "org-a", userId: "admin-1", mode: "dev-headers" as const, source: "dev" as const };

describe("SCIM admin CRUD", () => {
  it("POST /org/scim/directories creates a row and audits org.scim.directory_attached", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(null);
    createScimDirectory.mockResolvedValueOnce({
      id: "sd-1",
      orgId: "org-a",
      providerDirectoryId: "directory_01",
      directoryType: "okta_scim",
      defaultRole: "editor",
      status: "active",
      lastSyncedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/directories");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/directories",
        method: "POST",
        body: { providerDirectoryId: "directory_01", directoryType: "okta_scim", defaultRole: "editor" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(createScimDirectory).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-a",
      providerDirectoryId: "directory_01",
      defaultRole: "editor",
    }));
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "admin-1",
      "org.scim.directory_attached",
      "scim_directory",
      "sd-1",
      expect.objectContaining({ defaultRole: "editor" }),
    );
  });

  it("POST /org/scim/directories rejects duplicate with 409", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce({
      id: "sd-existing",
      orgId: "org-a",
      providerDirectoryId: "directory_01",
      directoryType: null,
      defaultRole: "viewer",
      status: "active",
      lastSyncedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/directories");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/directories",
        method: "POST",
        body: { providerDirectoryId: "directory_02" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(createScimDirectory).not.toHaveBeenCalled();
  });

  it("PATCH (POST :id) updates defaultRole and audits", async () => {
    getScimDirectoryById.mockResolvedValueOnce({
      id: "sd-1",
      orgId: "org-a",
      providerDirectoryId: "directory_01",
      directoryType: null,
      defaultRole: "viewer",
      status: "active",
      lastSyncedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    updateScimDirectory.mockResolvedValueOnce({
      id: "sd-1",
      orgId: "org-a",
      providerDirectoryId: "directory_01",
      directoryType: null,
      defaultRole: "editor",
      status: "active",
      lastSyncedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/directories/sd-1");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/directories/sd-1",
        method: "POST",
        body: { defaultRole: "editor" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(updateScimDirectory).toHaveBeenCalledWith(expect.objectContaining({
      id: "sd-1", orgId: "org-a", defaultRole: "editor",
    }));
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.scim.directory_updated", "scim_directory", "sd-1",
      expect.objectContaining({ defaultRole: "editor" }),
    );
  });

  it("rejects status updates so revoke keeps the hard-delete reattach path", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/directories/sd-1");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/directories/sd-1",
        method: "POST",
        body: { status: "revoked" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(updateScimDirectory).not.toHaveBeenCalled();
  });

  it("DELETE hard-revokes and audits", async () => {
    getScimDirectoryById.mockResolvedValueOnce({
      id: "sd-1",
      orgId: "org-a",
      providerDirectoryId: "directory_01",
      directoryType: null,
      defaultRole: "viewer",
      status: "active",
      lastSyncedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    revokeScimDirectory.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "DELETE", "/org/scim/directories/sd-1");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/directories/sd-1", method: "DELETE" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(revokeScimDirectory).toHaveBeenCalledWith({ id: "sd-1", orgId: "org-a" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.scim.directory_revoked", "scim_directory", "sd-1", expect.any(Object),
    );
  });

  it("GET lists scoped to org", async () => {
    listScimDirectories.mockResolvedValueOnce([
      { id: "sd-1", orgId: "org-a", providerDirectoryId: "d1", directoryType: null, defaultRole: "viewer", status: "active", lastSyncedAt: null, createdAt: null, updatedAt: null },
    ]);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/org/scim/directories");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/directories" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(listScimDirectories).toHaveBeenCalledWith("org-a");
    expect(JSON.parse(res.bodyText)).toHaveLength(1);
  });
});

describe("SCIM synced groups", () => {
  const dirRow = {
    id: "sd-1",
    orgId: "org-a",
    providerDirectoryId: "directory_01",
    directoryType: null,
    defaultRole: "viewer" as const,
    status: "active" as const,
    lastSyncedAt: null,
    createdAt: null,
    updatedAt: null,
  };

  it("GET returns [] when no directory is attached", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/org/scim/groups");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/groups" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(JSON.parse(res.bodyText)).toEqual([]);
    expect(listScimGroupState).not.toHaveBeenCalled();
  });

  it("GET lists synced groups scoped to the org directory", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(dirRow);
    listScimGroupState.mockResolvedValueOnce([
      { id: "g1", orgId: "org-a", scimDirectoryId: "sd-1", providerGroupId: "dg1", name: "Engineering", lastSyncedAt: null },
    ]);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/org/scim/groups");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/groups" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(listScimGroupState).toHaveBeenCalledWith("org-a", "sd-1", 100);
    expect(JSON.parse(res.bodyText)).toHaveLength(1);
  });

  it("GET caps the requested group list limit", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(dirRow);
    listScimGroupState.mockResolvedValueOnce([]);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/org/scim/groups?limit=9999");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/groups?limit=9999" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(listScimGroupState).toHaveBeenCalledWith("org-a", "sd-1", 200);
  });
});

describe("SCIM group role mapping CRUD", () => {
  const dirRow = {
    id: "sd-1",
    orgId: "org-a",
    providerDirectoryId: "directory_01",
    directoryType: null,
    defaultRole: "viewer" as const,
    status: "active" as const,
    lastSyncedAt: null,
    createdAt: null,
    updatedAt: null,
  };
  const mappingRow = {
    id: "m-1",
    orgId: "org-a",
    scimDirectoryId: "sd-1",
    providerGroupId: "directory_group_1",
    role: "editor",
    createdBy: "admin-1",
    updatedBy: "admin-1",
    createdAt: null,
    updatedAt: null,
  };

  it("GET returns [] when no directory is attached", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/org/scim/group-role-mappings");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/group-role-mappings" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(JSON.parse(res.bodyText)).toEqual([]);
    expect(listScimGroupRoleMappings).not.toHaveBeenCalled();
  });

  it("GET lists mappings scoped to org + directory", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(dirRow);
    listScimGroupRoleMappings.mockResolvedValueOnce([mappingRow]);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/org/scim/group-role-mappings");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/group-role-mappings" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(listScimGroupRoleMappings).toHaveBeenCalledWith("org-a", "sd-1");
    expect(JSON.parse(res.bodyText)).toHaveLength(1);
  });

  it("POST creates a mapping and audits org.scim.group_role_mapping_created", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(dirRow);
    getScimGroupState.mockResolvedValueOnce({ id: "grp_state_1" });
    findScimGroupRoleMappingByGroup.mockResolvedValueOnce(null);
    createScimGroupRoleMapping.mockResolvedValueOnce(mappingRow);
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/group-role-mappings");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/group-role-mappings",
        method: "POST",
        body: { providerGroupId: "directory_group_1", role: "editor" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(createScimGroupRoleMapping).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-a",
      scimDirectoryId: "sd-1",
      providerGroupId: "directory_group_1",
      role: "editor",
      createdBy: "admin-1",
    }));
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.scim.group_role_mapping_created", "scim_group_role_mapping", "m-1",
      expect.objectContaining({ providerGroupId: "directory_group_1", role: "editor" }),
    );
  });

  it("POST rejects an invalid role with 400", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(dirRow);
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/group-role-mappings");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/group-role-mappings",
        method: "POST",
        body: { providerGroupId: "directory_group_1", role: "superuser" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(createScimGroupRoleMapping).not.toHaveBeenCalled();
  });

  it("POST rejects an unknown group with 404", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(dirRow);
    getScimGroupState.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/group-role-mappings");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/group-role-mappings",
        method: "POST",
        body: { providerGroupId: "directory_group_unknown", role: "editor" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(createScimGroupRoleMapping).not.toHaveBeenCalled();
  });

  it("POST rejects a duplicate mapping with 409", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(dirRow);
    getScimGroupState.mockResolvedValueOnce({ id: "grp_state_1" });
    findScimGroupRoleMappingByGroup.mockResolvedValueOnce(mappingRow);
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/group-role-mappings");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/group-role-mappings",
        method: "POST",
        body: { providerGroupId: "directory_group_1", role: "admin" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(createScimGroupRoleMapping).not.toHaveBeenCalled();
  });

  it("POST rejects with 409 when no directory is attached", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/group-role-mappings");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/group-role-mappings",
        method: "POST",
        body: { providerGroupId: "directory_group_1", role: "editor" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(createScimGroupRoleMapping).not.toHaveBeenCalled();
  });

  it("POST :id updates a mapping and audits before/after", async () => {
    getScimGroupRoleMappingById.mockResolvedValueOnce(mappingRow);
    updateScimGroupRoleMapping.mockResolvedValueOnce({ ...mappingRow, role: "admin" });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/group-role-mappings/m-1");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/group-role-mappings/m-1",
        method: "POST",
        body: { role: "admin" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(updateScimGroupRoleMapping).toHaveBeenCalledWith(expect.objectContaining({
      id: "m-1", orgId: "org-a", role: "admin", updatedBy: "admin-1",
    }));
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.scim.group_role_mapping_updated", "scim_group_role_mapping", "m-1",
      expect.objectContaining({ before: "editor", after: "admin" }),
    );
  });

  it("POST :id returns 404 when the mapping is missing", async () => {
    getScimGroupRoleMappingById.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/group-role-mappings/m-x");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/org/scim/group-role-mappings/m-x",
        method: "POST",
        body: { role: "admin" },
      }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(updateScimGroupRoleMapping).not.toHaveBeenCalled();
  });

  it("DELETE :id removes a mapping and audits", async () => {
    getScimGroupRoleMappingById.mockResolvedValueOnce(mappingRow);
    deleteScimGroupRoleMapping.mockResolvedValueOnce(1);
    const routes = await loadRoutes();
    const route = findRoute(routes, "DELETE", "/org/scim/group-role-mappings/m-1");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/group-role-mappings/m-1", method: "DELETE" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(deleteScimGroupRoleMapping).toHaveBeenCalledWith({ id: "m-1", orgId: "org-a" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.scim.group_role_mapping_deleted", "scim_group_role_mapping", "m-1",
      expect.any(Object),
    );
  });

  it("DELETE :id returns 404 when the mapping is missing", async () => {
    getScimGroupRoleMappingById.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "DELETE", "/org/scim/group-role-mappings/m-x");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/group-role-mappings/m-x", method: "DELETE" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(deleteScimGroupRoleMapping).not.toHaveBeenCalled();
  });
});

describe("SCIM bulk role re-sync", () => {
  const dirRow = {
    id: "sd-1",
    orgId: "org-a",
    providerDirectoryId: "directory_01",
    directoryType: null,
    defaultRole: "viewer" as const,
    status: "active" as const,
    lastSyncedAt: null,
    createdAt: null,
    updatedAt: null,
  };

  it("POST returns 409 when no directory is attached", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/resync");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/resync", method: "POST" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(listActiveScimUserState).not.toHaveBeenCalled();
  });

  it("POST re-derives active members, audits org.scim.resynced, returns the summary", async () => {
    getScimDirectoryByOrgId.mockResolvedValueOnce(dirRow);
    listActiveScimUserState.mockResolvedValueOnce([{ providerUserId: "u1", email: "ada@example.com" }]);
    getScimGroupRoleMappingsMap.mockResolvedValueOnce(new Map([["g1", "admin"]]));
    listScimUserGroupIds.mockResolvedValueOnce(["g1"]);
    findMemberByEmail.mockResolvedValueOnce({ role: "viewer" });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/scim/resync");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({ url: "/org/scim/resync", method: "POST" }) as never,
      res: res as never,
      auth: ADMIN_AUTH,
    });
    const body = JSON.parse(res.bodyText);
    expect(body.membersResynced).toBe(1);
    expect(body.membersChanged).toBe(1);
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", "admin-1", "org.scim.resynced", "scim_directory", "sd-1",
      expect.objectContaining({ membersResynced: 1, membersChanged: 1 }),
    );
  });
});

describe("SCIM webhook receiver", () => {
  const directoryRow = {
    id: "sd-1",
    orgId: "org-a",
    providerDirectoryId: "directory_01",
    directoryType: null,
    defaultRole: "viewer" as const,
    status: "active" as const,
    lastSyncedAt: null,
    createdAt: null,
    updatedAt: null,
  };

  it("rejects with 401 when signature is invalid", async () => {
    const body = JSON.stringify({
      id: "evt_1", event: "dsync.user.created", created_at: "2026-05-14T18:30:00Z",
      data: { id: "du1", directory_id: "directory_01", emails: [{ primary: true, value: "a@b.com" }] },
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/webhooks/workos/directory");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/webhooks/workos/directory",
        method: "POST",
        rawBody: body,
        headers: { "workos-signature": "t=999999,v1=00" },
      }) as never,
      res: res as never,
      auth: undefined as never,
    });
    expect(res.statusCode).toBe(401);
    expect(auditMock).toHaveBeenCalledWith(
      "default", "scim:webhook", "scim.webhook.signature_invalid", "scim_event", "",
      expect.objectContaining({ reason: expect.any(String) }),
    );
  });

  it("rejects with 400 on malformed JSON", async () => {
    const body = "{ not json";
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/webhooks/workos/directory");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/webhooks/workos/directory",
        method: "POST",
        rawBody: body,
        headers: { "workos-signature": signedHeader(body) },
      }) as never,
      res: res as never,
      auth: undefined as never,
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid signed event and dispatches to the handler", async () => {
    getScimDirectoryByProviderDirectoryId.mockResolvedValueOnce(directoryRow);
    const body = JSON.stringify({
      id: "evt_1",
      event: "dsync.user.created",
      created_at: "2026-05-14T18:30:00Z",
      data: {
        id: "du1",
        directory_id: "directory_01",
        email: "ada@example.com",
        first_name: "Ada",
        last_name: "Lovelace",
      },
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/webhooks/workos/directory");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/webhooks/workos/directory",
        method: "POST",
        rawBody: body,
        headers: { "workos-signature": signedHeader(body) },
      }) as never,
      res: res as never,
      auth: undefined as never,
    });
    expect(res.statusCode).toBe(200);
    const responseBody = JSON.parse(res.bodyText);
    expect(responseBody.ok).toBe(true);
    expect(responseBody.processed).toBe(true);
    // Tenant scope came from the directory row, not the payload — the
    // mock returned org-a.
    expect(auditMock).toHaveBeenCalledWith(
      "org-a", expect.any(String), "scim.user.provisioned", expect.any(String), expect.any(String), expect.any(Object),
    );
  });

  it("200s with processed:false when the directory is unknown", async () => {
    getScimDirectoryByProviderDirectoryId.mockResolvedValueOnce(null);
    const body = JSON.stringify({
      id: "evt_unknown",
      event: "dsync.user.created",
      created_at: "2026-05-14T18:30:00Z",
      data: { id: "du1", directory_id: "directory_unknown" },
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/webhooks/workos/directory");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/webhooks/workos/directory",
        method: "POST",
        rawBody: body,
        headers: { "workos-signature": signedHeader(body) },
      }) as never,
      res: res as never,
      auth: undefined as never,
    });
    expect(res.statusCode).toBe(200);
    const responseBody = JSON.parse(res.bodyText);
    expect(responseBody.processed).toBe(false);
    expect(responseBody.reason).toBe("unknown_directory");
  });

  it("200s with processed:false when the directory is revoked", async () => {
    getScimDirectoryByProviderDirectoryId.mockResolvedValueOnce({ ...directoryRow, status: "revoked" });
    const body = JSON.stringify({
      id: "evt_revoked",
      event: "dsync.user.created",
      created_at: "2026-05-14T18:30:00Z",
      data: { id: "du1", directory_id: "directory_01", emails: [{ primary: true, value: "a@b.com" }] },
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/webhooks/workos/directory");
    const res = fakeRes();
    await route.handler({
      req: fakeReq({
        url: "/webhooks/workos/directory",
        method: "POST",
        rawBody: body,
        headers: { "workos-signature": signedHeader(body) },
      }) as never,
      res: res as never,
      auth: undefined as never,
    });
    expect(res.statusCode).toBe(200);
    const responseBody = JSON.parse(res.bodyText);
    expect(responseBody.reason).toBe("directory_revoked");
  });
});
