import { describe, expect, it } from "vitest";
import {
  FALLBACK_SIGNATURE_MAX_LENGTH,
  normalizeErrorSignature,
  scrubSecretShapes,
} from "./error-signature";

describe("normalizeErrorSignature — secret_missing", () => {
  it("recognises `secret 'GITHUB_TOKEN' not found`", () => {
    const result = normalizeErrorSignature(
      new Error("secret 'GITHUB_TOKEN' not found"),
      { nodeType: "tool" },
    );
    expect(result.signature).toBe("Missing secret: GITHUB_TOKEN");
    expect(result.category).toBe("secret_missing");
    expect(result.suggestedOwner).toBe("ops");
  });

  it("recognises `Missing env variable: OPENAI_API_KEY`", () => {
    const result = normalizeErrorSignature(
      new Error("Missing env variable: OPENAI_API_KEY"),
      { nodeType: "ai" },
    );
    expect(result.signature).toBe("Missing secret: OPENAI_API_KEY");
    expect(result.category).toBe("secret_missing");
  });

  it("recognises explicit `code: E_SECRET_MISSING` envelope", () => {
    const error = { code: "E_SECRET_MISSING", secret: "STRIPE_API_KEY", message: "secret missing" };
    const result = normalizeErrorSignature(error);
    expect(result.signature).toBe("Missing secret: STRIPE_API_KEY");
    expect(result.category).toBe("secret_missing");
  });
});

describe("normalizeErrorSignature — http_error", () => {
  it("extracts status from `error.statusCode`", () => {
    const error = { statusCode: 401, message: "Unauthorized" };
    const result = normalizeErrorSignature(error, { nodeType: "http" });
    expect(result.signature).toBe("HTTP 401 on http node");
    expect(result.category).toBe("http_error");
    expect(result.suggestedOwner).toBe("workflow_author");
  });

  it("extracts status from message regex when no field is present", () => {
    const result = normalizeErrorSignature(
      new Error("Request failed with HTTP 503 from upstream"),
      { nodeType: "tool" },
    );
    expect(result.signature).toBe("HTTP 503 on tool node");
    expect(result.category).toBe("http_error");
  });
});

describe("normalizeErrorSignature — network_timeout", () => {
  it("recognises `ECONNRESET`", () => {
    const result = normalizeErrorSignature(
      new Error("read ECONNRESET"),
      { nodeType: "http" },
    );
    expect(result.signature).toBe("Network timeout on http node");
    expect(result.category).toBe("network_timeout");
  });
});

describe("normalizeErrorSignature — ai_provider", () => {
  it("recognises `insufficient_quota`", () => {
    const error = { provider: "openai", message: "insufficient_quota" };
    const result = normalizeErrorSignature(error, { nodeType: "ai" });
    expect(result.signature).toBe("OpenAI quota exceeded");
    expect(result.category).toBe("ai_provider");
    expect(result.suggestedOwner).toBe("platform");
  });

  it("recognises `context_length_exceeded`", () => {
    const error = { provider: "openai", message: "context_length_exceeded: 8192 token cap" };
    const result = normalizeErrorSignature(error, { nodeType: "ai" });
    expect(result.signature).toBe("OpenAI context too long");
  });

  it("uses `aiError` envelope field when set", () => {
    const error = { aiError: "rate limit reached", provider: "anthropic" };
    const result = normalizeErrorSignature(error, { nodeType: "ai" });
    expect(result.signature).toBe("Anthropic rate limit");
  });
});

describe("normalizeErrorSignature — parse_error", () => {
  it("recognises `Unexpected token < in JSON`", () => {
    const result = normalizeErrorSignature(
      new Error("Unexpected token < in JSON at position 0"),
      { nodeType: "http" },
    );
    expect(result.signature).toBe("Parse error in http node");
    expect(result.category).toBe("parse_error");
  });
});

describe("normalizeErrorSignature — tool_input", () => {
  it("recognises `Invalid tool input: github.create_issue`", () => {
    const result = normalizeErrorSignature(
      new Error("Invalid tool input: github.create_issue"),
      { nodeType: "tool" },
    );
    expect(result.signature).toBe("Invalid tool input: github.create_issue");
    expect(result.category).toBe("tool_input");
  });

  it("recognises `tool '...' not found`", () => {
    const result = normalizeErrorSignature(
      new Error("tool 'mystery.thing' not found"),
      { nodeType: "tool" },
    );
    expect(result.signature).toBe("Tool not found: mystery.thing");
    expect(result.category).toBe("tool_input");
  });
});

describe("normalizeErrorSignature — unknown fallback + secret-shape scrub", () => {
  it("falls back, scrubs, and truncates at 80 chars", () => {
    const longMessage = "a".repeat(120);
    const result = normalizeErrorSignature(new Error(longMessage));
    expect(result.category).toBe("unknown");
    expect(result.signature.length).toBeLessThanOrEqual(FALLBACK_SIGNATURE_MAX_LENGTH);
    expect(result.signature.endsWith("…")).toBe(true);
  });

  it("uses a non-empty fallback label when no message is available", () => {
    const result = normalizeErrorSignature({ code: "E_UNKNOWN" });
    expect(result.category).toBe("unknown");
    expect(result.signature).toBe("Unknown error");
  });

  it("scrubs `Authorization: Bearer sk-…` from any signature path", () => {
    // No HTTP status, no other rule matches — falls into unknown but the
    // bearer shape must be replaced with [redacted] before return.
    const message = "Authorization: Bearer sk-1234567890abcdefghij rejected";
    const result = normalizeErrorSignature(new Error(message));
    expect(result.signature).not.toContain("sk-1234567890abcdefghij");
    expect(result.signature).toContain("[redacted]");
  });

  it("scrubs `ghp_…` GitHub tokens", () => {
    const message = "Tool failed because token ghp_abcdefghijklmnopqrstuv was rejected";
    const result = normalizeErrorSignature(new Error(message));
    expect(result.signature).not.toContain("ghp_abcdefghijklmnopqrstuv");
    expect(result.signature).toContain("[redacted]");
  });

  it("scrubs JWT-shaped tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = normalizeErrorSignature(new Error(`auth ${jwt} expired`));
    expect(result.signature).not.toContain(jwt);
    expect(result.signature).toContain("[redacted]");
  });

  it("scrubSecretShapes is exported for direct use", () => {
    expect(scrubSecretShapes("hello sk-aaaaaaaaaaaaaaaaaaaa world")).toBe("hello [redacted] world");
  });

  it("scrubs token shapes when they are adjacent to underscores or punctuation", () => {
    const token = "ghp_abcdefghijklmnopqrstuv";
    expect(scrubSecretShapes(`notify_${token}.failed`)).toBe("notify_[redacted].failed");
  });
});
