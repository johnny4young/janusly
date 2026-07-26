/**
 * Pluggable mailer abstraction for the `email.send` tool. Four
 * providers, env-driven resolution at call time, plus a test-override
 * seam.
 *
 *   - `ResendMailer`    — calls `https://api.resend.com/emails`.
 *   - `SendGridMailer`  — calls `https://api.sendgrid.com/v3/mail/send`.
 *   - `NoopMailer`      — returns `{ ok: false, error: "Mailer not
 *                          configured", provider: "noop" }`. Lights up
 *                          when no `*_API_KEY` is present so the AI-
 *                          fallback contract holds without throwing.
 *   - `SimulatorMailer` — explicit local-stack delivery to the bundled
 *                          provider simulator. Never selected implicitly.
 *
 * Both real providers go out via `fetchHttpTarget` (the existing SSRF-
 * guarded HTTP chokepoint). No new SDK deps, no DNS-rebind risk on the
 * provider hostname, the configured timeout / max-body / max-redirect
 * bounds apply automatically.
 *
 * The provider exposes a single `send(input)` method that NEVER throws.
 * Network errors, non-2xx responses, and malformed bodies all degrade
 * to `{ ok: false, error, provider }` — write-side tools mirror the AI-
 * fallback contract so the engine's `tool` node executor doesn't need
 * a try/catch around every send.
 *
 * Resolution order in `getMailer(providerOverride?)`:
 *   1. Test override (`setMailerForTests(provider)`) when set.
 *   2. Tenant/provider override or `JANUSLY_MAILER_PROVIDER === "resend"` AND `RESEND_API_KEY` set.
 *   3. Tenant/provider override or `JANUSLY_MAILER_PROVIDER === "sendgrid"` AND `SENDGRID_API_KEY`.
 *   4. Explicit `simulator` selection when the local simulator process gate is enabled.
 *   5. Otherwise `NoopMailer`.
 *
 * Default `from` is chosen by the tool wrapper from tenant config
 * (`email.from`) with `JANUSLY_MAILER_FROM` as env fallback. Resend's
 * sandbox sender is `onboarding@resend.dev`.
 *
 * Used by `packages/engine/src/tool-registry.ts:email.send`.
 */

import { fetchHttpTarget } from "./http-policy";
import { localIntegrationSimulatorEndpoint } from "./local-integration-simulator";

export type MailerProviderName = "resend" | "sendgrid" | "simulator" | "noop";

export type MailerSendInput = {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  /** Optional metadata the provider attaches to the message. */
  metadata?: Record<string, string>;
};

export type MailerSendResult =
  | { ok: true; provider: MailerProviderName; providerMessageId: string }
  | { ok: false; provider: MailerProviderName; error: string };

export interface MailerProvider {
  readonly name: MailerProviderName;
  send(input: MailerSendInput): Promise<MailerSendResult>;
}

/* ------------------------------ providers ------------------------------ */

class ResendMailer implements MailerProvider {
  readonly name = "resend" as const;
  constructor(private readonly apiKey: string) {}

