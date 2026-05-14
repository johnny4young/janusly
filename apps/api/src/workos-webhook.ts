/**
 * WorkOS webhook signature verifier — HMAC-SHA256 Stripe-style.
 *
 * WorkOS signs every webhook with a `WorkOS-Signature` header of the
 * form `t=<unix-milliseconds>,v1=<hex>`, where `<hex>` is
 * `HMAC-SHA256(secret, "<t>.<rawBody>")`. The shared secret is
 * configured per Janusly deployment via `WORKOS_WEBHOOK_SECRET`.
 *
 * This module is pure — no I/O, no env reads (the caller passes
 * `secret` explicitly so tests can inject fixtures and the route
 * handler can fail closed on missing-secret without coupling). The
 * `timingSafeEqual` comparison defends against timing-leak side
 * channels on the hex compare.
 *
 * The verifier mirrors the OUTBOUND signature shape that
 * `webhook.send` emits in `packages/engine/src/integration-tools.ts`
 * — same algorithm, opposite direction.
 *
 * Used by:
 * - `apps/api/src/routes/scim-routes.ts` (POST /webhooks/workos/directory).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookVerificationResult =
  | { valid: true }
  | {
    valid: false;
    reason:
      | "missing_header"
      | "malformed_header"
      | "missing_secret"
      | "expired"
      | "future_timestamp"
      | "signature_mismatch";
  };

const DEFAULT_TOLERANCE_SECONDS = 300; // ±5 minutes

/**
 * Verify a `WorkOS-Signature` header against the raw request body.
 *
 * @param header The header value (NOT including the `WorkOS-Signature:` prefix).
 * @param rawBody The exact bytes of the request body — JSON.stringify'd
 *   reparses do NOT round-trip byte-identically across implementations,
 *   so the caller must pass the raw stream contents.
 * @param secret The shared HMAC secret. Empty / undefined → reject every
 *   webhook (fails closed).
 * @param timestampToleranceSeconds Max difference between header timestamp
 *   and current time. Default 300s (±5 min).
 * @param now Injectable clock for tests.
 */
export function verifyWorkOsWebhookSignature(input: {
  header: string | null | undefined;
  rawBody: string;
  secret: string | null | undefined;
  timestampToleranceSeconds?: number;
  now?: () => number;
}): WebhookVerificationResult {
  if (!input.secret) return { valid: false, reason: "missing_secret" };
  if (!input.header) return { valid: false, reason: "missing_header" };

  const parts = input.header.split(",").map((p) => p.trim());
  let timestampStr: string | null = null;
  let signatureHex: string | null = null;
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k === "t") timestampStr = v;
    else if (k === "v1") signatureHex = v;
  }
  if (!timestampStr || !signatureHex) {
    return { valid: false, reason: "malformed_header" };
  }
  if (!/^[0-9a-fA-F]+$/.test(signatureHex) || signatureHex.length % 2 !== 0) {
    return { valid: false, reason: "malformed_header" };
  }
  const timestampMs = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return { valid: false, reason: "malformed_header" };
  }

  const nowMs = (input.now ?? Date.now)();
  const toleranceMs = (input.timestampToleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS) * 1000;
  const deltaMs = nowMs - timestampMs;
  if (deltaMs > toleranceMs) return { valid: false, reason: "expired" };
  if (deltaMs < -toleranceMs) return { valid: false, reason: "future_timestamp" };

  const expectedHex = createHmac("sha256", input.secret)
    .update(`${timestampMs}.${input.rawBody}`)
    .digest("hex");

  // Constant-time compare. Equal-length precheck because timingSafeEqual
  // throws when lengths differ — that throw would itself leak length
  // info if the caller relied on exception type, so we map to a uniform
  // signature_mismatch rejection.
  if (expectedHex.length !== signatureHex.length) {
    return { valid: false, reason: "signature_mismatch" };
  }
  const a = Buffer.from(expectedHex, "utf8");
  const b = Buffer.from(signatureHex, "utf8");
  if (!timingSafeEqual(a, b)) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
}
