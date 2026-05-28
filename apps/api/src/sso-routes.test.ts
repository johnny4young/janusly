import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// === Mocks for the SSO repos + WorkOS client ===

const getSsoConnectionForOrg = vi.fn();
const getSsoConnectionById = vi.fn();
const listSsoConnections = vi.fn();
const createSsoConnection = vi.fn();
const updateSsoConnection = vi.fn();
const revokeSsoConnection = vi.fn();

const recordSsoNonce = vi.fn();
const consumeSsoNonce = vi.fn();

const upsertMembership = vi.fn();

const exchangeCode = vi.fn();
const buildAuthorizeUrl = vi.fn();

const auditMock = vi.fn();

vi.mock("@janusly/data/src/ssoConnectionsRepo", () => ({
  getSsoConnectionForOrg: (...args: unknown[]) => getSsoConnectionForOrg(...args),
  getSsoConnectionById: (...args: unknown[]) => getSsoConnectionById(...args),
  listSsoConnections: (...args: unknown[]) => listSsoConnections(...args),
  createSsoConnection: (...args: unknown[]) => createSsoConnection(...args),
  updateSsoConnection: (...args: unknown[]) => updateSsoConnection(...args),
  revokeSsoConnection: (...args: unknown[]) => revokeSsoConnection(...args),
}));

vi.mock("@janusly/data/src/ssoStateNoncesRepo", () => ({
  recordSsoNonce: (...args: unknown[]) => recordSsoNonce(...args),
  consumeSsoNonce: (...args: unknown[]) => consumeSsoNonce(...args),
}));

vi.mock("@janusly/data/src/orgMembersRepo", () => ({
  upsertMembership: (...args: unknown[]) => upsertMembership(...args),
}));

// Mock withAuditTx so the SSO callback's atomic membership+audit pair
// runs without touching a real Postgres `db.transaction`. The mock
// runs the handler with a fake tx + a fake audit fn that proxies to
// the existing `audit` mock so the test assertions on audit metadata
// still fire. Failures bubble through the same { ok, error } envelope
// the real helper returns.
vi.mock("@janusly/data/src/audit-tx", () => ({
  withAuditTx: async (handler: (tx: unknown, txAudit: (input: unknown) => Promise<void>) => Promise<unknown>) => {
    const tx = {};
    const txAudit = async (rawInput: unknown) => {
      const input = rawInput as {
        orgId: string;
        userId: string | null;
        action: string;
        targetType?: string | null;
        targetId?: string | null;
        metadata?: unknown;
      };
      // Delegate to the test's `auditMock` with the legacy positional
      // signature so existing assertions on calls[i][2] / [3] / [5] hold.
      auditMock(
        input.orgId,
        input.userId,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.metadata,
      );
    };
    try {
      const result = await handler(tx, txAudit);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
}));

// Auth policy narrow-read mock. Returns "no policy set" defaults unless a
// test overrides — keeps the existing 9 SSO tests passing through the
// new policy gate.
const getAuthPolicyConfig = vi.fn();
vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getAuthPolicyConfig: (...args: unknown[]) => getAuthPolicyConfig(...args),
}));

vi.mock("./workos", async () => {
  const actual = await vi.importActual<typeof import("./workos")>("./workos");
  return {
    ...actual,
    exchangeCode: (...args: unknown[]) => exchangeCode(...args),
    buildAuthorizeUrl: (...args: unknown[]) => buildAuthorizeUrl(...args),
  };
});

vi.mock("./audit", () => ({
  audit: (...args: unknown[]) => auditMock(...args),
}));

// === Test helpers ===

beforeEach(() => {
  vi.resetModules();
  getSsoConnectionForOrg.mockReset();
  getSsoConnectionById.mockReset();
  listSsoConnections.mockReset();
  createSsoConnection.mockReset();
  updateSsoConnection.mockReset();
  revokeSsoConnection.mockReset();
  recordSsoNonce.mockReset();
  consumeSsoNonce.mockReset();
  upsertMembership.mockReset();
  exchangeCode.mockReset();
  buildAuthorizeUrl.mockReset();
  auditMock.mockReset();
  // Defaults — each test only overrides what it cares about.
  buildAuthorizeUrl.mockReturnValue("https://api.workos.com/sso/authorize?stub=1");
  recordSsoNonce.mockResolvedValue(undefined);
  consumeSsoNonce.mockResolvedValue(true);
  upsertMembership.mockResolvedValue({
    id: "m-1", orgId: "org-a", userId: "user-1", email: "u@x.com",
    role: "viewer", invitedBy: null, createdAt: null,
  });
  auditMock.mockResolvedValue(undefined);
  getAuthPolicyConfig.mockReset();
  getAuthPolicyConfig.mockResolvedValue({
    allowedEmailDomains: [],
    mfaRequired: false,
    sessionTtlSeconds: 28800,
  });
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
  vi.stubEnv("WORKOS_API_KEY", "sk_test");
  vi.stubEnv("JANUSLY_SSO_CALLBACK_URL", "http://localhost:3001/auth/sso/callback");
  vi.stubEnv("JANUSLY_WEB_BASE_URL", "http://localhost:3000");
  vi.stubEnv("JANUSLY_RESUME_TOKEN_SECRET", "test-resume-secret");
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

function fakeReq(url: string, method: string = "GET", body?: unknown) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {
    data: [],
    end: [],
    error: [],
  };
  const req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    on: (event: string, cb: (...args: unknown[]) => void) => typeof req;
    once: (event: string, cb: (...args: unknown[]) => void) => typeof req;
    destroy: () => void;
  } = {
    url,
    method,
    headers: { "content-type": "application/json" },
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
    once(event, cb) {
      return req.on(event, cb);
    },
    destroy() {},
  };
  // Schedule the data + end emit on the next microtask so the route
  // handler has a chance to register listeners first.
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const cb of listeners.data) cb(Buffer.from(JSON.stringify(body)));
    }
    for (const cb of listeners.end) cb();
  });
  return req;
}

