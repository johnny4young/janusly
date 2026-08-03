/**
 * Generic emitter for the external-runtime shadow callback.
 *
 * This helper is intentionally independent from `JanuslyClient`: the callback
 * uses a connection-scoped HMAC secret rather than API bearer authentication.
 * Callers own their source event ids and monotonic sequence numbers so retries
 * can resend the exact same event safely.
 */

import { createHmac } from "node:crypto";

export type ExternalRuntimeStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type ExternalRuntimeEvent = {
  specversion: "1.0";
  id: string;
  source: string;
  subject?: string;
  time: string;
  datacontenttype?: "application/json";
  type:
    | "io.janusly.external.workflow.observed"
    | "io.janusly.external.run.observed"
    | "io.janusly.external.step.observed";
  data: Record<string, unknown> & { sequence: number; externalWorkflowId: string };
};

export type ExternalRuntimeObserverConfig = {
  callbackUrl: string;
  secret: string;
  fetch?: typeof globalThis.fetch;
};

export type ExternalRuntimeReceipt = {
  accepted: boolean;
  duplicate: boolean;
  projectionState: "applied" | "stale";
  eventId: string;
  receivedAt: string;
};

export function signExternalRuntimeEvent(
  secret: string,
  rawBody: string,
  unixSeconds: number,
): string {
  const digest = createHmac("sha256", secret)
    .update(`${unixSeconds}.${rawBody}`)
    .digest("hex");
  return `t=${unixSeconds},v1=${digest}`;
}

export class ExternalRuntimeObserver {
  readonly #callbackUrl: string;
  readonly #secret: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: ExternalRuntimeObserverConfig) {
    try {
      const callback = new URL(config.callbackUrl);
      if (callback.protocol !== "https:" && callback.hostname !== "localhost" && callback.hostname !== "127.0.0.1") {
        throw new TypeError("ExternalRuntimeObserver: callbackUrl must use https outside localhost");
      }
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith("ExternalRuntimeObserver:")) throw error;
      throw new TypeError("ExternalRuntimeObserver: callbackUrl must be an absolute URL");
    }
    if (!config.secret) {
      throw new TypeError("ExternalRuntimeObserver: secret is required");
    }
    this.#callbackUrl = config.callbackUrl;
    this.#secret = config.secret;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async send(
    event: ExternalRuntimeEvent,
    options: { timestampSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<ExternalRuntimeReceipt> {
    const rawBody = JSON.stringify(event);
    const timestamp = options.timestampSeconds ?? Math.floor(Date.now() / 1_000);
    const response = await this.#fetch(this.#callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-janusly-signature": signExternalRuntimeEvent(this.#secret, rawBody, timestamp),
      },
      body: rawBody,
      signal: options.signal,
    });
    const payload = await response.json().catch(() => null) as Partial<ExternalRuntimeReceipt> | null;
    if (
      !response.ok
      || !payload
      || payload.accepted !== true
      || typeof payload.duplicate !== "boolean"
      || (payload.projectionState !== "applied" && payload.projectionState !== "stale")
      || typeof payload.eventId !== "string"
      || typeof payload.receivedAt !== "string"
    ) {
      throw new Error(`ExternalRuntimeObserver: callback rejected event (${response.status})`);
    }
    return payload as ExternalRuntimeReceipt;
  }
}
