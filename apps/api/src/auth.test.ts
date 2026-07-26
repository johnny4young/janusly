import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Captured Supabase mock — see the vi.mock below. Tests configure the
// `getUser` behavior per case via `supabaseGetUser.mockResolvedValueOnce`.
const supabaseGetUser = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: supabaseGetUser } }),
}));

// Membership-resolver repo mocks. The resolver in `auth.ts` reads from
// these four modules; tests configure their return values per case.
const getMembershipForOrgUser = vi.fn();
const listMembershipsForUser = vi.fn();
const findMemberByEmail = vi.fn();
const upsertMembership = vi.fn();
const migrateMemberUserId = vi.fn();

const findPendingInvitation = vi.fn();
const acceptInvitationForIdentity = vi.fn();

const findVerifiedDomain = vi.fn();

const getSsoConnectionForOrg = vi.fn();
const getActiveAuthSession = vi.fn();

const auditMock = vi.fn();

vi.mock("@janusly/data/src/orgMembersRepo", () => ({
  getMembershipForOrgUser: (...args: unknown[]) => getMembershipForOrgUser(...args),
  listMembershipsForUser: (...args: unknown[]) => listMembershipsForUser(...args),
  findMemberByEmail: (...args: unknown[]) => findMemberByEmail(...args),
  upsertMembership: (...args: unknown[]) => upsertMembership(...args),
  migrateMemberUserId: (...args: unknown[]) => migrateMemberUserId(...args),
}));

vi.mock("@janusly/data/src/invitationsRepo", () => ({
  findPendingInvitation: (...args: unknown[]) => findPendingInvitation(...args),
}));

vi.mock("@janusly/data/src/identityRepo", () => ({
  acceptInvitationForIdentity: (...args: unknown[]) => acceptInvitationForIdentity(...args),
}));

vi.mock("@janusly/data/src/verifiedDomainsRepo", () => ({
  findVerifiedDomain: (...args: unknown[]) => findVerifiedDomain(...args),
}));

vi.mock("@janusly/data/src/ssoConnectionsRepo", () => ({
  getSsoConnectionForOrg: (...args: unknown[]) => getSsoConnectionForOrg(...args),
}));

vi.mock("@janusly/data/src/authSessionsRepo", () => ({
  getActiveAuthSession: (...args: unknown[]) => getActiveAuthSession(...args),
}));

// Auth policy narrow-read mock. Returns "no policy set" defaults unless a
// test overrides — keeps every existing test pass-through through the
// centralized evaluator without changing assertions.
const getAuthPolicyConfig = vi.fn();
vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getAuthPolicyConfig: (...args: unknown[]) => getAuthPolicyConfig(...args),
}));

vi.mock("./audit", () => ({
  audit: (...args: unknown[]) => auditMock(...args),
}));

// `auth.ts` checks supabase / service-token / dev-headers at module init.
// Tests import the module AFTER stubbing env so the boot-time gate sees
// the desired configuration. `vi.resetModules()` ensures each test gets a
// freshly-evaluated module.
beforeEach(() => {
  vi.resetModules();
  supabaseGetUser.mockReset();
  getMembershipForOrgUser.mockReset();
  listMembershipsForUser.mockReset();
  findMemberByEmail.mockReset();
  upsertMembership.mockReset();
  migrateMemberUserId.mockReset();
  findPendingInvitation.mockReset();
  acceptInvitationForIdentity.mockReset();
  findVerifiedDomain.mockReset();
  getSsoConnectionForOrg.mockReset();
  getActiveAuthSession.mockReset();
  getAuthPolicyConfig.mockReset();
  auditMock.mockReset();
  // Default: repos return "no rows" so each test only overrides what it cares about.
  getMembershipForOrgUser.mockResolvedValue(null);
  listMembershipsForUser.mockResolvedValue([]);
  findMemberByEmail.mockResolvedValue(null);
  findPendingInvitation.mockResolvedValue(null);
  acceptInvitationForIdentity.mockResolvedValue({ ok: true, result: { orgId: "org-b", role: "viewer" } });
  findVerifiedDomain.mockResolvedValue(null);
  getAuthPolicyConfig.mockResolvedValue({
    allowedEmailDomains: [],
    mfaRequired: false,
    sessionTtlSeconds: 28800,
  });
  getSsoConnectionForOrg.mockResolvedValue(null);
  getActiveAuthSession.mockResolvedValue(null);
  auditMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeReq(headers: Record<string, string | undefined>) {
  // Filter out undefined entries so `req.headers[key]` is `undefined` for
  // missing fields (matching how Node's IncomingMessage actually behaves).
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return { headers: cleaned } as Parameters<typeof import("./auth").getAuth>[0];
}

function stubSupabaseEnv() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.stubEnv("ALLOW_DEV_AUTH_HEADERS", "");
}

function stubDevHeadersEnv() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SUPABASE_URL", "");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
  vi.stubEnv("ALLOW_DEV_AUTH_HEADERS", "");
}

