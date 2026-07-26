/**
 * `email.send` tool — send a transactional email via the configured mailer,
 * with per-org rate-limit gating + best-effort usage telemetry.
 *
 * Used by: `packages/engine/src/tool-registry.ts` (spreads `emailTools`).
 */

import { z } from "zod";
import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { getMailer } from "../mailer";
import { getEngineRateLimiter } from "../rate-limit";
import { getEmailUsageRecorder } from "../email-usage";
import { defineTool, envPositiveInt, type ToolExecutionContext } from "./tool-types";

/**
 * Fires the registered email-usage recorder, swallowing any failure so
 * a recorder bug can't break the `email.send` tool path. Skipped when
 * no recorder is registered (unit tests).
 */
async function fireEmailRecorder(input: {
  orgId: string;
  executionContext: ToolExecutionContext;
  to: string;
  from: string;
  provider: "resend" | "sendgrid" | "simulator" | "noop";
  providerMessageId?: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
}): Promise<void> {
  const recorder = getEmailUsageRecorder();
  if (!recorder) return;
  try {
    await recorder({
      orgId: input.orgId,
      runId: input.executionContext.runId,
      nodeId: input.executionContext.nodeId,
      workflowId: input.executionContext.workflowId,
      to: input.to,
      from: input.from,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      ok: input.ok,
      error: input.error,
      latencyMs: input.latencyMs,
    });
  } catch {
    // Telemetry must never break the tool. Drop silently.
  }
}

const emailSendInput = z.object({
  /** Recipient email address. v1 ships single-recipient only; multi-to lands when the AC asks. */
  to: z.string().min(1),
  /**
   * Sender email address. When omitted, the tool falls back to
   * `process.env.JANUSLY_MAILER_FROM` at execute time. Resend's
   * sandbox sender is `onboarding@resend.dev`; SendGrid requires a
   * DNS-verified domain.
   */
  from: z.string().min(1).optional(),
  /** Subject line. Capped at RFC 5322's 998-char line length. */
  subject: z.string().min(1).max(998),
  /** Plain-text body. Required when `html` is not supplied. */
  text: z.string().max(200_000).optional(),
  /** HTML body. Required when `text` is not supplied. */
  html: z.string().max(500_000).optional(),
  /**
   * Provider metadata: Resend `tags`, SendGrid `custom_args`. Kept
   * intentionally small because it is copied into outbound provider
   * payloads and billing telemetry.
   */
  metadata: z.record(z.string().min(1).max(64), z.string().max(256))
    .refine((value) => Object.keys(value).length <= 20, {
      message: "email.send metadata supports at most 20 entries",
    })
    .optional(),
}).refine(
  (input) => Boolean(input.text || input.html),
  { message: "email.send requires `text` or `html` (or both)." },
);

const emailSendOutput = z.object({
  /** True iff the provider accepted the email for delivery. */
  ok: z.boolean(),
  /** Which mailer handled the call. `"noop"` when no API key was configured. */
  provider: z.enum(["resend", "sendgrid", "simulator", "noop"]),
  /** Provider-assigned id; populated on success. */
  providerMessageId: z.string().optional(),
  /** Failure reason; populated when `ok === false`. Mirrors the AGENTS.md AI-fallback contract for write-side tools. */
  error: z.string().optional(),
});

export const emailTools = {
  "email.send": defineTool({
    name: "email.send",
    description: "Send a transactional email via the configured mailer (Resend or SendGrid).",
    inputSchema: emailSendInput,
    outputSchema: emailSendOutput,
    inputExample: { to: "user@example.com", subject: "Hello", text: "Body of the email." },
    writeSide: true,
    async execute(input, _context, executionContext) {
      const start = Date.now();
      const orgId = executionContext.orgId;
      const limiter = getEngineRateLimiter();
      const rateLimitPerMin = executionContext.email?.rateLimitPerMin
        ?? envPositiveInt("JANUSLY_EMAIL_RATE_LIMIT_PER_MIN", 100);

      // Per-org rate gate. The injected limiter throws when over
      // limit; the tool wrapper converts the throw to a clean
      // `{ ok: false, error }` envelope so the AI-fallback contract
      // holds and the workflow run doesn't fail.
      if (orgId && limiter) {
        try {
          await limiter("email.send", orgId, { windowMs: RATE_LIMIT_WINDOW_MS, max: rateLimitPerMin });
        } catch (err) {
          const error = err instanceof Error ? err.message : "Rate limit exceeded";
          await fireEmailRecorder({
            orgId,
            executionContext,
            to: input.to,
            from: input.from ?? executionContext.email?.from ?? process.env.JANUSLY_MAILER_FROM ?? "onboarding@resend.dev",
            provider: "noop",
            ok: false,
            error,
            latencyMs: Date.now() - start,
          });
          return { ok: false, provider: "noop" as const, error };
        }
      }

      const from = input.from ?? executionContext.email?.from ?? process.env.JANUSLY_MAILER_FROM ?? "onboarding@resend.dev";
      const mailer = getMailer(executionContext.email?.provider);
      const result = await mailer.send({
        to: input.to,
        from,
        subject: input.subject,
        text: input.text,
        html: input.html,
        metadata: input.metadata,
      });
      const latencyMs = Date.now() - start;

      // Best-effort audit row. Wrapped in try/catch inside the helper
      // so a recorder failure can't break the tool path. Skipped when
      // there's no orgId (unit tests, ad-hoc paths).
      if (orgId) {
        await fireEmailRecorder({
          orgId,
          executionContext,
          to: input.to,
          from,
          provider: result.provider,
          providerMessageId: result.ok ? result.providerMessageId : undefined,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          latencyMs,
        });
      }

      if (result.ok) {
        return { ok: true, provider: result.provider, providerMessageId: result.providerMessageId };
      }
      return { ok: false, provider: result.provider, error: result.error };
    },
  }),
};
