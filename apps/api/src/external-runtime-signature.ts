/**
 * Verifier for the Janusly webhook signature format used by external runtime
 * observers: `t=<unix-seconds>,v1=<hex>` over `${timestamp}.${rawBody}`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;

export type ExternalRuntimeSignatureResult =
  | { valid: true; timestamp: number }
  | { valid: false; reason: "missing_secret" | "malformed_header" | "timestamp_skew" | "signature_mismatch" };

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyExternalRuntimeSignature(input: {
  signatureHeader: string | null;
  rawBody: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): ExternalRuntimeSignatureResult {
  if (!input.secret) return { valid: false, reason: "missing_secret" };
  const parts = (input.signatureHeader ?? "").split(",").map((part) => part.trim());
  const timestampValue = parts.find((part) => part.startsWith("t="))?.slice(2) ?? "";
  const signature = parts.find((part) => part.startsWith("v1="))?.slice(3).toLowerCase() ?? "";
  if (!/^\d+$/.test(timestampValue) || !/^[0-9a-f]{64}$/.test(signature)) {
    return { valid: false, reason: "malformed_header" };
  }
  const timestamp = Number(timestampValue);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_skew" };
  }
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest("hex");
  return constantTimeHexEqual(signature, expected)
    ? { valid: true, timestamp }
    : { valid: false, reason: "signature_mismatch" };
}