function supabaseUserFixture(overrides: { id?: string; email?: string | null; orgId?: string | null } = {}) {
  const user_metadata: Record<string, unknown> = {};
  if (overrides.orgId !== undefined && overrides.orgId !== null) user_metadata.orgId = overrides.orgId;
  return {
    data: {
      user: {
        id: overrides.id ?? "user-1",
        email: overrides.email === undefined ? "user@example.com" : overrides.email,
        user_metadata,
      },
    },
    error: null,
  };
}

describe("getAuth — source attribution across modes", () => {
  it("exposes a verified Supabase identity before organization membership exists", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({
      id: "new-user",
      email: "New.User@Example.com",
      orgId: null,
    }));

    const { getIdentity } = await import("./auth");
    const identity = await getIdentity(makeReq({
      authorization: "Bearer supabase-jwt",
    }));

    expect(identity).toEqual({
      userId: "new-user",
      email: "new.user@example.com",
      mode: "supabase",
      source: "web",
      orgHint: null,
    });
    expect(listMembershipsForUser).not.toHaveBeenCalled();
  }, 15_000);

  it("keeps the dev organization header as a non-authoritative identity hint", async () => {
    stubDevHeadersEnv();

    const { getIdentity } = await import("./auth");
    const identity = await getIdentity(makeReq({
      "x-org-id": "sandbox-a",
      "x-user-id": "operator-a",
    }));

    expect(identity).toMatchObject({
      userId: "operator-a",
      email: null,
      mode: "dev-headers",
      source: "dev",
      orgHint: "sandbox-a",
    });
  }, 15_000);

  it("service-token mode + x-janusly-source: mcp resolves to source=mcp", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("API_SERVICE_TOKEN", "tok-1234");

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer tok-1234",
      "x-org-id": "org-a",
      "x-user-id": "mcp-user",
      "x-janusly-source": "mcp",
    }));

    expect(auth).not.toBeNull();
    expect(auth?.mode).toBe("service-token");
    expect(auth?.source).toBe("mcp");
    expect(auth?.serviceTokenSuffix).toBe("1234");
  });

  it("service-token mode WITHOUT the source header resolves to source=service", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("API_SERVICE_TOKEN", "tok-1234");

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer tok-1234",
      "x-org-id": "org-a",
      "x-user-id": "script",
    }));

    expect(auth?.mode).toBe("service-token");
    expect(auth?.source).toBe("service");
  });

  it("dev-headers mode + x-janusly-source: mcp resolves to source=mcp for local MCP writes", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("API_SERVICE_TOKEN", "");

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      "x-org-id": "org-a",
      "x-user-id": "operator",
      "x-janusly-source": "mcp",
    }));

    expect(auth?.mode).toBe("dev-headers");
    expect(auth?.source).toBe("mcp");
    expect(auth?.serviceTokenSuffix).toBeUndefined();
  });

  it("dev-headers mode WITHOUT the source header resolves to source=dev", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("API_SERVICE_TOKEN", "");

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      "x-org-id": "org-a",
      "x-user-id": "operator",
    }));

    expect(auth?.mode).toBe("dev-headers");
    expect(auth?.source).toBe("dev");
  });

  it("falls back to dev-headers on a wrong service token, but keeps the MCP source tag gated", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("API_SERVICE_TOKEN", "tok-1234");

    const { getAuth } = await import("./auth");
    // No matching bearer; dev-headers fallback applies, but the declared
    // MCP source is still preserved so MCP writes hit the consent gate
    // instead of becoming ordinary dev writes.
    const auth = await getAuth(makeReq({
      authorization: "Bearer wrong-token",
      "x-org-id": "org-a",
      "x-user-id": "operator",
      "x-janusly-source": "mcp",
    }));

    expect(auth?.mode).toBe("dev-headers");
    expect(auth?.source).toBe("mcp");
  });
});

