import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `auth.ts` checks supabase / service-token / dev-headers at module init. To
// exercise service-token + dev-headers without a real Supabase client we
// import the module AFTER stubbing the env so `supabase` is null.
beforeEach(() => {
  vi.resetModules();
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

describe("getAuth — source attribution across modes", () => {
  it("service-token mode + x-janusly-source: mcp resolves to source=mcp", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_SERVICE_TOKEN", "tok-1234");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

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
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_SERVICE_TOKEN", "tok-1234");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

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
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_SERVICE_TOKEN", "");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

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
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_SERVICE_TOKEN", "");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    const { getAuth } = await import("./auth");
    const auth = await getAuth(makeReq({
      "x-org-id": "org-a",
      "x-user-id": "operator",
    }));

    expect(auth?.mode).toBe("dev-headers");
    expect(auth?.source).toBe("dev");
  });

  it("falls back to dev-headers on a wrong service token, but keeps the MCP source tag gated", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_SERVICE_TOKEN", "tok-1234");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

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
