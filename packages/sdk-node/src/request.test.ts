import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JanuslyApiError,
  JanuslyAuthError,
  JanuslyRateLimitError,
  JanuslyProtocolError,
  JanuslyServerError,
  JanuslyValidationError,
} from "./errors.ts";
import { sendApiRequest, type SendRequestInput } from "./request.ts";
import type { JanuslyClientConfig } from "./types.ts";

type FakeFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function makeConfig(overrides: Partial<JanuslyClientConfig> = {}, fetchImpl?: FakeFetch): JanuslyClientConfig {
  return {
    baseUrl: "https://api.test.example.com",
    orgId: "org-1",
    auth: { kind: "service-token", token: "tk-secret" },
    fetch: fetchImpl ?? (vi.fn() as unknown as typeof globalThis.fetch),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function captureRequest(): { fetchImpl: FakeFetch; captured: Array<{ url: string; init: RequestInit }> } {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return jsonResponse(200, { ok: true });
  }) as unknown as FakeFetch;
  return { fetchImpl, captured };
}

const POST_INPUT: SendRequestInput = { method: "POST", path: "/start", body: { workflowId: "wf-1" } };
const GET_INPUT: SendRequestInput = { method: "GET", path: "/run?runId=r-1" };

describe("sendApiRequest — auth headers", () => {
  it("always sends x-org-id and accept: application/json", async () => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({}, fetchImpl);
    await sendApiRequest(config, GET_INPUT);
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["accept"]).toBe("application/json");
  });

  it("service-token mode sends Authorization + x-user-id (default sdk-user)", async () => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({}, fetchImpl);
    await sendApiRequest(config, GET_INPUT);
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tk-secret");
    expect(headers["x-user-id"]).toBe("sdk-user");
  });

  it("service-token mode respects custom userId override", async () => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({ auth: { kind: "service-token", token: "tk", userId: "my-bot" } }, fetchImpl);
    await sendApiRequest(config, GET_INPUT);
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["x-user-id"]).toBe("my-bot");
  });

  it("bearer mode sends Authorization only — no x-user-id", async () => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({ auth: { kind: "bearer", token: "jwt-token" } }, fetchImpl);
    await sendApiRequest(config, GET_INPUT);
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer jwt-token");
    expect(headers["x-user-id"]).toBeUndefined();
  });

  // Overriding any SDK-managed header is rejected (not silently dropped) so a
  // caller learns immediately — matches the Python SDK's `_RESERVED_HEADERS`
  // ValueError. Case-insensitive across all 6 reserved names.
  it.each([
    "Authorization",
    "X-Org-Id",
    "X-User-Id",
    "Content-Type",
    "Accept",
    "User-Agent",
  ])("rejects a per-call override of the reserved header %s", async (name) => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({}, fetchImpl);
    await expect(
      sendApiRequest(config, GET_INPUT, { headers: { [name]: "override" } }),
    ).rejects.toThrow(/reserved header/);
    // Deterministic + composed before the retry loop → fetch never fired.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it("forwards a non-reserved per-call header", async () => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({}, fetchImpl);
    await sendApiRequest(config, GET_INPUT, { headers: { "X-Custom": "ok" } });
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["x-custom"]).toBe("ok");
    // The SDK-managed headers are untouched.
    expect(headers["authorization"]).toBe("Bearer tk-secret");
    expect(headers["x-org-id"]).toBe("org-1");
  });

  it("does NOT retry the reserved-header rejection (composed once before the loop)", async () => {
    const { fetchImpl } = captureRequest();
    const config = makeConfig({ retry: { maxAttempts: 3, backoffMs: 1 } }, fetchImpl);
    await expect(
      sendApiRequest(config, GET_INPUT, { headers: { "Content-Type": "text/plain" } }),
    ).rejects.toThrow(/reserved header/);
    // A deterministic guard error must throw once, never re-attempt.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("sendApiRequest — baseUrl + path", () => {
  it("strips trailing slashes from baseUrl and joins paths with a single slash", async () => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({ baseUrl: "https://api.test.example.com///" }, fetchImpl);
    await sendApiRequest(config, { method: "GET", path: "run" }); // no leading slash
    expect(captured[0]!.url).toBe("https://api.test.example.com/run");
  });

  it("preserves leading slash on path", async () => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({}, fetchImpl);
    await sendApiRequest(config, { method: "GET", path: "/runs?limit=10" });
    expect(captured[0]!.url).toBe("https://api.test.example.com/runs?limit=10");
  });

  it("serializes JSON bodies on POST + sets content-type", async () => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({}, fetchImpl);
    await sendApiRequest(config, POST_INPUT);
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(captured[0]!.init.body as string)).toEqual({ workflowId: "wf-1" });
  });
});