describe("getAuth — provider boundary contract", () => {
  it("Supabase JWT hardcodes source=web even when x-janusly-source: mcp is sent", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ orgId: "org-a" }));
    getMembershipForOrgUser.mockResolvedValueOnce({
      id: "m-1", orgId: "org-a", userId: "user-1", email: "user@example.com",
      role: "viewer", invitedBy: null, createdAt: null,
    });

    const { getAuth } = await import("./auth");
    // A browser request cannot self-declare MCP source. Honoring the
    // header here would let a compromised browser bypass the MCP write
    // consent gate by tagging an ordinary Supabase login as MCP.
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-a",
      "x-janusly-source": "mcp",
    }));

    expect(auth).not.toBeNull();
    expect(auth?.mode).toBe("supabase");
    expect(auth?.source).toBe("web");
  });

  it("service-token mode rejects a Bearer header with wrong length (timing-safe compare invariant)", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("API_SERVICE_TOKEN", "tok-1234");

    const { getAuth } = await import("./auth");
    // `timingSafeEqual` requires equal-length inputs; the length guard
    // in `constantTimeBearerMatch` exists to satisfy that precondition
    // without leaking timing about which prefix matched. A Bearer with
    // a similar prefix but wrong length must be rejected here, not crash.
    const auth = await getAuth(makeReq({
      authorization: "Bearer tok-12",
      "x-org-id": "org-a",
      "x-user-id": "operator",
    }));

    // Service token didn't match (length differed) → dev-headers takes
    // over; `serviceTokenSuffix` is only set when service-token matches.
    expect(auth?.mode).toBe("dev-headers");
    expect(auth?.serviceTokenSuffix).toBeUndefined();
  });

  it("getAuth returns null when no provider matches and dev headers are missing", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("API_SERVICE_TOKEN", "tok-1234");

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer wrong-token",
    }));

    expect(auth).toBeNull();
  });

  it("Supabase JWT returns null when Supabase rejects the token (no silent fallback to dev-headers)", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "invalid_token" },
    });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer rejected-jwt",
      "x-org-id": "org-a",
      "x-user-id": "operator",
    }));

    expect(auth).toBeNull();
  });
});

