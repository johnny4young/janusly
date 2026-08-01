/** Generic signed outbound webhook integration tool. */

import { createHmac } from "node:crypto";
import { z } from "zod";

import { fetchHttpTarget } from "../http-policy";
import {
  isLocalIntegrationSimulatorEndpoint,
  parseProviderSimulationReceipt,
  resolveLocalWebhookDestination,
} from "../local-integration-simulator";
import {
  envPositiveInt,
  fireIntegrationRecorder,
  gateIntegrationCall,
  safeParseJson,
  truncate,
} from "./shared";

const DEFAULT_WEBHOOK_SIGNATURE_HEADER = "x-janusly-signature";

/**
 * HMAC-SHA256 signed payload formatter. Returns a Stripe-style
 * `t=<unix-seconds>,v1=<hex>` string that the destination service can
 * verify with `createHmac("sha256", secret).update(\`${t}.${body}\`).digest("hex")`.
 *
 * `body` is the exact bytes that will be sent in the HTTP body — the
 * caller MUST sign the same string they POST. Reordering keys after
 * signing produces a different signature.
 */
export function signWebhookPayload(secret: string, body: string, unixSeconds: number): string {
  const signed = `${unixSeconds}.${body}`;
  const hex = createHmac("sha256", secret).update(signed).digest("hex");
  return `t=${unixSeconds},v1=${hex}`;
}

const webhookSendInput = z.object({
  /** Stored shared-secret credential name (kind: `webhook_secret`). */
  credential: z.string().min(1),
  /** Destination URL. Goes through fetchHttpTarget so SSRF guards apply. */
  url: z.string().url(),
  /** JSON payload. The exact serialized body is what gets signed. */
  payload: z.record(z.string(), z.unknown()),
  /** Optional header name override; defaults to `x-janusly-signature`. */
  signatureHeader: z.string().optional(),
  /**
   * Optional extra request headers (e.g., `X-Idempotency-Key`). Capped at
   * 10 entries; each header value capped at 200 chars; CR/LF rejected
   * (defense against header-splitting via operator input). The
   * `Authorization` / `X-Janusly-Signature` headers are reserved for the
   * tool itself and any override here is ignored at execute time.
   */
  headers: z
    .record(
      z.string().min(1).max(60),
      z
        .string()
        .min(1)
        .max(200)
        .refine((value) => !/[\r\n]/.test(value), "header value cannot contain CR/LF"),
    )
    .refine((value) => Object.keys(value).length <= 10, "max 10 custom headers")
    .optional(),
});