describe("sendApiRequest — error envelope unwrap", () => {
  it("maps 422 + envelope to JanuslyValidationError carrying code + params", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(422, { error: "missing", code: "email_required", params: { field: "email" } }),
    ) as unknown as FakeFetch;
    const config = makeConfig({}, fetchImpl);
    await expect(sendApiRequest(config, POST_INPUT)).rejects.toMatchObject({
      name: "JanuslyValidationError",
      statusCode: 422,
      code: "email_required",
      params: { field: "email" },
    });
  });

  it("maps nested v1 errors to the same typed hierarchy", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, {
      apiVersion: "v1",
      requestId: "request-1",
      error: { message: "invalid", code: "invalid_input", params: { field: "body" } },
    })) as unknown as FakeFetch;
    const config = makeConfig({}, fetchImpl);
    await expect(sendApiRequest(config, { ...POST_INPUT, path: "/v1/start" })).rejects.toMatchObject({
      name: "JanuslyValidationError",
      code: "invalid_input",
      params: { field: "body" },
    });
  });

  it("maps 401 to JanuslyAuthError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "no auth" })) as unknown as FakeFetch;
    const config = makeConfig({}, fetchImpl);
    const thrown = await sendApiRequest(config, GET_INPUT).catch((err) => err);
    expect(thrown).toBeInstanceOf(JanuslyAuthError);
  });

  it("maps 429 to JanuslyRateLimitError carrying retryAfterSeconds", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, { error: "slow down" }, { "retry-after": "7" })) as unknown as FakeFetch;
    const config = makeConfig({}, fetchImpl);
    const thrown = (await sendApiRequest(config, GET_INPUT).catch((err) => err)) as JanuslyRateLimitError;
    expect(thrown).toBeInstanceOf(JanuslyRateLimitError);
    expect(thrown.retryAfterSeconds).toBe(7);
  });

  it("maps 5xx to JanuslyServerError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {})) as unknown as FakeFetch;
    const config = makeConfig({}, fetchImpl);
    await expect(sendApiRequest(config, GET_INPUT)).rejects.toBeInstanceOf(JanuslyServerError);
  });

  it("falls back to base JanuslyApiError for unknown status codes", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(418, {})) as unknown as FakeFetch;
    const config = makeConfig({}, fetchImpl);
    const thrown = await sendApiRequest(config, GET_INPUT).catch((err) => err);
    expect(thrown).toBeInstanceOf(JanuslyApiError);
    expect(thrown).not.toBeInstanceOf(JanuslyAuthError);
    expect(thrown).not.toBeInstanceOf(JanuslyServerError);
  });
});

describe("sendApiRequest — v1 success envelope", () => {
  it("unwraps stable response data", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      apiVersion: "v1",
      requestId: "request-1",
      data: { runId: "run-1" },
    })) as unknown as FakeFetch;
    const config = makeConfig({}, fetchImpl);

    await expect(sendApiRequest(config, { ...POST_INPUT, path: "/v1/start" }))
      .resolves.toEqual({ runId: "run-1" });
  });

  it("fails closed when a successful v1 response omits the envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { runId: "run-1" })) as unknown as FakeFetch;
    const config = makeConfig({}, fetchImpl);

    await expect(sendApiRequest(config, { ...POST_INPUT, path: "/v1/start" }))
      .rejects.toBeInstanceOf(JanuslyProtocolError);
  });
});

describe("sendApiRequest — retry layer (opt-in)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT retry by default", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {})) as unknown as FakeFetch;
    const config = makeConfig({}, fetchImpl);
    await expect(sendApiRequest(config, GET_INPUT)).rejects.toBeInstanceOf(JanuslyServerError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 503 up to maxAttempts then throws", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {})) as unknown as FakeFetch;
    const warn = vi.fn();
    const config = makeConfig({ retry: { maxAttempts: 2, backoffMs: 1 }, logger: { warn } }, fetchImpl);
    const promise = sendApiRequest(config, GET_INPUT);
    promise.catch(() => {}); // suppress unhandled rejection while timers advance
    await vi.runAllTimersAsync();
    await expect(promise).rejects.toBeInstanceOf(JanuslyServerError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx validation errors (not in default retryOn)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(422, { error: "no" })) as unknown as FakeFetch;
    const config = makeConfig({ retry: { maxAttempts: 3 } }, fetchImpl);
    await expect(sendApiRequest(config, POST_INPUT)).rejects.toBeInstanceOf(JanuslyValidationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("sendApiRequest — AbortSignal", () => {
  it("propagates the per-call signal to fetch", async () => {
    const { fetchImpl, captured } = captureRequest();
    const config = makeConfig({}, fetchImpl);
    const controller = new AbortController();
    await sendApiRequest(config, GET_INPUT, { signal: controller.signal });
    const passedSignal = captured[0]!.init.signal as AbortSignal | undefined;
    expect(passedSignal).toBeDefined();
  });
});
