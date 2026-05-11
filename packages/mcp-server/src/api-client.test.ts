import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, resolveApiClientConfig } from "./api-client";

describe("resolveApiClientConfig", () => {
  it("falls back to localhost defaults when no env vars are set", () => {
    const cfg = resolveApiClientConfig({} as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      apiUrl: "http://127.0.0.1:3001",
      orgId: "default",
      userId: "mcp-user",
      serviceToken: undefined,
    });
  });

  it("threads the four supported env vars when present", () => {
    const cfg = resolveApiClientConfig({
      JANUSLY_API_URL: "https://api.example.com",
      JANUSLY_API_ORG_ID: "acme",
      JANUSLY_API_USER_ID: "claude-bot",
      JANUSLY_API_SERVICE_TOKEN: "tok-123",
    } as NodeJS.ProcessEnv);
    expect(cfg.apiUrl).toBe("https://api.example.com");
    expect(cfg.orgId).toBe("acme");
    expect(cfg.userId).toBe("claude-bot");
    expect(cfg.serviceToken).toBe("tok-123");
  });

  it("normalizes a trailing slash on JANUSLY_API_URL", () => {
    const cfg = resolveApiClientConfig({
      JANUSLY_API_URL: "https://api.example.com/",
    } as NodeJS.ProcessEnv);
    expect(cfg.apiUrl).toBe("https://api.example.com");
  });

  it("treats an empty service token as unset (avoids `Authorization: Bearer `)", () => {
    const cfg = resolveApiClientConfig({ JANUSLY_API_SERVICE_TOKEN: "" } as NodeJS.ProcessEnv);
    expect(cfg.serviceToken).toBeUndefined();
  });
});

describe("createApiClient", () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = originalFetch;
  });

  function installFetch(response: { status?: number; ok?: boolean; body?: unknown }) {
    fetchMock.mockResolvedValue({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: "OK",
      json: async () => response.body ?? { ok: true },
      text: async () => (response.body !== undefined ? JSON.stringify(response.body) : ""),
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  }

  it("sends dev headers + the x-janusly-source: mcp tag on every request", async () => {
    installFetch({ body: { ok: true } });
    const callApi = createApiClient({
      apiUrl: "http://127.0.0.1:3001",
      orgId: "default",
      userId: "mcp-user",
    });
    await callApi("/workflows");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3001/workflows");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("default");
    expect(headers["x-user-id"]).toBe("mcp-user");
    expect(headers["x-janusly-source"]).toBe("mcp");
    expect(headers.authorization).toBeUndefined();
  });

  it("sends Bearer + dev headers when a service token is configured", async () => {
    installFetch({ body: { ok: true } });
    const callApi = createApiClient({
      apiUrl: "https://api.example.com",
      orgId: "acme",
      userId: "claude-bot",
      serviceToken: "tok-123",
    });
    await callApi("/tools");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/tools");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-123");
    expect(headers["x-org-id"]).toBe("acme");
    expect(headers["x-user-id"]).toBe("claude-bot");
  });

  it("does not double-slash paths when the base URL has a trailing slash", async () => {
    installFetch({ body: { ok: true } });
    const callApi = createApiClient({
      apiUrl: "https://api.example.com/",
      orgId: "acme",
      userId: "claude-bot",
    });
    await callApi("/tools");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/tools");
  });

  it("throws a descriptive error on non-2xx responses", async () => {
    installFetch({ ok: false, status: 404, body: { error: "not found" } });
    const callApi = createApiClient({
      apiUrl: "http://127.0.0.1:3001",
      orgId: "default",
      userId: "mcp-user",
    });
    await expect(callApi("/workflows/missing")).rejects.toThrow(/404/);
  });

  it("appends a truncated body tail to the error message for stderr usefulness", async () => {
    const longBody = "x".repeat(400);
    installFetch({ ok: false, status: 500, body: longBody });
    const callApi = createApiClient({
      apiUrl: "http://127.0.0.1:3001",
      orgId: "default",
      userId: "mcp-user",
    });
    let caught: Error | undefined;
    try {
      await callApi("/oops");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("/oops");
    // Body is JSON-stringified by the fake `text()` so length is ~402; the
    // helper truncates to 256 chars max — ensure it neither includes the
    // full body nor drops the marker.
    expect(caught!.message.length).toBeLessThan(400);
    expect(caught!.message).toMatch(/x{50,}/);
  });
});
