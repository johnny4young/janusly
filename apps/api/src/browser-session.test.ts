import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSessionCookie,
  createBrowserSessionToken,
  readBrowserSessionId,
  requireBrowserCsrf,
  sessionCookie,
} from "./browser-session";

function request(headers: Record<string, string>) {
  return { headers } as never;
}

beforeEach(() => {
  vi.stubEnv("JANUSLY_RESUME_TOKEN_SECRET", "browser-session-test-secret");
  vi.stubEnv("API_ALLOWED_ORIGINS", "http://localhost:7310");
  vi.stubEnv("JANUSLY_WEB_BASE_URL", "http://localhost:7310");
});

afterEach(() => vi.unstubAllEnvs());

describe("browser session cookie", () => {
  it("signs only an opaque session id and reads it from the cookie", () => {
    const { token } = createBrowserSessionToken("session-1", 600);
    const req = request({ cookie: `other=x; janusly_session=${encodeURIComponent(token)}` });

    expect(readBrowserSessionId(req)).toBe("session-1");
    const [, payload] = token.split(".");
    const envelope = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(envelope.payload).toEqual({ sessionId: "session-1" });
    expect(JSON.stringify(envelope)).not.toContain("email");
    expect(JSON.stringify(envelope)).not.toContain("orgId");
  });

  it("uses HttpOnly, Lax, bounded lifetime, and opt-in Secure for HTTPS", () => {
    const localCookie = sessionCookie("token", 600);
    expect(localCookie).toContain("HttpOnly");
    expect(localCookie).toContain("SameSite=Lax");
    expect(localCookie).toContain("Max-Age=600");
    expect(localCookie).not.toContain("Secure");

    vi.stubEnv("JANUSLY_WEB_BASE_URL", "https://janusly.example.com");
    expect(sessionCookie("token", 600)).toContain("Secure");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });
});

describe("browser session CSRF", () => {
  it("accepts the custom marker only from an allowlisted origin", () => {
    expect(() => requireBrowserCsrf(request({
      origin: "http://localhost:7310",
      "x-janusly-csrf": "1",
    }))).not.toThrow();
  });

  it("rejects a missing marker or foreign origin", () => {
    expect(() => requireBrowserCsrf(request({ origin: "http://localhost:7310" }))).toThrow(/invalid browser session origin/i);
    expect(() => requireBrowserCsrf(request({
      origin: "https://attacker.example",
      "x-janusly-csrf": "1",
    }))).toThrow(/invalid browser session origin/i);
  });
});
