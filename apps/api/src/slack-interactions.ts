/**
 * Slack interactive-callback verification and parsing.
 *
 * Used by `routes/slack-interactions-routes.ts`. Pure except for crypto and
 * wall-clock inputs: callers pass `nowUnixSeconds` in tests. The exact raw
 * URL-encoded body is signed; parsing happens only after verification.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  SLACK_ACTION_ACKNOWLEDGE,
  SLACK_ACTION_ASSIGN_TO_ME,
  SLACK_ACTION_OPEN,
} from "@janusly/shared";

export const SLACK_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
export { SLACK_ACTION_ACKNOWLEDGE, SLACK_ACTION_ASSIGN_TO_ME, SLACK_ACTION_OPEN };

const SlackInteractionPayloadSchema = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string().min(1).max(64) }).passthrough(),
  user: z.object({ id: z.string().min(1).max(128) }).passthrough(),
  actions: z.array(z.object({
    action_id: z.enum([
      SLACK_ACTION_ACKNOWLEDGE,
      SLACK_ACTION_ASSIGN_TO_ME,
      SLACK_ACTION_OPEN,
    ]),
    value: z.string().min(1).max(256),
  }).passthrough()).length(1),
}).passthrough();

export type SlackInteractionPayload = z.infer<typeof SlackInteractionPayloadSchema>;

export type SlackSignatureVerification =
  | { valid: true; timestamp: number }
  | { valid: false; reason: "missing_secret" | "malformed_timestamp" | "timestamp_skew" | "malformed_signature" | "signature_mismatch" };

/** Verify Slack's `v0=<hex>` HMAC over `v0:<timestamp>:<rawBody>`. */
export function verifySlackInteractionSignature(input: {
  timestampHeader: string | null;
  signatureHeader: string | null;
  rawBody: string;
  secret: string;
  nowUnixSeconds?: number;
}): SlackSignatureVerification {
  if (!input.secret) return { valid: false, reason: "missing_secret" };
  if (!input.timestampHeader || !/^\d{1,12}$/.test(input.timestampHeader)) {
    return { valid: false, reason: "malformed_timestamp" };
  }
  const timestamp = Number.parseInt(input.timestampHeader, 10);
  const now = input.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > SLACK_SIGNATURE_MAX_AGE_SECONDS) {
    return { valid: false, reason: "timestamp_skew" };
  }
  if (!input.signatureHeader || !/^v0=[a-f0-9]{64}$/.test(input.signatureHeader)) {
    return { valid: false, reason: "malformed_signature" };
  }
  const expected = `v0=${createHmac("sha256", input.secret)
    .update(`v0:${timestamp}:${input.rawBody}`)
    .digest("hex")}`;
  const actualBuffer = Buffer.from(input.signatureHeader);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true, timestamp };
}

/** Parse one exact Slack form-encoded `payload` field after signature pass. */
export function parseSlackInteractionPayload(rawBody: string): SlackInteractionPayload | null {
  const form = new URLSearchParams(rawBody);
  const payloads = form.getAll("payload");
  if (payloads.length !== 1) return null;
  try {
    const parsed = SlackInteractionPayloadSchema.safeParse(JSON.parse(payloads[0]!));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Digest one verified callback into its durable replay-claim id. */
export function buildSlackInteractionReceiptId(
  connectionId: string,
  timestamp: number,
  rawBody: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([connectionId, timestamp, rawBody]))
    .digest("hex");
}
