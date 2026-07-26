/**
 * Webhooks resource — receiver-side signature verifier for Janusly-signed
 * webhooks. Mirrors the Stripe-style scheme the engine's `webhook.send`
 * tool emits: `x-janusly-signature: t=<unix-seconds>,v1=<hex>` where the
 * signed payload is `${unixSeconds}.${body}` and the algorithm is
 * HMAC-SHA256 with the shared secret.
 *
 * The verifier uses `crypto.timingSafeEqual` for constant-time comparison
 * and rejects timestamps outside a configurable clock-skew window
 * (default ±5 minutes). Returns the parsed timestamp on success; throws
 * `JanuslyWebhookSignatureError` with a typed `reason` on failure.
 *
 * Receivers MUST pass the RAW request body — not a parsed JSON object.
 * Re-serializing a parsed object produces different bytes (key order,
 * whitespace) and breaks the HMAC.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { JanuslyWebhookSignatureError } from "../errors.js";

/** Default skew tolerance: ±5 minutes (matches Stripe + WorkOS conventions). */
const DEFAULT_TOLERANCE_SECONDS = 300;

export type VerifyWebhookSignatureInput = {
  /** Raw body bytes as received (string or Buffer). NOT a parsed object. */
  body: string | Buffer;
  /** Value of the `x-janusly-signature` header. */
  signatureHeader: string;
  /** Shared secret known by both sender + receiver. */
  secret: string;
  /**
   * Default 300 (5 minutes). Pass 0 to disable the skew check (rarely
   * what you want — clock skew is the most common false-positive when
   * disabled, but a long-lived offline test might need it).
   */
  toleranceSeconds?: number;
  /**
   * Injectable "current time" in unix seconds. Tests pass a fixed value;
   * production omits + the verifier uses `Date.now()`.
   */
  nowSeconds?: number;
};

export type VerifyWebhookSignatureResult = {
  /** Timestamp parsed from the signature header. */
  timestamp: number;
};

export class WebhooksResource {
  /**
   * Verify a Janusly-signed webhook. Static-style — doesn't need the
   * `JanuslyClient` config since verification is local (no HTTP). Bound
   * via `client.webhooks` for API consistency.
   *
   * Throws `JanuslyWebhookSignatureError` on:
   *   - malformed header (missing t= or v1= parts) → `reason: "malformed_header"`
   *   - timestamp outside the tolerance window → `reason: "timestamp_skew"`
   *   - HMAC mismatch (tampered body / wrong secret) → `reason: "signature_mismatch"`
   */
  verifySignature(input: VerifyWebhookSignatureInput): VerifyWebhookSignatureResult {
    const parsed = parseSignatureHeader(input.signatureHeader);
    const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

    if (tolerance > 0) {
      const skew = Math.abs(now - parsed.timestamp);
      if (skew > tolerance) {
        throw new JanuslyWebhookSignatureError(
          `webhook timestamp outside tolerance window (skew=${skew}s, tolerance=${tolerance}s)`,
          "timestamp_skew",
        );
      }
    }

    const bodyString = typeof input.body === "string" ? input.body : input.body.toString("utf8");
    const signedPayload = `${parsed.timestamp}.${bodyString}`;
    const expectedHex = createHmac("sha256", input.secret).update(signedPayload).digest("hex");

    if (!constantTimeHexEqual(parsed.signatureHex, expectedHex)) {
      throw new JanuslyWebhookSignatureError(
        "webhook signature did not match",
        "signature_mismatch",
      );
    }

    return { timestamp: parsed.timestamp };
  }
}

/** Parse the `t=<unix-seconds>,v1=<hex>` header shape. */
function parseSignatureHeader(header: string): { timestamp: number; signatureHex: string } {
  if (typeof header !== "string" || header.length === 0) {
    throw new JanuslyWebhookSignatureError("webhook signature header is empty", "malformed_header");
  }
  const parts = header.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  let timestamp: number | null = null;
  let signatureHex: string | null = null;
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key === "t") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0) timestamp = n;
    } else if (key === "v1") {
      if (/^[0-9a-fA-F]+$/.test(value)) signatureHex = value.toLowerCase();
    }
  }
  if (timestamp === null || signatureHex === null) {
    throw new JanuslyWebhookSignatureError(
      "webhook signature header missing t= or v1= part",
      "malformed_header",
    );
  }
  return { timestamp, signatureHex };
}

/**
 * Constant-time hex string equality. `timingSafeEqual` throws on length
 * mismatch — we check length first and return false (also constant-time
 * for the length check since `.length` is O(1)).
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
