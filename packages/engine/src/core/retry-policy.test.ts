/**
 * Tests for the retry-policy evaluator. `classifyError` is the shared
 * vocabulary behind BOTH `retryOn`/`ignoreOn` matching and the transient
 * fast path, so its labels are a contract — including the regression that the
 * executor's own `NodeTimeoutError` ("… timed out after 30000ms", code
 * NODE_TIMEOUT) must carry the `timeout` label.
 */

import { describe, expect, it } from "vitest";

import { HttpResponseError } from "./http-error";
import { classifyError, computeRetryDelay, shouldRetry } from "./retry-policy";
import { NodeTimeoutError } from "./timeout";
import type { SerializedError } from "./types";

/** Serialize a thrown error the way `core/runtime.ts` does before classifying. */
function serialize(thrown: Error & { code?: string; statusCode?: number }): SerializedError {
  return { message: thrown.message, name: thrown.name, code: thrown.code, statusCode: thrown.statusCode };
}

function err(overrides: Partial<SerializedError>): SerializedError {
  return { message: "boom", ...overrides };
}

describe("classifyError", () => {
  it("labels the HTTP status, its family, the name, and the code", () => {
    const labels = classifyError(err({ name: "HttpError", code: "E_HTTP", statusCode: 503 }));
    expect(labels).toEqual(expect.arrayContaining(["HttpError", "E_HTTP", "503", "5xx"]));
  });

  it("labels the executor's own NodeTimeoutError as a timeout (regression)", () => {
    // The message says "timed out", not "timeout", and the code is
    // NODE_TIMEOUT — matching only the literal "timeout" left every
    // `retryOn: ["timeout"]` policy silently dead for node timeouts.
    const thrown = new NodeTimeoutError(30_000, "http");
    expect(classifyError(serialize(thrown))).toContain("timeout");
  });

  it("labels an http node's own failure by status and family (regression)", () => {
    // The http node used to throw a plain `Error("HTTP failed: 429")`, so the
    // status lived only in the message and `classifyError` never emitted the
    // "429" / "4xx" labels — every retryOn:["5xx"] policy (the one the AI
    // patch surface and the readiness rule both recommend) was silently dead
    // for the most common node type.
    const labels = classifyError(serialize(new HttpResponseError(429)));
    expect(labels).toEqual(expect.arrayContaining(["429", "4xx", "HttpResponseError", "E_HTTP_STATUS"]));
    expect(classifyError(serialize(new HttpResponseError(503)))).toEqual(expect.arrayContaining(["503", "5xx"]));
  });

  it("labels timeouts from the conventional wordings and codes", () => {
    expect(classifyError(err({ message: "Request timeout" }))).toContain("timeout");
    expect(classifyError(err({ code: "ETIMEDOUT" }))).toContain("timeout");
  });

  it("labels network faults", () => {
    expect(classifyError(err({ code: "ECONNRESET" }))).toContain("network");
    expect(classifyError(err({ code: "ENOTFOUND" }))).toContain("network");
    expect(classifyError(err({ message: "network unreachable" }))).toContain("network");
  });
});

describe("shouldRetry", () => {
  it("returns false without a policy", () => {
    expect(shouldRetry(err({ statusCode: 500 }))).toBe(false);
  });

  it("retries everything not ignored when retryOn is absent", () => {
    expect(shouldRetry(err({ statusCode: 500 }), { maxAttempts: 3 })).toBe(true);
  });

  it("honours ignoreOn ahead of retryOn", () => {
    const policy = { maxAttempts: 3, retryOn: ["5xx"], ignoreOn: ["503"] };
    expect(shouldRetry(err({ statusCode: 500 }), policy)).toBe(true);
    expect(shouldRetry(err({ statusCode: 503 }), policy)).toBe(false);
  });

  it("matches the \\dxx family pattern but not looser prefixes", () => {
    expect(shouldRetry(err({ statusCode: 502 }), { retryOn: ["5xx"] })).toBe(true);
    expect(shouldRetry(err({ statusCode: 404 }), { retryOn: ["5xx"] })).toBe(false);
  });

  it("retries a node timeout under a retryOn: ['timeout'] policy (regression)", () => {
    expect(shouldRetry(serialize(new NodeTimeoutError(30_000, "http")), { maxAttempts: 3, retryOn: ["timeout"] })).toBe(true);
  });

  it("retries an http 5xx under the retryOn: ['5xx'] policy the product recommends (regression)", () => {
    expect(shouldRetry(serialize(new HttpResponseError(502)), { maxAttempts: 3, retryOn: ["5xx"] })).toBe(true);
    expect(shouldRetry(serialize(new HttpResponseError(404)), { maxAttempts: 3, retryOn: ["5xx"] })).toBe(false);
  });
});

describe("computeRetryDelay", () => {
  it("returns 0 without a policy and the base delay for a fixed backoff", () => {
    expect(computeRetryDelay(1)).toBe(0);
    expect(computeRetryDelay(2, { delayMs: 1_000 })).toBe(1_000);
  });

  it("doubles per attempt on exponential backoff and honours the cap", () => {
    expect(computeRetryDelay(1, { delayMs: 1_000, backoff: "exponential" })).toBe(1_000);
    expect(computeRetryDelay(3, { delayMs: 1_000, backoff: "exponential" })).toBe(4_000);
    expect(computeRetryDelay(5, { delayMs: 1_000, backoff: "exponential", maxDelayMs: 5_000 })).toBe(5_000);
  });

  it("keeps a jittered delay inside [half, full] of the computed delay", () => {
    for (let i = 0; i < 20; i += 1) {
      const delay = computeRetryDelay(2, { delayMs: 1_000, jitter: true });
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
  });
});