describe("getAuth — Supabase membership resolution (org_members + invitations + verified domains + SSO)", () => {
  it("direct match: existing org_members row resolves to that org", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-1", email: "user@example.com" }));
    getMembershipForOrgUser.mockResolvedValueOnce({
      id: "m-1", orgId: "org-a", userId: "user-1", email: "user@example.com",
      role: "editor", invitedBy: null, createdAt: null,
    });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-a",
    }));

    expect(auth?.mode).toBe("supabase");
    expect(auth?.orgId).toBe("org-a");
    expect(auth?.userId).toBe("user-1");
  });

  it("missing membership and no provisioning paths returns null", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ email: "alice@nobody.com" }));

    const { getAuth } = await import("./auth");
    // Hint to a real-looking org; no membership, no pending invite, no
    // verified domain, no SSO. Before membership hardening this would
    // have silently resolved to `orgId: "default"` (or whatever hint was
    // sent). Now the resolver fails closed.
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-b",
    }));

    expect(auth).toBeNull();
  });

  it("wrong org: user has membership in orgA, hint is orgB, no provisioning paths → null", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-1", email: "alice@nobody.com" }));
    listMembershipsForUser.mockResolvedValueOnce([
      { id: "m-1", orgId: "org-a", userId: "user-1", email: "alice@nobody.com",
        role: "viewer", invitedBy: null, createdAt: null },
    ]);

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-b",
    }));

    expect(auth).toBeNull();
  });

  it("invite acceptance delegates the grant and audit to the atomic identity transaction", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-1", email: "alice@example.com" }));
    findPendingInvitation.mockResolvedValueOnce({
      id: "inv-1", orgId: "org-b", email: "alice@example.com",
      role: "editor", invitedBy: "admin-1", status: "pending",
      acceptedAt: null, createdAt: null,
    });
    acceptInvitationForIdentity.mockResolvedValueOnce({ ok: true, result: { orgId: "org-b", role: "editor" } });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-b",
    }));

    expect(auth?.orgId).toBe("org-b");
    expect(auth?.mode).toBe("supabase");
    expect(acceptInvitationForIdentity).toHaveBeenCalledWith({
      invitationId: "inv-1",
      expectedOrgId: "org-b",
      userId: "user-1",
      email: "alice@example.com",
    });
    expect(upsertMembership).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      "org-b", "user-1", "member.joined", expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it("verified-domain join: email domain matches a row for the org → resolver upserts with default role", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-2", email: "bob@acme.com" }));
    findVerifiedDomain.mockResolvedValueOnce({
      id: "vd-1", orgId: "org-c", domain: "acme.com",
      defaultRole: "viewer", createdAt: null,
    });
    upsertMembership.mockResolvedValueOnce({
      id: "m-3", orgId: "org-c", userId: "user-2", email: "bob@acme.com",
      role: "viewer", invitedBy: null, createdAt: null,
    });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-c",
    }));

    expect(auth?.orgId).toBe("org-c");
    expect(findVerifiedDomain).toHaveBeenCalledWith({ orgId: "org-c", domain: "acme.com" });
    expect(upsertMembership).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-c",
      userId: "user-2",
      role: "viewer",
      email: "bob@acme.com",
    }));
    expect(auditMock).toHaveBeenCalledWith(
      "org-c",
      "user-2",
      "member.joined",
      "member",
      "user-2",
      expect.objectContaining({ via: "verified_domain", domain: "acme.com" }),
    );
  });

  it("SSO JIT handoff: active SSO row + no other path → null (seam for the SSO provider's JIT-provisioner)", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ email: "carol@nobody.com" }));
    getSsoConnectionForOrg.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-d", provider: "workos",
      providerConnectionId: "conn_xyz", status: "active",
      configJson: null, createdAt: null, updatedAt: null,
    });

    const { getAuth } = await import("./auth");
    // SSO seam: a Supabase principal landing here without a membership
    // means the SSO provider's extractor hasn't run. Fail closed; the
    // future provider will JIT-provision before this resolver is reached.
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-d",
    }));

    expect(auth).toBeNull();
    expect(getSsoConnectionForOrg).toHaveBeenCalledWith("org-d");
    expect(upsertMembership).not.toHaveBeenCalled();
  });

  it("legacy email orphan: pre-resolver `userId = email` row is rewritten to the real UUID on first sign-in", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-3", email: "dora@example.com" }));
    // Direct lookup misses (no row with userId = UUID), but the email
    // lookup finds the legacy `userId = email` placeholder row.
    findMemberByEmail.mockResolvedValueOnce({
      id: "m-legacy",
      orgId: "org-e",
      userId: "dora@example.com",
      email: "dora@example.com",
      role: "editor",
      invitedBy: "admin-2",
      createdAt: null,
    });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-e",
    }));

    expect(auth?.orgId).toBe("org-e");
    expect(auth?.mode).toBe("supabase");
    expect(migrateMemberUserId).toHaveBeenCalledWith({
      id: "m-legacy",
      orgId: "org-e",
      newUserId: "user-3",
    });
    expect(auditMock).toHaveBeenCalledWith(
      "org-e",
      "user-3",
      "member.userid.migrated",
      "member",
      "m-legacy",
      expect.objectContaining({ from: "dora@example.com", to: "user-3" }),
    );
  });

  it("multi-membership without a hint returns null (forces the client to send x-org-id)", async () => {
    stubSupabaseEnv();
    // No `user_metadata.orgId` claim and no `x-org-id` header → no hint.
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-4", orgId: null }));
    listMembershipsForUser.mockResolvedValueOnce([
      { id: "m-1", orgId: "org-a", userId: "user-4", email: null,
        role: "viewer", invitedBy: null, createdAt: null },
      { id: "m-2", orgId: "org-b", userId: "user-4", email: null,
        role: "viewer", invitedBy: null, createdAt: null },
    ]);

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
    }));

    expect(auth).toBeNull();
  });

  it("single-membership without a hint resolves to that org silently", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-5", orgId: null }));
    listMembershipsForUser.mockResolvedValueOnce([
      { id: "m-1", orgId: "org-only", userId: "user-5", email: null,
        role: "viewer", invitedBy: null, createdAt: null },
    ]);

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
    }));

    expect(auth?.orgId).toBe("org-only");
    expect(auth?.mode).toBe("supabase");
  });

  it("Supabase JWT without user_metadata.orgId AND no x-org-id header AND no memberships returns null", async () => {
    stubSupabaseEnv();
    // The previous boundary snapshot asserted `orgId: "default"` here.
    // Membership hardening inverts the contract: an unmembered Supabase
    // user with no scope hint fails closed. This is the explicit
    // migration of the contract.
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-6", orgId: null }));

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
    }));

    expect(auth).toBeNull();
  });

  it("HttpOnly Janusly session resolves its revocable server row", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("JANUSLY_RESUME_TOKEN_SECRET", "test-resume-secret");
    const { signSignedToken } = await import("@janusly/engine/src/secrets");
    const token = signSignedToken({
      purpose: "sso_session",
      payload: { sessionId: "session-1" },
      ttlSeconds: 600,
    });
    getActiveAuthSession.mockResolvedValueOnce({
      id: "session-1", orgId: "org-sso", userId: "sso-user-1", email: "alice@acme.com",
      expiresAt: new Date(Date.now() + 600_000), revokedAt: null,
    });
    getMembershipForOrgUser.mockResolvedValueOnce({
      id: "m-1", orgId: "org-sso", userId: "sso-user-1", email: "alice@acme.com",
      role: "viewer", invitedBy: null, createdAt: null,
    });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({ cookie: `janusly_session=${encodeURIComponent(token)}` }));
    expect(auth?.mode).toBe("janusly-session");
    expect(auth?.source).toBe("sso");
    expect(auth?.orgId).toBe("org-sso");
    expect(auth?.userId).toBe("sso-user-1");
    expect(auth?.browserSessionId).toBe("session-1");
  });

  it("Janusly session token with wrong purpose returns null (purpose discriminator gates replay)", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("JANUSLY_RESUME_TOKEN_SECRET", "test-resume-secret");
    const { signSignedToken } = await import("@janusly/engine/src/secrets");
    // Token signed with a DIFFERENT purpose — should not authenticate as
    // an SSO session even though the HMAC validates.
    const token = signSignedToken({
      purpose: "sso_state",
      payload: { sessionId: "session-1" },
      ttlSeconds: 600,
    });
    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({ cookie: `janusly_session=${encodeURIComponent(token)}` }));
    expect(auth).toBeNull();
    expect(getActiveAuthSession).not.toHaveBeenCalled();
  });

  it("Enforced-SSO: Supabase principal hitting an enforced-SSO org returns null (no dev bypass)", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-9", email: "u@x.com" }));
    getMembershipForOrgUser.mockResolvedValueOnce({
      id: "m-1", orgId: "org-sso", userId: "user-9", email: "u@x.com",
      role: "viewer", invitedBy: null, createdAt: null,
    });
    getSsoConnectionForOrg.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-sso", provider: "workos",
      providerConnectionId: "conn_x", status: "active", enforcedSso: true,
      configJson: null, createdAt: null, updatedAt: null,
    });
    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-sso",
    }));
    expect(auth).toBeNull();
  });

  it("Enforced-SSO with ALLOW_DEV_SSO_BYPASS=true lets Supabase principal through", async () => {
    stubSupabaseEnv();
    vi.stubEnv("ALLOW_DEV_SSO_BYPASS", "true");
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-9", email: "u@x.com" }));
    getMembershipForOrgUser.mockResolvedValueOnce({
      id: "m-1", orgId: "org-sso", userId: "user-9", email: "u@x.com",
      role: "viewer", invitedBy: null, createdAt: null,
    });
    getSsoConnectionForOrg.mockResolvedValueOnce({
      id: "sso-1", orgId: "org-sso", provider: "workos",
      providerConnectionId: "conn_x", status: "active", enforcedSso: true,
      configJson: null, createdAt: null, updatedAt: null,
    });
    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "org-sso",
    }));
    expect(auth?.mode).toBe("supabase");
    expect(auth?.orgId).toBe("org-sso");
  });

  it("Enforced-SSO does NOT block service-token (infrastructure callers bypass)", async () => {
    stubDevHeadersEnv();
    vi.stubEnv("API_SERVICE_TOKEN", "tok-1234");
    getSsoConnectionForOrg.mockResolvedValue({
      id: "sso-1", orgId: "org-sso", provider: "workos",
      providerConnectionId: "conn_x", status: "active", enforcedSso: true,
      configJson: null, createdAt: null, updatedAt: null,
    });
    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer tok-1234",
      "x-org-id": "org-sso",
      "x-user-id": "robot",
    }));
    expect(auth?.mode).toBe("service-token");
    expect(auth?.orgId).toBe("org-sso");
  });

  it("auth.allowedEmailDomains policy rejects a Supabase principal whose email domain is outside the allow-list", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-bad", email: "bob@evil.com" }));
    getMembershipForOrgUser.mockResolvedValueOnce({
      id: "m-1", orgId: "default", userId: "user-bad", email: "bob@evil.com",
      role: "viewer", invitedBy: null, createdAt: null,
    });
    getAuthPolicyConfig.mockResolvedValueOnce({
      allowedEmailDomains: ["acme.com"],
      mfaRequired: false,
      sessionTtlSeconds: 28800,
    });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "default",
    }));
    // Policy rejection trumps the existing membership row.
    expect(auth).toBeNull();
    expect(auditMock).toHaveBeenCalledWith(
      "default",
      "user-bad",
      "auth.policy.rejected",
      "user",
      "user-bad",
      expect.objectContaining({
        policyKey: "auth.allowedEmailDomains",
        email: "bob@evil.com",
      }),
    );
  });

  it("auth.allowedEmailDomains policy lets in-list email pass through", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-ok", email: "alice@acme.com" }));
    getMembershipForOrgUser.mockResolvedValueOnce({
      id: "m-1", orgId: "default", userId: "user-ok", email: "alice@acme.com",
      role: "viewer", invitedBy: null, createdAt: null,
    });
    getAuthPolicyConfig.mockResolvedValueOnce({
      allowedEmailDomains: ["acme.com"],
      mfaRequired: false,
      sessionTtlSeconds: 28800,
    });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "default",
    }));
    expect(auth?.orgId).toBe("default");
    expect(auth?.mode).toBe("supabase");
  });

  it("x-org-id header takes precedence over user_metadata.orgId for the scope hint", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce(supabaseUserFixture({ id: "user-7", orgId: "claim-org" }));
    getMembershipForOrgUser.mockImplementation(async (input) => {
      if (input.orgId === "header-org" && input.userId === "user-7") {
        return {
          id: "m-7", orgId: "header-org", userId: "user-7", email: "user@example.com",
          role: "viewer", invitedBy: null, createdAt: null,
        };
      }
      return null;
    });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-org-id": "header-org",
    }));

    expect(auth?.orgId).toBe("header-org");
  });
});
