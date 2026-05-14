import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizeUrl } from "./workos";

describe("buildAuthorizeUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a WorkOS SSO authorize URL with the OAuth code response type", () => {
    vi.stubEnv("WORKOS_CLIENT_ID", "client_test");

    const url = new URL(buildAuthorizeUrl({
      connectionId: "conn_test",
      redirectUri: "https://app.example.com/auth/sso/callback",
      state: "state-token",
    }));

    expect(url.origin + url.pathname).toBe("https://api.workos.com/sso/authorize");
    expect(url.searchParams.get("client_id")).toBe("client_test");
    expect(url.searchParams.get("connection")).toBe("conn_test");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/auth/sso/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-token");
  });
});
