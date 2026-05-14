import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Captured Supabase mock — see the vi.mock below. Tests configure the
// `getUser` behavior per case via `supabaseGetUser.mockResolvedValueOnce`.
const supabaseGetUser = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: supabaseGetUser } }),
}));

// `auth.ts` checks supabase / service-token / dev-headers at module init.
// Tests import the module AFTER stubbing env so the boot-time gate sees
// the desired configuration. `vi.resetModules()` ensures each test gets a
// freshly-evaluated module.
beforeEach(() => {
  vi.resetModules();
  supabaseGetUser.mockReset();
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

describe("getAuth — source attribution across modes", () => {
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
    supabaseGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-1", user_metadata: { orgId: "org-a" } } },
      error: null,
    });

    const { getAuth } = await import("./auth");
    // A browser request cannot self-declare MCP source. Honoring the
    // header here would let a compromised browser bypass the MCP write
    // consent gate by tagging an ordinary Supabase login as MCP.
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
      "x-janusly-source": "mcp",
    }));

    expect(auth).not.toBeNull();
    expect(auth?.mode).toBe("supabase");
    expect(auth?.source).toBe("web");
  });

  it("Supabase JWT without user_metadata.orgId resolves orgId to 'default'", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-1", user_metadata: {} } },
      error: null,
    });

    const { getAuth } = await import("./auth");
    // Behavior snapshot — the "default" fallback is the untrusted
    // JWT-claim seam that a future migration to `org_members` will
    // delete. Pinning it here is the guardrail so that migration is
    // an intentional flip, not an accidental one.
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
    }));

    expect(auth?.mode).toBe("supabase");
    expect(auth?.orgId).toBe("default");
    expect(auth?.userId).toBe("user-1");
  });

  it("Supabase JWT with user_metadata.orgId surfaces that org id", async () => {
    stubSupabaseEnv();
    supabaseGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-1", user_metadata: { orgId: "acme" } } },
      error: null,
    });

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      authorization: "Bearer supabase-jwt",
    }));

    expect(auth?.mode).toBe("supabase");
    expect(auth?.orgId).toBe("acme");
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
    // Wrong service token → service-token miss; no `x-org-id` /
    // `x-user-id` → dev-headers miss; no Supabase configured →
    // supabase miss. Result: null → 401 at the dispatcher.
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
    // When Supabase is configured, the dev-headers path is disabled
    // unless ALLOW_DEV_AUTH_HEADERS is set explicitly. A rejected JWT
    // returns null (401 at the dispatcher), never silently downgrades
    // to dev-headers.
    const auth = await getAuth(makeReq({
      authorization: "Bearer rejected-jwt",
      "x-org-id": "org-a",
      "x-user-id": "operator",
    }));

    expect(auth).toBeNull();
  });
});