async function loadRoutes() {
  const mod = await import("./routes/sso-routes");
  return mod.ssoRoutes;
}

function findRoute(routes: Awaited<ReturnType<typeof loadRoutes>>, method: string, url: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.match === "string") {
      if (route.match === url || (url.startsWith(route.match + "?"))) return route;
    } else if (route.match(url)) {
      return route;
    }
  }
  throw new Error(`route not found: ${method} ${url}`);
}

// === Tests ===

describe("SSO admin CRUD", () => {
  it("POST /org/sso/connections creates a row and audits org.sso.connection_added", async () => {
    getSsoConnectionForOrg.mockResolvedValueOnce(null);
    createSsoConnection.mockResolvedValueOnce({
      id: "sso-1",
      orgId: "org-a",
      provider: "workos",
      providerConnectionId: "conn_test",
      status: "active",
      enforcedSso: false,
      configJson: null,
      createdAt: null,
      updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/sso/connections");
    const res = fakeRes();
    await route.handler({
      req: fakeReq("/org/sso/connections", "POST", { provider: "workos", providerConnectionId: "conn_test" }) as never,
      res: res as never,
      auth: { orgId: "org-a", userId: "admin-1", mode: "dev-headers", source: "dev" },
    });
    expect(createSsoConnection).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-a", provider: "workos", providerConnectionId: "conn_test", enforcedSso: false,
    }));
    expect(auditMock).toHaveBeenCalledWith("org-a", "admin-1", "org.sso.connection_added",
      "sso_connection", "sso-1", expect.objectContaining({ provider: "workos" }));
  }, 10_000);

  it("POST /org/sso/connections rejects duplicate provider with 409", async () => {
    getSsoConnectionForOrg.mockResolvedValueOnce({
      id: "sso-existing", orgId: "org-a", provider: "workos",
      providerConnectionId: "conn_a", status: "active", enforcedSso: false,
      configJson: null, createdAt: null, updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/sso/connections");
    const res = fakeRes();
    await route.handler({
      req: fakeReq("/org/sso/connections", "POST", { provider: "workos", providerConnectionId: "conn_b" }) as never,
      res: res as never,
      auth: { orgId: "org-a", userId: "admin-1", mode: "dev-headers", source: "dev" },
    });
    expect(res.statusCode).toBe(409);
    expect(createSsoConnection).not.toHaveBeenCalled();
  });

  it("POST /org/sso/connections/:id updates connection id, enforced flag, and audits", async () => {
    getSsoConnectionById.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-a", provider: "workos",
      providerConnectionId: "conn_test", status: "active", enforcedSso: false,
      configJson: null, createdAt: null, updatedAt: null,
    });
    updateSsoConnection.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-a", provider: "workos",
      providerConnectionId: "conn_fixed", status: "active", enforcedSso: true,
      configJson: null, createdAt: null, updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "POST", "/org/sso/connections/sso-1");
    const res = fakeRes();
    await route.handler({
      req: fakeReq("/org/sso/connections/sso-1", "POST", {
        enforcedSso: true,
        providerConnectionId: " conn_fixed ",
      }) as never,
      res: res as never,
      auth: { orgId: "org-a", userId: "admin-1", mode: "dev-headers", source: "dev" },
    });
    expect(updateSsoConnection).toHaveBeenCalledWith(expect.objectContaining({
      enforcedSso: true,
      providerConnectionId: "conn_fixed",
    }));
    expect(auditMock).toHaveBeenCalledWith("org-a", "admin-1", "org.sso.connection_updated",
      "sso_connection", "sso-1", expect.objectContaining({
        enforcedSso: true,
        providerConnectionId: "conn_fixed",
      }));
  });
});

