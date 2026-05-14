import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// === Mocks: org_configs narrow read + audit chokepoint ===

const getAuthPolicyConfig = vi.fn();
const getSsoConnectionForOrg = vi.fn();
const auditMock = vi.fn();

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getAuthPolicyConfig: (...args: unknown[]) => getAuthPolicyConfig(...args),
}));

vi.mock("@janusly/data/src/ssoConnectionsRepo", () => ({
  getSsoConnectionForOrg: (...args: unknown[]) => getSsoConnectionForOrg(...args),
}));

vi.mock("./audit", () => ({
  audit: (...args: unknown[]) => auditMock(...args),
}));

// === Default fixtures ===

const POLICY_DEFAULTS = {
  allowedEmailDomains: [],
  mfaRequired: false,
  sessionTtlSeconds: 28800,
};

const ACTIVE_ENFORCED_SSO = {
  id: "sso-1",
  orgId: "org-a",
  provider: "workos",
  providerConnectionId: "conn_test",
  status: "active" as const,
  enforcedSso: true,
  configJson: null,
  createdAt: null,
  updatedAt: null,
};

const ACTIVE_RELAXED_SSO = {
  ...ACTIVE_ENFORCED_SSO,
  enforcedSso: false,
};

beforeEach(() => {
  vi.resetModules();
  getAuthPolicyConfig.mockReset();
  getSsoConnectionForOrg.mockReset();
  auditMock.mockReset();
  getAuthPolicyConfig.mockResolvedValue({ ...POLICY_DEFAULTS });
  getSsoConnectionForOrg.mockResolvedValue(null);
  auditMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadEvaluator() {
  return import("./auth-policy");
}

// === Tests ===

describe("evaluateAuthPolicy — mode bypass matrix", () => {
  it("service-token bypasses every gate even when all policies are set", async () => {
    getAuthPolicyConfig.mockResolvedValueOnce({
      allowedEmailDomains: ["acme.com"],
      mfaRequired: true,
      sessionTtlSeconds: 3600,
    });
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "robot",
      mode: "service-token",
      email: null,
      ssoConnection: ACTIVE_ENFORCED_SSO,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.sessionTtlSeconds).toBe(3600);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("dev-headers without enforced-SSO + no domains set passes", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "operator",
      mode: "dev-headers",
      email: null,
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("supabase principal with no policies set passes through", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.sessionTtlSeconds).toBe(28800);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("janusly-session bypasses enforced-SSO (user just authenticated via SSO)", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "janusly-session",
      email: "alice@acme.com",
      ssoConnection: ACTIVE_ENFORCED_SSO,
    });
    expect(decision.allowed).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("evaluateAuthPolicy — enforced-SSO", () => {
  it("supabase principal blocked when sso_connection.enforcedSso is true", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
      ssoConnection: ACTIVE_ENFORCED_SSO,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.policyKey).toBe("sso_connections.enforced_sso");
    }
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "user-1",
      "auth.policy.rejected",
      "user",
      "user-1",
      expect.objectContaining({
        policyKey: "sso_connections.enforced_sso",
        mode: "supabase",
      }),
    );
  });

  it("fetches the active SSO connection when the caller did not prefetch it", async () => {
    getSsoConnectionForOrg.mockResolvedValueOnce(ACTIVE_ENFORCED_SSO);
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
    });
    expect(getSsoConnectionForOrg).toHaveBeenCalledWith("org-a");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.policyKey).toBe("sso_connections.enforced_sso");
    }
  });

  it("does not throw when the on-demand SSO connection read fails", async () => {
    getSsoConnectionForOrg.mockRejectedValueOnce(new Error("db unavailable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
    });
    expect(decision.allowed).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to read sso_connections"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("dev-headers principal blocked when sso_connection.enforcedSso is true", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "operator",
      mode: "dev-headers",
      email: null,
      ssoConnection: ACTIVE_ENFORCED_SSO,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.policyKey).toBe("sso_connections.enforced_sso");
    }
  });

  it("ALLOW_DEV_SSO_BYPASS=true lets supabase principal through enforced-SSO", async () => {
    vi.stubEnv("ALLOW_DEV_SSO_BYPASS", "true");
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
      ssoConnection: ACTIVE_ENFORCED_SSO,
    });
    expect(decision.allowed).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("janusly-session passes enforced-SSO unconditionally (already SSO-authed)", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "janusly-session",
      email: "alice@acme.com",
      ssoConnection: ACTIVE_ENFORCED_SSO,
    });
    expect(decision.allowed).toBe(true);
  });

  it("relaxed SSO connection (enforcedSso=false) does not block supabase", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
      ssoConnection: ACTIVE_RELAXED_SSO,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("evaluateAuthPolicy — allowed email domains", () => {
  it("empty allow-list lets any email through", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "bob@whatever.com",
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
  });

  it("email in the allow-list passes", async () => {
    getAuthPolicyConfig.mockResolvedValueOnce({
      ...POLICY_DEFAULTS,
      allowedEmailDomains: ["acme.com", "partner.com"],
    });
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
  });

  it("email NOT in the allow-list rejects + audits", async () => {
    getAuthPolicyConfig.mockResolvedValueOnce({
      ...POLICY_DEFAULTS,
      allowedEmailDomains: ["acme.com"],
    });
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "bob@evil.com",
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.policyKey).toBe("auth.allowedEmailDomains");
    }
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "user-1",
      "auth.policy.rejected",
      "user",
      "user-1",
      expect.objectContaining({
        policyKey: "auth.allowedEmailDomains",
        email: "bob@evil.com",
      }),
    );
  });

  it("configured allow-list rejects human providers with missing email", async () => {
    getAuthPolicyConfig.mockResolvedValueOnce({
      ...POLICY_DEFAULTS,
      allowedEmailDomains: ["acme.com"],
    });
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: null,
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.policyKey).toBe("auth.allowedEmailDomains");
    }
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "user-1",
      "auth.policy.rejected",
      "user",
      "user-1",
      expect.objectContaining({
        policyKey: "auth.allowedEmailDomains",
        email: null,
      }),
    );
  });

  it("null email (dev-headers) skips the domain check", async () => {
    getAuthPolicyConfig.mockResolvedValueOnce({
      ...POLICY_DEFAULTS,
      allowedEmailDomains: ["acme.com"],
    });
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "operator",
      mode: "dev-headers",
      email: null,
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
  });

  it("janusly-session (post-SSO) STILL runs the domain check", async () => {
    // Defense in depth: even an SSO-authenticated user must pass the
    // org's domain policy. An Okta directory exposing @partner.com
    // users does NOT bypass an `allowedEmailDomains: "acme.com"` policy.
    getAuthPolicyConfig.mockResolvedValueOnce({
      ...POLICY_DEFAULTS,
      allowedEmailDomains: ["acme.com"],
    });
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "janusly-session",
      email: "bob@partner.com",
      ssoConnection: ACTIVE_RELAXED_SSO,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.policyKey).toBe("auth.allowedEmailDomains");
    }
  });

  it("domain matching is case-insensitive", async () => {
    getAuthPolicyConfig.mockResolvedValueOnce({
      ...POLICY_DEFAULTS,
      allowedEmailDomains: ["acme.com"],
    });
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "Alice@ACME.COM",
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("evaluateAuthPolicy — MFA marker", () => {
  it("mfaRequired=true emits a server-side warning but allows", async () => {
    getAuthPolicyConfig.mockResolvedValueOnce({
      ...POLICY_DEFAULTS,
      mfaRequired: true,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("requires MFA"),
    );
    warnSpy.mockRestore();
  });

  it("mfaRequired=false does not warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("evaluateAuthPolicy — session TTL", () => {
  it("default TTL when org has no policy override", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "janusly-session",
      email: "alice@acme.com",
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.sessionTtlSeconds).toBe(28800);
  });

  it("custom TTL when org overrides via auth.sessionTtlSeconds", async () => {
    getAuthPolicyConfig.mockResolvedValueOnce({
      ...POLICY_DEFAULTS,
      sessionTtlSeconds: 1800, // 30 minutes
    });
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "janusly-session",
      email: "alice@acme.com",
      ssoConnection: null,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.sessionTtlSeconds).toBe(1800);
  });

  it("rejection decisions still carry the TTL field", async () => {
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "alice@acme.com",
      ssoConnection: ACTIVE_ENFORCED_SSO,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.sessionTtlSeconds).toBe(28800);
  });
});

describe("evaluateAuthPolicy — policy conflict ordering", () => {
  it("enforced-SSO fires BEFORE allowed-domains when both reject", async () => {
    // Deterministic ordering matters: when both policies would reject,
    // operators reading the audit log want to see the higher-specificity
    // gate (enforced-SSO) recorded, not the noisier domain check. Pin
    // the ordering here so future refactors don't accidentally invert it.
    getAuthPolicyConfig.mockResolvedValueOnce({
      ...POLICY_DEFAULTS,
      allowedEmailDomains: ["acme.com"], // bob@evil.com would also fail this
    });
    const { evaluateAuthPolicy } = await loadEvaluator();
    const decision = await evaluateAuthPolicy({
      orgId: "org-a",
      userId: "user-1",
      mode: "supabase",
      email: "bob@evil.com",
      ssoConnection: ACTIVE_ENFORCED_SSO,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.policyKey).toBe("sso_connections.enforced_sso");
    }
    // Only one audit row — for enforced-SSO, not for the domain.
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "auth.policy.rejected",
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ policyKey: "sso_connections.enforced_sso" }),
    );
  });
});
