import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  ExternalRuntimeObserver,
  signExternalRuntimeEvent,
  type ExternalRuntimeEvent,
} from "./external-runtime.js";

const event: ExternalRuntimeEvent = {
  specversion: "1.0",
  id: "temporal-event-42",
  source: "urn:temporal:payments",
  type: "io.janusly.external.run.observed",
  time: "2026-07-27T12:30:00.000Z",
  data: {
    externalWorkflowId: "payments",
    externalRunId: "run-42",
    sequence: 7,
    status: "failed",
  },
};

describe("ExternalRuntimeObserver", () => {
  it("posts the exact signed event and returns the bounded receipt", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rawBody = String(init?.body);
      const timestamp = 1_800_000_000;
      const expected = createHmac("sha256", "observer-secret")
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
      expect(init?.headers).toMatchObject({
        "content-type": "application/json",
        "x-janusly-signature": `t=${timestamp},v1=${expected}`,
      });
      expect(JSON.parse(rawBody)).toEqual(event);
      return new Response(JSON.stringify({
        accepted: true,
        duplicate: false,
        projectionState: "applied",
        eventId: event.id,
        receivedAt: "2026-07-27T12:30:01.000Z",
      }), { status: 202, headers: { "content-type": "application/json" } });
    });
    const observer = new ExternalRuntimeObserver({
      callbackUrl: "https://janusly.example.test/webhooks/external-runtimes/observer-1",
      secret: "observer-secret",
      fetch: fetchMock as typeof fetch,
    });

    await expect(observer.send(event, { timestampSeconds: 1_800_000_000 }))
      .resolves.toMatchObject({ accepted: true, eventId: event.id });
  });

  it("uses the shared signature shape and rejects unsafe callback configuration", () => {
    expect(signExternalRuntimeEvent("secret", "{}", 1_700_000_000))
      .toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(() => new ExternalRuntimeObserver({
      callbackUrl: "http://janusly.example.test/callback",
      secret: "secret",
    })).toThrow(/https/);
    expect(() => new ExternalRuntimeObserver({
      callbackUrl: "https://janusly.example.test/callback",
      secret: "",
    })).toThrow(/secret is required/);
  });

  it("fails closed on non-success or malformed receipts", async () => {
    const observer = new ExternalRuntimeObserver({
      callbackUrl: "http://127.0.0.1:7311/webhooks/external-runtimes/observer-1",
      secret: "observer-secret",
      fetch: vi.fn(async () => new Response('{"accepted":true}', { status: 202 })) as typeof fetch,
    });
    await expect(observer.send(event)).rejects.toThrow(/callback rejected event/);
  });
});
