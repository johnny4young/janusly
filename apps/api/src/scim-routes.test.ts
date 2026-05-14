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
}));
vi.mock("@janusly/data/src/scimGroupStateRepo", () => ({
  upsertScimGroupState: vi.fn().mockResolvedValue(null),
  deleteScimGroupState: vi.fn().mockResolvedValue(undefined),
  getScimGroupState: vi.fn().mockResolvedValue(null),
}));
vi.mock("@janusly/data/src/scimProcessedEventsRepo", () => ({
  recordProcessedEvent: vi.fn().mockResolvedValue({ fresh: true }),
  deleteProcessedEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@janusly/data/src/orgMembersRepo", () => ({
  upsertMembershipByEmail: vi.fn().mockResolvedValue({ id: "m-1" }),
  deleteMembership: vi.fn().mockResolvedValue(1),
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
  auditMock.mockReset();
  auditMock.mockResolvedValue(undefined);
  recordScimDirectorySync.mockResolvedValue(undefined);
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
