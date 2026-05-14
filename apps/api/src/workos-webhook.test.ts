/**
 * Tests for `verifyWorkOsWebhookSignature` — pure HMAC verifier.
 * Asserts the closed-set rejection reasons + the constant-time
 * comparison + the timestamp tolerance window.
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { verifyWorkOsWebhookSignature } from "./workos-webhook";

const SECRET = "test-secret-do-not-use-in-prod";
const TOLERANCE = 300;

function signHeader(rawBody: string, timestamp: number, secret = SECRET): string {
  const hex = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${hex}`;
}

describe("verifyWorkOsWebhookSignature", () => {
  it("accepts a valid signature at the current timestamp", () => {
    const ts = Date.now();
    const body = '{"id":"evt_1","event":"dsync.user.created"}';
    const header = signHeader(body, ts);
    const result = verifyWorkOsWebhookSignature({ header, rawBody: body, secret: SECRET });
    expect(result.valid).toBe(true);
  });

  it("rejects with missing_secret when the secret is empty (fails closed)", () => {
    const ts = Date.now();
    const header = signHeader("body", ts);
    const result = verifyWorkOsWebhookSignature({ header, rawBody: "body", secret: "" });
    expect(result).toEqual({ valid: false, reason: "missing_secret" });
  });

  it("rejects with missing_header when no header is provided", () => {
    const result = verifyWorkOsWebhookSignature({ header: null, rawBody: "body", secret: SECRET });
    expect(result).toEqual({ valid: false, reason: "missing_header" });
  });

  it("rejects with malformed_header on garbage", () => {
    const result = verifyWorkOsWebhookSignature({ header: "garbage", rawBody: "body", secret: SECRET });
    expect(result).toEqual({ valid: false, reason: "malformed_header" });
  });

  it("rejects with malformed_header when v1 is non-hex", () => {
    const ts = Date.now();
    const result = verifyWorkOsWebhookSignature({
      header: `t=${ts},v1=notHexAtAll!!`,
      rawBody: "body",
      secret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: "malformed_header" });
  });

  it("rejects with expired when timestamp is older than tolerance", () => {
    const now = Date.now();
    const expired = now - (TOLERANCE + 60) * 1000;
    const header = signHeader("body", expired);
    const result = verifyWorkOsWebhookSignature({ header, rawBody: "body", secret: SECRET });
    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects with future_timestamp when timestamp is too far in the future", () => {
    const now = Date.now();
    const future = now + (TOLERANCE + 60) * 1000;
    const header = signHeader("body", future);
    const result = verifyWorkOsWebhookSignature({ header, rawBody: "body", secret: SECRET });
    expect(result).toEqual({ valid: false, reason: "future_timestamp" });
  });

  it("rejects with signature_mismatch when the body has been tampered", () => {
    const ts = Date.now();
    const header = signHeader("original body", ts);
    const result = verifyWorkOsWebhookSignature({ header, rawBody: "tampered body", secret: SECRET });
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects with signature_mismatch when the secret is wrong", () => {
    const ts = Date.now();
    const header = signHeader("body", ts, "different-secret");
    const result = verifyWorkOsWebhookSignature({ header, rawBody: "body", secret: SECRET });
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("accepts a signature at the inner boundary of the tolerance window", () => {
    const fixedNow = 1_700_000_000_000; // fixed clock
    const ts = fixedNow - TOLERANCE * 1000; // exactly at the boundary
    const header = signHeader("body", ts);
    const result = verifyWorkOsWebhookSignature({
      header,
      rawBody: "body",
      secret: SECRET,
      now: () => fixedNow,
    });
    expect(result.valid).toBe(true);
  });
});
