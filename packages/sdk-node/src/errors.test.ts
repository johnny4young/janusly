import { describe, expect, it } from "vitest";
import {
  JanuslyApiError,
  JanuslyAuthError,
  JanuslyRateLimitError,
  JanuslyServerError,
  JanuslyValidationError,
  parseRetryAfterSeconds,
} from "./errors.ts";

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe("JanuslyApiError.fromResponse", () => {
  it("dispatches 401 / 403 to JanuslyAuthError", () => {
    expect(JanuslyApiError.fromResponse(makeResponse(401), { error: "no", code: "no_auth" })).toBeInstanceOf(JanuslyAuthError);
    expect(JanuslyApiError.fromResponse(makeResponse(403), { error: "no" })).toBeInstanceOf(JanuslyAuthError);
  });

  it("dispatches 400 / 422 to JanuslyValidationError and preserves code + params", () => {
    const err = JanuslyApiError.fromResponse(makeResponse(422), {
      error: "missing field",
      code: "email_required",
      params: { field: "email" },
    });
    expect(err).toBeInstanceOf(JanuslyValidationError);
    expect(err.code).toBe("email_required");
    expect(err.params).toEqual({ field: "email" });
  });

  it("dispatches 429 to JanuslyRateLimitError and parses Retry-After", () => {
    const res = makeResponse(429, { "retry-after": "42" });
    const err = JanuslyApiError.fromResponse(res, { error: "too many" });
    expect(err).toBeInstanceOf(JanuslyRateLimitError);
    expect((err as JanuslyRateLimitError).retryAfterSeconds).toBe(42);
  });

  it("dispatches 5xx to JanuslyServerError; unknown statuses fall through to the base class", () => {
    expect(JanuslyApiError.fromResponse(makeResponse(500), {})).toBeInstanceOf(JanuslyServerError);
    expect(JanuslyApiError.fromResponse(makeResponse(503), {})).toBeInstanceOf(JanuslyServerError);
    const tea = JanuslyApiError.fromResponse(makeResponse(418), {});
    expect(tea).toBeInstanceOf(JanuslyApiError);
    expect(tea).not.toBeInstanceOf(JanuslyServerError);
    expect(tea).not.toBeInstanceOf(JanuslyAuthError);
  });

  it("falls back to a synthesized message when the envelope is empty", () => {
    const err = JanuslyApiError.fromResponse(makeResponse(404), null);
    expect(err.message).toContain("404");
    expect(err.code).toBeUndefined();
    expect(err.params).toBeUndefined();
  });
});

describe("parseRetryAfterSeconds", () => {
  it("parses seconds-integer form", () => {
    expect(parseRetryAfterSeconds("30")).toBe(30);
    expect(parseRetryAfterSeconds("0")).toBe(0);
  });

  it("parses HTTP-date form", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const seconds = parseRetryAfterSeconds(future);
    expect(seconds).toBeGreaterThan(50);
    expect(seconds).toBeLessThanOrEqual(61);
  });

  it("returns 0 for past HTTP-date", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterSeconds(past)).toBe(0);
  });

  it("returns undefined for malformed input", () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds("")).toBeUndefined();
    expect(parseRetryAfterSeconds("not-a-number-or-date")).toBeUndefined();
  });
});
