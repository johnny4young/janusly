import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JanuslyWebhookSignatureError } from "../errors.ts";
import { WebhooksResource } from "./webhooks.ts";

/**
 * Match the engine's `signWebhookPayload` exactly so the SDK verifier
 * round-trips against real engine output.
 */
function signEngineStyle(secret: string, body: string, timestamp: number): string {
  const signed = `${timestamp}.${body}`;
  const hex = createHmac("sha256", secret).update(signed).digest("hex");
  return `t=${timestamp},v1=${hex}`;
}

describe("WebhooksResource.verifySignature", () => {
  const SECRET = "s3cret-shared-key";
  const BODY = JSON.stringify({ event: "node.completed", runId: "run-1" });

  it("accepts a valid signature emitted by the engine's signing scheme", () => {
    const verifier = new WebhooksResource();
    const now = 1_716_000_000;
    const header = signEngineStyle(SECRET, BODY, now);

    const result = verifier.verifySignature({
      body: BODY,
      signatureHeader: header,
      secret: SECRET,
      nowSeconds: now,
    });
    expect(result.timestamp).toBe(now);
  });

  it("accepts the body as a Buffer too", () => {
    const verifier = new WebhooksResource();
    const now = 1_716_000_000;
    const header = signEngineStyle(SECRET, BODY, now);

    const result = verifier.verifySignature({
      body: Buffer.from(BODY, "utf8"),
      signatureHeader: header,
      secret: SECRET,
      nowSeconds: now,
    });
    expect(result.timestamp).toBe(now);
  });

  it("rejects a tampered body with reason signature_mismatch", () => {
    const verifier = new WebhooksResource();
    const now = 1_716_000_000;
    const header = signEngineStyle(SECRET, BODY, now);

    try {
      verifier.verifySignature({
        body: BODY + " evil-extra-bytes",
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: now,
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(JanuslyWebhookSignatureError);
      expect((err as JanuslyWebhookSignatureError).reason).toBe("signature_mismatch");
    }
  });

  it("rejects timestamps outside the tolerance window with reason timestamp_skew", () => {
    const verifier = new WebhooksResource();
    const signedAt = 1_716_000_000;
    const header = signEngineStyle(SECRET, BODY, signedAt);
    // Default tolerance is 300s; force a 10-minute clock-skew.
    const nowMuchLater = signedAt + 600;

    try {
      verifier.verifySignature({
        body: BODY,
        signatureHeader: header,
        secret: SECRET,
        nowSeconds: nowMuchLater,
      });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(JanuslyWebhookSignatureError);
      expect((err as JanuslyWebhookSignatureError).reason).toBe("timestamp_skew");
    }
  });

  it("honours toleranceSeconds: 0 to disable the skew check", () => {
    const verifier = new WebhooksResource();
    const signedAt = 1_716_000_000;
    const header = signEngineStyle(SECRET, BODY, signedAt);
    const result = verifier.verifySignature({
      body: BODY,
      signatureHeader: header,
      secret: SECRET,
      nowSeconds: signedAt + 86_400,
      toleranceSeconds: 0,
    });
    expect(result.timestamp).toBe(signedAt);
  });

  it("rejects a malformed signature header with reason malformed_header", () => {
    const verifier = new WebhooksResource();
    const cases = ["", "no-equals-sign-here", "t=", "v1=", "t=abc,v1=xyz", "t=1234"];
    for (const header of cases) {
      try {
        verifier.verifySignature({ body: BODY, signatureHeader: header, secret: SECRET, nowSeconds: 1_716_000_000 });
        expect.fail(`expected throw for header: ${header}`);
      } catch (err) {
        expect(err).toBeInstanceOf(JanuslyWebhookSignatureError);
        expect((err as JanuslyWebhookSignatureError).reason).toBe("malformed_header");
      }
    }
  });

  it("rejects when v1 hex is the wrong length (also signature_mismatch)", () => {
    const verifier = new WebhooksResource();
    const now = 1_716_000_000;
    // Hex is the wrong length — different from the expected 64-char SHA256 hex.
    const header = `t=${now},v1=deadbeef`;
    try {
      verifier.verifySignature({ body: BODY, signatureHeader: header, secret: SECRET, nowSeconds: now });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(JanuslyWebhookSignatureError);
      expect((err as JanuslyWebhookSignatureError).reason).toBe("signature_mismatch");
    }
  });
});
