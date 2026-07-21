import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildSlackInteractionReceiptId,
  parseSlackInteractionPayload,
  verifySlackInteractionSignature,
} from "./slack-interactions";

const secret = "slack-signing-secret";
const timestamp = 1_800_000_000;
const payload = {
  type: "block_actions",
  team: { id: "T123" },
  user: { id: "U123" },
  actions: [{ action_id: "janusly_recovery_acknowledge", value: "item-1" }],
};
const rawBody = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
const signature = `v0=${createHmac("sha256", secret)
  .update(`v0:${timestamp}:${rawBody}`)
  .digest("hex")}`;

describe("Slack interaction verification", () => {
  it("verifies exact raw bytes and parses one bounded block action", () => {
    expect(verifySlackInteractionSignature({
      timestampHeader: String(timestamp),
      signatureHeader: signature,
      rawBody,
      secret,
      nowUnixSeconds: timestamp + 10,
    })).toEqual({ valid: true, timestamp });
    expect(parseSlackInteractionPayload(rawBody)).toMatchObject(payload);
  });

  it("rejects stale, tampered, and unsupported callbacks", () => {
    expect(verifySlackInteractionSignature({
      timestampHeader: String(timestamp),
      signatureHeader: signature,
      rawBody,
      secret,
      nowUnixSeconds: timestamp + 301,
    })).toEqual({ valid: false, reason: "timestamp_skew" });
    expect(verifySlackInteractionSignature({
      timestampHeader: String(timestamp),
      signatureHeader: signature,
      rawBody: `${rawBody}x`,
      secret,
      nowUnixSeconds: timestamp,
    })).toEqual({ valid: false, reason: "signature_mismatch" });
    expect(parseSlackInteractionPayload(new URLSearchParams({
      payload: JSON.stringify({ ...payload, actions: [{ action_id: "delete_everything", value: "item-1" }] }),
    }).toString())).toBeNull();
  });

  it("builds stable receipt ids that rotate with raw bytes or timestamp", () => {
    const id = buildSlackInteractionReceiptId("connection-1", timestamp, rawBody);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(id).toBe(buildSlackInteractionReceiptId("connection-1", timestamp, rawBody));
    expect(id).not.toBe(buildSlackInteractionReceiptId("connection-1", timestamp + 1, rawBody));
  });
});