  async send(input: MailerSendInput): Promise<MailerSendResult> {
    const body = JSON.stringify({
      from: input.from,
      to: [input.to],
      subject: input.subject,
      ...(input.text ? { text: input.text } : {}),
      ...(input.html ? { html: input.html } : {}),
      // Resend exposes `tags: [{ name, value }]`. We translate the
      // metadata record verbatim — bounded by the Zod schema upstream.
      ...(input.metadata
        ? { tags: Object.entries(input.metadata).map(([name, value]) => ({ name, value })) }
        : {}),
    });

    try {
      const result = await fetchHttpTarget("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
      if (!result.ok) {
        return { ok: false, provider: "resend", error: `Resend returned HTTP ${result.statusCode}: ${truncate(result.body)}` };
      }
      const parsed = safeJsonParse(result.body);
      const messageId = (parsed && typeof parsed === "object" && "id" in parsed && typeof (parsed as { id: unknown }).id === "string")
        ? (parsed as { id: string }).id
        : null;
      if (!messageId) {
        return { ok: false, provider: "resend", error: "Resend response missing message id" };
      }
      return { ok: true, provider: "resend", providerMessageId: messageId };
    } catch (err) {
      return { ok: false, provider: "resend", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class SendGridMailer implements MailerProvider {
  readonly name = "sendgrid" as const;
  constructor(private readonly apiKey: string) {}

  async send(input: MailerSendInput): Promise<MailerSendResult> {
    // SendGrid v3 wants at least one of text/html in `content` and
    // requires a `personalizations[0].to[0].email`. We pass exactly
    // one recipient — multi-recipient is out of scope for the v1
    // tool surface.
    const content: Array<{ type: string; value: string }> = [];
    if (input.text) content.push({ type: "text/plain", value: input.text });
    if (input.html) content.push({ type: "text/html", value: input.html });

    const body = JSON.stringify({
      personalizations: [{ to: [{ email: input.to }] }],
      from: { email: input.from },
      subject: input.subject,
      content,
      ...(input.metadata ? { custom_args: input.metadata } : {}),
    });

    try {
      const result = await fetchHttpTarget("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
      if (!result.ok) {
        return { ok: false, provider: "sendgrid", error: `SendGrid returned HTTP ${result.statusCode}: ${truncate(result.body)}` };
      }
      // SendGrid returns 202 + empty body; the `X-Message-Id` header
      // carries the id. `fetchHttpTarget` doesn't expose response
      // headers directly today, so synthesise a best-effort id.
      // Operators get the real id via the SendGrid dashboard.
      return { ok: true, provider: "sendgrid", providerMessageId: `sendgrid-${Date.now()}` };
    } catch (err) {
      return { ok: false, provider: "sendgrid", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class SimulatorMailer implements MailerProvider {
  readonly name = "simulator" as const;

  async send(input: MailerSendInput): Promise<MailerSendResult> {
    try {
      const endpoint = localIntegrationSimulatorEndpoint("/email/send");
      if (!endpoint) {
        return { ok: false, provider: "simulator", error: "Local integration simulator is not enabled" };
      }
      const result = await fetchHttpTarget(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!result.ok) {
        return { ok: false, provider: "simulator", error: `Simulator returned HTTP ${result.statusCode}: ${truncate(result.body)}` };
      }
      const parsed = safeJsonParse(result.body);
      const messageId = parsed && typeof parsed === "object" && "id" in parsed
        && typeof (parsed as { id: unknown }).id === "string"
        ? (parsed as { id: string }).id
        : null;
      return messageId
        ? { ok: true, provider: "simulator", providerMessageId: messageId }
        : { ok: false, provider: "simulator", error: "Simulator response missing message id" };
    } catch (err) {
      return { ok: false, provider: "simulator", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

class NoopMailer implements MailerProvider {
  readonly name = "noop" as const;
  async send(_input: MailerSendInput): Promise<MailerSendResult> {
    return {
      ok: false,
      provider: "noop",
      error: "Mailer not configured. Set JANUSLY_MAILER_PROVIDER=resend|sendgrid and the matching API key.",
    };
  }
}

/* --------------------------- resolver + DI seam ----------------------- */

let testOverride: MailerProvider | null = null;

/** Test-only override. Pass `null` to clear. */
export function setMailerForTests(provider: MailerProvider | null): void {
  testOverride = provider;
}

/**
 * Resolve the active mailer for the current call. Reads env every
 * call so the api/worker can hot-swap providers without restart (rare
 * in production, useful in dev / smoke).
 */
export function getMailer(providerOverride?: string): MailerProvider {
  if (testOverride) return testOverride;
  const requested = (providerOverride ?? process.env.JANUSLY_MAILER_PROVIDER)?.toLowerCase();
  if (requested === "noop") {
    return new NoopMailer();
  }
  if (requested === "resend" && process.env.RESEND_API_KEY) {
    return new ResendMailer(process.env.RESEND_API_KEY);
  }
  if (requested === "sendgrid" && process.env.SENDGRID_API_KEY) {
    return new SendGridMailer(process.env.SENDGRID_API_KEY);
  }
  if (requested === "simulator" && process.env.JANUSLY_LOCAL_INTEGRATION_SIMULATOR === "true") {
    return new SimulatorMailer();
  }
  return new NoopMailer();
}

/* --------------------------------- utils ----------------------------- */

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function truncate(input: string, max = 240): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}…`;
}
