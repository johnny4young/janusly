import { describe, expect, it } from "vitest";

import { rankRecoverySuggestions } from "./recovery-suggestion-ranking";

describe("rankRecoverySuggestions", () => {
  it("orders a copy by descending finite confidence", () => {
    const original = [
      { id: "medium", confidence: 0.5 },
      { id: "high", confidence: 0.9 },
      { id: "low", confidence: 0.1 },
    ];

    expect(rankRecoverySuggestions(original).map((item) => item.id)).toEqual([
      "high",
      "medium",
      "low",
    ]);
    expect(original.map((item) => item.id)).toEqual([
      "medium",
      "high",
      "low",
    ]);
  });

  it("preserves provider order for ties and treats invalid values as zero", () => {
    const suggestions = [
      { id: "first", confidence: 0.4 },
      { id: "second", confidence: 0.4 },
      { id: "missing" },
      { id: "nan", confidence: Number.NaN },
    ];

    expect(rankRecoverySuggestions(suggestions).map((item) => item.id)).toEqual([
      "first",
      "second",
      "missing",
      "nan",
    ]);
  });

  it("promotes bounded retry evidence over a confident URL mutation for HTTP 5xx", () => {
    const suggestions = [
      { id: "invented-url", approachLabel: "fix_url", confidence: 95 },
      { id: "bounded-retry", approachLabel: "add_retry", confidence: 55 },
      { id: "timeout", approachLabel: "raise_timeout", confidence: 75 },
    ];

    expect(
      rankRecoverySuggestions(suggestions, {
        name: "HttpResponseError",
        code: "E_HTTP_STATUS",
        message: "HTTP failed: 503",
        statusCode: 503,
      }).map((item) => item.id),
    ).toEqual([
      "bounded-retry",
      "timeout",
      "invented-url",
    ]);
  });

  it("accepts the serialized HTTP message when statusCode is unavailable", () => {
    const suggestions = [
      { id: "retry", approachLabel: "add_retry", confidence: 10 },
      { id: "url", approachLabel: "fix_url", confidence: 99 },
    ];

    expect(
      rankRecoverySuggestions(suggestions, {
        message: "The upstream returned HTTP 502 Bad Gateway",
      }).map((item) => item.id),
    ).toEqual(["retry", "url"]);
  });

  it("does not treat an unrelated three-digit quantity as an HTTP status", () => {
    const suggestions = [
      { id: "url", approachLabel: "fix_url", confidence: 99 },
      { id: "retry", approachLabel: "add_retry", confidence: 10 },
    ];

    expect(
      rankRecoverySuggestions(suggestions, {
        message: "The operation processed 500 records before validation failed",
      }).map((item) => item.id),
    ).toEqual(["url", "retry"]);
  });

  it("keeps timeout alternatives above unsupported URL changes", () => {
    const suggestions = [
      { id: "url", approachLabel: "fix_url", confidence: 100 },
      { id: "retry", approachLabel: "add_retry", confidence: 60 },
      { id: "timeout", approachLabel: "raise_timeout", confidence: 50 },
    ];

    expect(
      rankRecoverySuggestions(suggestions, {
        code: "NODE_TIMEOUT",
        message: "Node timed out after 30000 ms",
      }).map((item) => item.id),
    ).toEqual(["retry", "timeout", "url"]);
  });

  it("prefers URL repair only when the runtime evidence supports it", () => {
    const suggestions = [
      { id: "retry", approachLabel: "add_retry", confidence: 100 },
      { id: "url", approachLabel: "fix_url", confidence: 20 },
      { id: "other", approachLabel: "other", confidence: 90 },
    ];

    expect(
      rankRecoverySuggestions(suggestions, {
        message: "HTTP 404 Not Found",
      }).map((item) => item.id),
    ).toEqual(["url", "other", "retry"]);
  });

  it("prefers credential repair for authorization and missing-secret failures", () => {
    const suggestions = [
      { id: "timeout", approachLabel: "raise_timeout", confidence: 100 },
      { id: "secret", approachLabel: "swap_secret_ref", confidence: 10 },
      { id: "other", approachLabel: "other", confidence: 80 },
    ];

    expect(
      rankRecoverySuggestions(suggestions, {
        code: "E_SECRET_MISSING",
        message: "Missing secret binding",
      }).map((item) => item.id),
    ).toEqual(["secret", "other", "timeout"]);
  });
});