describe("/auth/sso/start", () => {
  it("redirects to WorkOS with a state token and audits auth.sso.start", async () => {
    getSsoConnectionForOrg.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-a", provider: "workos",
      providerConnectionId: "conn_test", status: "active", enforcedSso: false,
      configJson: null, createdAt: null, updatedAt: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/auth/sso/start?orgId=org-a");
    const res = fakeRes();
    await route.handler({
      req: fakeReq("/auth/sso/start?orgId=org-a") as never,
      res: res as never,
      auth: { orgId: "", userId: "", mode: "dev-headers", source: "dev" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.getHeader("location")).toContain("https://api.workos.com/sso/authorize");
    expect(recordSsoNonce).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a" }));
    expect(buildAuthorizeUrl).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith("org-a", "sso", "auth.sso.start",
      "sso_connection", "sso-1", expect.objectContaining({ connectionId: "conn_test" }));
  });

  it("404s when the org has no active SSO connection", async () => {
    getSsoConnectionForOrg.mockResolvedValueOnce(null);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/auth/sso/start?orgId=org-a");
    const res = fakeRes();
    await route.handler({
      req: fakeReq("/auth/sso/start?orgId=org-a") as never,
      res: res as never,
      auth: { orgId: "", userId: "", mode: "dev-headers", source: "dev" },
    });
    expect(res.statusCode).toBe(404);
    expect(recordSsoNonce).not.toHaveBeenCalled();
  });
});

describe("/auth/sso/callback", () => {
  async function issueValidState(orgId: string) {
    const { signSignedToken } = await import("@janusly/engine/src/secrets");
    const { SSO_STATE_PURPOSE } = await import("./auth");
    return signSignedToken({
      purpose: SSO_STATE_PURPOSE,
      payload: {
        orgId,
        nonce: "n-1",
        callbackUrl: "http://localhost:3001/auth/sso/callback",
      },
      ttlSeconds: 600,
    });
  }

  it("successful flow: validates state, exchanges code, upserts membership, audits auth.sso.login", async () => {
    const state = await issueValidState("org-a");
    consumeSsoNonce.mockResolvedValueOnce(true);
    getSsoConnectionForOrg.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-a", provider: "workos",
      providerConnectionId: "conn_test", status: "active", enforcedSso: false,
      configJson: null, createdAt: null, updatedAt: null,
    });
    exchangeCode.mockResolvedValueOnce({
      id: "user-sso-1", email: "alice@acme.com",
      firstName: "Alice", lastName: null,
      connectionId: "conn_test", organizationId: null,
    });

    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/auth/sso/callback");
    const res = fakeRes();
    await route.handler({
      req: fakeReq(`/auth/sso/callback?code=test_code&state=${encodeURIComponent(state)}`) as never,
      res: res as never,
      auth: { orgId: "", userId: "", mode: "dev-headers", source: "dev" },
    });
    expect(res.statusCode).toBe(302);
    const target = res.getHeader("location");
    const webBaseUrl = (process.env.JANUSLY_WEB_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
    expect(target).toContain(`${webBaseUrl}/auth/sso/complete`);
    expect(target).toContain("#janusly_session=");
    expect(upsertMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        userId: "user-sso-1",
        email: "alice@acme.com",
      }),
      // SSO callback wraps upsert + audit in withAuditTx and passes a tx
      // handle as the second argument so the upsert participates in the
      // surrounding transaction.
      expect.anything(),
    );
    expect(auditMock).toHaveBeenCalledWith("org-a", "user-sso-1", "auth.sso.login",
      "sso_connection", "sso-1", expect.objectContaining({ via: "workos" }));
  });

  it("rejects replayed nonce — audits auth.sso.state_invalid", async () => {
    const state = await issueValidState("org-a");
    consumeSsoNonce.mockResolvedValueOnce(false);
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/auth/sso/callback");
    const res = fakeRes();
    await route.handler({
      req: fakeReq(`/auth/sso/callback?code=test_code&state=${encodeURIComponent(state)}`) as never,
      res: res as never,
      auth: { orgId: "", userId: "", mode: "dev-headers", source: "dev" },
    });
    expect(res.statusCode).toBe(400);
    expect(auditMock).toHaveBeenCalledWith("org-a", "sso", "auth.sso.state_invalid",
      "sso_state", "", expect.objectContaining({ reason: "nonce_replayed_or_expired" }));
    expect(upsertMembership).not.toHaveBeenCalled();
  });

  it("rejects tampered state — audits auth.sso.state_invalid", async () => {
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/auth/sso/callback");
    const res = fakeRes();
    await route.handler({
      req: fakeReq("/auth/sso/callback?code=test_code&state=tampered") as never,
      res: res as never,
      auth: { orgId: "", userId: "", mode: "dev-headers", source: "dev" },
    });
    expect(res.statusCode).toBe(400);
    expect(auditMock).toHaveBeenCalledWith("default", "sso", "auth.sso.state_invalid",
      "sso_state", "", expect.objectContaining({ reason: "invalid_signature_or_expiry" }));
  });

  it("rejects connectionId mismatch — audits auth.sso.callback_failed, no JIT", async () => {
    const state = await issueValidState("org-a");
    consumeSsoNonce.mockResolvedValueOnce(true);
    getSsoConnectionForOrg.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-a", provider: "workos",
      providerConnectionId: "conn_expected", status: "active", enforcedSso: false,
      configJson: null, createdAt: null, updatedAt: null,
    });
    exchangeCode.mockResolvedValueOnce({
      id: "user-sso-1", email: "alice@acme.com",
      firstName: null, lastName: null,
      connectionId: "conn_DIFFERENT",
      organizationId: null,
    });
    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/auth/sso/callback");
    const res = fakeRes();
    await route.handler({
      req: fakeReq(`/auth/sso/callback?code=test_code&state=${encodeURIComponent(state)}`) as never,
      res: res as never,
      auth: { orgId: "", userId: "", mode: "dev-headers", source: "dev" },
    });
    expect(res.statusCode).toBe(400);
    expect(upsertMembership).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith("org-a", "sso", "auth.sso.callback_failed",
      "sso_connection", "sso-1", expect.objectContaining({ reason: "connection_id_mismatch" }));
  });

  it("rejects callback when allowed-domains policy blocks the profile email", async () => {
    const state = await issueValidState("org-a");
    consumeSsoNonce.mockResolvedValueOnce(true);
    getSsoConnectionForOrg.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-a", provider: "workos",
      providerConnectionId: "conn_test", status: "active", enforcedSso: false,
      configJson: null, createdAt: null, updatedAt: null,
    });
    exchangeCode.mockResolvedValueOnce({
      id: "user-sso-1", email: "bob@partner.com",
      firstName: null, lastName: null,
      connectionId: "conn_test", organizationId: null,
    });
    getAuthPolicyConfig.mockResolvedValueOnce({
      allowedEmailDomains: ["acme.com"],
      mfaRequired: false,
      sessionTtlSeconds: 28800,
    });

    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/auth/sso/callback");
    const res = fakeRes();
    await route.handler({
      req: fakeReq(`/auth/sso/callback?code=test_code&state=${encodeURIComponent(state)}`) as never,
      res: res as never,
      auth: { orgId: "", userId: "", mode: "dev-headers", source: "dev" },
    });

    expect(res.statusCode).toBe(403);
    // No JIT upsert.
    expect(upsertMembership).not.toHaveBeenCalled();
    // SSO audit row carries policy reason.
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "user-sso-1",
      "auth.sso.callback_failed",
      "sso_connection",
      "sso-1",
      expect.objectContaining({ reason: "policy_rejected", policyKey: "auth.allowedEmailDomains" }),
    );
  });

  it("issues session token with org-policy TTL when set", async () => {
    const state = await issueValidState("org-a");
    consumeSsoNonce.mockResolvedValueOnce(true);
    getSsoConnectionForOrg.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-a", provider: "workos",
      providerConnectionId: "conn_test", status: "active", enforcedSso: false,
      configJson: null, createdAt: null, updatedAt: null,
    });
    exchangeCode.mockResolvedValueOnce({
      id: "user-sso-1", email: "alice@acme.com",
      firstName: "Alice", lastName: null,
      connectionId: "conn_test", organizationId: null,
    });
    // 30-minute org-level override.
    getAuthPolicyConfig.mockResolvedValueOnce({
      allowedEmailDomains: [],
      mfaRequired: false,
      sessionTtlSeconds: 1800,
    });

    const routes = await loadRoutes();
    const route = findRoute(routes, "GET", "/auth/sso/callback");
    const res = fakeRes();
    await route.handler({
      req: fakeReq(`/auth/sso/callback?code=test_code&state=${encodeURIComponent(state)}`) as never,
      res: res as never,
      auth: { orgId: "", userId: "", mode: "dev-headers", source: "dev" },
    });

    expect(res.statusCode).toBe(302);
    const target = res.getHeader("location") as string;
    expect(target).toContain("#janusly_session=");
    // Decode the session token from the redirect target and verify TTL.
    const tokenMatch = target.match(/#janusly_session=([^&]+)$/);
    expect(tokenMatch).not.toBeNull();
    const token = decodeURIComponent(tokenMatch![1]);
    const [, payloadB64] = token.split(".");
    const envelope = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
      issuedAt: number;
      expiresAt: number;
    };
    // TTL is the diff between expiresAt and issuedAt.
    expect(envelope.expiresAt - envelope.issuedAt).toBe(1800);
  });
});