const webhookSendOutput = z.object({
  ok: z.boolean(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
  providerReceipt: z.object({
    kind: z.literal("provider_simulation_receipt"),
    version: z.literal(1),
    provider: z.literal("webhook"),
    operation: z.literal("deliver"),
    scope: z.enum(["validation", "production"]),
    effectId: z.string().min(1),
    idempotencyKey: z.string().min(1).nullable(),
    applied: z.boolean(),
    duplicate: z.boolean(),
    requestId: z.string().min(1),
  }).optional(),
});

export const webhookSendTool = {
  name: "webhook.send" as const,
  description: "POST a signed JSON payload to an external URL with an HMAC-SHA256 signature header.",
  inputSchema: webhookSendInput,
  outputSchema: webhookSendOutput,
  inputExample: {
    credential: "partner-webhook",
    url: "https://partner.example.com/hooks/incident",
    payload: { event: "incident", severity: "high" },
  },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof webhookSendInput>,
    _context: Record<string, unknown>,
    executionContext: {
      orgId?: string;
      runId?: string;
      nodeId?: string;
      workflowId?: string;
      integrations?: { webhook?: { rateLimitPerMin?: number } };
      providerSimulation?: { scope: "validation" };
    },
  ): Promise<z.infer<typeof webhookSendOutput>> {
    const start = Date.now();
    const rateLimitPerMin = executionContext.integrations?.webhook?.rateLimitPerMin
      ?? envPositiveInt("JANUSLY_WEBHOOK_RATE_LIMIT_PER_MIN", 120);

    const gate = await gateIntegrationCall({
      orgId: executionContext.orgId,
      tool: "webhook.send",
      credentialKind: "webhook_secret",
      credentialName: input.credential,
      rateLimitPerMin,
    });
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      if (executionContext.orgId) {
        await fireIntegrationRecorder({
          orgId: executionContext.orgId,
          tool: "webhook.send",
          credentialName: input.credential,
          executionContext,
          ok: false,
          error: gate.error,
          latencyMs,
        });
      }
      return { ok: false, error: gate.error, latencyMs };
    }

    const serialized = JSON.stringify(input.payload);
    const unixSeconds = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(gate.credentialSecret, serialized, unixSeconds);
    const headerName = (input.signatureHeader ?? DEFAULT_WEBHOOK_SIGNATURE_HEADER).toLowerCase();
    const destination = resolveLocalWebhookDestination(input.url);
    const localSimulator = isLocalIntegrationSimulatorEndpoint(destination, "/webhook");

    // Merge operator-supplied extra headers (e.g., X-Idempotency-Key for
    // Linear / generic receivers) on TOP of the always-sent
    // content-type + signature. Reserved keys (content-type,
    // authorization, and the resolved signature header) cannot be
    // overridden — the Zod input schema caps quantity + per-value length
    // and rejects CR/LF to keep this seam from becoming a header-injection
    // vector.
    const merged: Record<string, string> = { "content-type": "application/json" };
    if (input.headers) {
      for (const [key, value] of Object.entries(input.headers)) {
        const lower = key.toLowerCase();
        if (
          lower === "content-type"
          || lower === "authorization"
          || lower === headerName
          || lower === "x-janusly-simulation-scope"
        ) continue;
        merged[lower] = value;
      }
    }
    merged[headerName] = signature;
    if (localSimulator && executionContext.providerSimulation?.scope === "validation") {
      merged["x-janusly-simulation-scope"] = "validation";
    }

    const result = await fetchHttpTarget(destination, {
      method: "POST",
      headers: merged,
      body: serialized,
    }).catch((err: unknown) => ({
      // The destination URL is operator-supplied (not a credential); the
      // HMAC signing secret stays in headers and is never echoed by
      // fetchHttpTarget's error messages. Surface the upstream message
      // so operators can debug SSRF rejections / DNS failures / timeouts.
      statusCode: 0,
      ok: false as const,
      body: "",
      headers: {} as Record<string, string>,
      __error: err instanceof Error ? err.message : "network error",
    }));

    const latencyMs = Date.now() - start;
    const errorFromThrow = (result as { __error?: string }).__error;
    if (errorFromThrow) {
      await fireIntegrationRecorder({
        orgId: executionContext.orgId!,
        tool: "webhook.send",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: errorFromThrow,
        latencyMs,
      });
      return { ok: false, error: errorFromThrow, latencyMs };
    }

    const ok = result.ok && result.statusCode >= 200 && result.statusCode < 300;
    const error = ok ? undefined : `webhook responded ${result.statusCode}: ${truncate(result.body)}`;
    const parsedBody = ok && localSimulator ? safeParseJson(result.body) : null;
    const providerReceipt = parseProviderSimulationReceipt(
      parsedBody?.receipt,
      executionContext.providerSimulation?.scope === "validation" ? "validation" : "production",
    );
    await fireIntegrationRecorder({
      orgId: executionContext.orgId!,
      tool: "webhook.send",
      credentialName: input.credential,
      executionContext,
      ok,
      statusCode: result.statusCode,
      error,
      latencyMs,
    });
    return ok
      ? {
          ok: true,
          statusCode: result.statusCode,
          latencyMs,
          ...(providerReceipt ? { providerReceipt } : {}),
        }
      : { ok: false, statusCode: result.statusCode, error: error!, latencyMs };
  },
};
