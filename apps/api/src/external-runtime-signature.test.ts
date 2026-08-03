import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyExternalRuntimeSignature } from "./external-runtime-signature";

const BODY = '{"specversion":"1.0"}';
const SECRET = "external-runtime-secret";
const NOW = 1_800_000_000;

function signature(body = BODY, timestamp = NOW): string {
  const digest = createHmac("sha256", SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

describe("verifyExternalRuntimeSignature", () => {
  it("accepts the exact raw body inside the skew window", () => {
    expect(verifyExternalRuntimeSignature({
      signatureHeader: signature(),
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW + 10,
    })).toEqual({ valid: true, timestamp: NOW });
  });

  it("rejects tampering, malformed headers, stale timestamps, and missing secrets", () => {
    expect(verifyExternalRuntimeSignature({
      signatureHeader: signature(),
      rawBody: `${BODY}\n`,
      secret: SECRET,
      nowSeconds: NOW,
    })).toEqual({ valid: false, reason: "signature_mismatch" });
    expect(verifyExternalRuntimeSignature({
      signatureHeader: "broken",
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW,
    })).toEqual({ valid: false, reason: "malformed_header" });
    expect(verifyExternalRuntimeSignature({
      signatureHeader: signature(),
      rawBody: BODY,
      secret: SECRET,
      nowSeconds: NOW + 301,
    })).toEqual({ valid: false, reason: "timestamp_skew" });
    expect(verifyExternalRuntimeSignature({
      signatureHeader: signature(),
      rawBody: BODY,
      secret: "",
      nowSeconds: NOW,
    })).toEqual({ valid: false, reason: "missing_secret" });
  });
});
