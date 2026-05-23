/**
 * Integration tools — third-party API surfaces exposed as runtime tools.
 *
 * Three tools today:
 *   - `slack.post` — POST to a Slack Incoming Webhook URL.
 *   - `github.create_issue` — POST to GitHub's issues REST endpoint.
 *   - `webhook.send` — signed outbound HTTP POST (Stripe-style HMAC sig).
 *
 * All three follow the same shape:
 *   1. Resolve the credential by name from the persisted `credentials` row
 *      (multi-tenant scoped via `getCredentialByName`).
 *   2. Read the actual secret from `process.env[credential.secretRef]`. The
 *      secret-ref env-var name is NEVER echoed in errors / logs / usage
 *      rows — failures return a generic "credential URL/token missing".
 *   3. Per-org rate-limit through the injected `getEngineRateLimiter()`.
 *      Fail-open on Redis blips (existing posture).
 *   4. Outbound call through `fetchHttpTarget` so SSRF / DNS-pin / body-cap
 *      / timeout / redirect guards apply uniformly. No vendor SDKs.
 *   5. Fire the registered `IntegrationUsageRecorder` for every call —
 *      success AND failure — so cost / quota dashboards include the
 *      failed-call traffic too.
 *   6. Return a `{ ok, ...result, error? }` envelope. Tools never throw on
 *      runtime failures (rate-limit, missing credential, upstream non-2xx);
 *      the workflow run consumes the envelope and decides via downstream
 *      `condition` nodes.
 *
 * Used by:
 * - `packages/engine/src/tool-registry.ts` — registers all three tools.
 *
 * Invariants:
 * - No vendor SDKs (`@slack/web-api`, `@octokit/*`, etc.). The closed
 *   chokepoint is `fetchHttpTarget`; new integrations must reuse it.
 * - Workflow JSON never carries credential URLs / API keys / signing
 *   secrets. Slack webhook URLs, GitHub tokens, and signing secrets come
 *   from the credential `name` → env lookup. `webhook.send` still carries
 *   the destination URL as ordinary tool input, but not the signing secret.
 * - The HMAC signature format on `webhook.send` is Stripe-style:
 *   `t=<unix-seconds>,v1=<hex-hmac-sha256>` with the signed body
 *   `<timestamp>.<json-body>`. Receivers can verify with a 5-line check.
 */

import { createHmac } from "node:crypto";
import { z } from "zod";

import { getCredentialByName } from "@janusly/data/src/credentialsRepo";
import { fetchHttpTarget } from "./http-policy";
import { getIntegrationUsageRecorder } from "./integration-usage";
import { getEngineRateLimiter } from "./rate-limit";

/** Lowercase header name the signed webhook tool sets. Surface-stable. */
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

/**
 * Resolve `credential.secretRef` to its env value. Returns `null` (not the
 * env-var name) when missing, so callers surface a generic error without
 * leaking the env-var name. The env-var name in the credential row is an
 * operator-visible config; in error envelopes it is treated as sensitive.
 */
function resolveSecretRef(secretRef: string): string | null {
  const value = process.env[secretRef];
  if (!value || value.trim().length === 0) return null;
  return value;
}

/** Slack Incoming Webhook URL must be Slack's canonical hostname for safety. */
function isSlackHookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "hooks.slack.com";
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tool: slack.post
// ──────────────────────────────────────────────────────────────────────────

const slackPostInput = z.object({
  /** Stored Slack credential name (kind: `slack_webhook`). */
  credential: z.string().min(1),
  /** Plain text. Slack requires either `text` or `blocks`. */
  text: z.string().optional(),
  /** Slack Block Kit blocks (max 50 per Slack's API). Free-form object array. */
  blocks: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
}).refine(
  (input) => Boolean(input.text || (input.blocks && input.blocks.length > 0)),
  { message: "slack.post requires `text` or non-empty `blocks`." },
);

const slackPostOutput = z.object({
  ok: z.boolean(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

// ──────────────────────────────────────────────────────────────────────────
// Tool: github.create_issue
// ──────────────────────────────────────────────────────────────────────────

const githubCreateIssueInput = z.object({
  /** Stored GitHub credential name (kind: `github_token`). */
  credential: z.string().min(1),
  /** Repository owner (user or org). */
  owner: z.string().min(1),
  /** Repository name. */
  repo: z.string().min(1),
  /** Issue title. */
  title: z.string().min(1),
  /** Optional issue body (Markdown). */
  body: z.string().optional(),
  /** Optional labels to apply. */
  labels: z.array(z.string().min(1)).max(50).optional(),
  /** Optional GitHub usernames to assign. */
  assignees: z.array(z.string().min(1)).max(10).optional(),
});

const githubCreateIssueOutput = z.object({
  ok: z.boolean(),
  /** Issue number assigned by GitHub. Populated when `ok === true`. */
  issueNumber: z.number().optional(),
  /** Issue URL (html_url from GitHub's response). */
  url: z.string().optional(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

// ──────────────────────────────────────────────────────────────────────────
// Tool: github.add_issue_comment
// ──────────────────────────────────────────────────────────────────────────

const githubAddIssueCommentInput = z.object({
  /** Stored GitHub credential name (kind: `github_token`). */
  credential: z.string().min(1),
  /** Repository owner (user or org). */
  owner: z.string().min(1),
  /** Repository name. */
  repo: z.string().min(1),
  /** Existing issue number returned by a prior `github.create_issue`. */
  issueNumber: z.number().int().min(1),
  /** Comment body in Markdown. */
  body: z.string().min(1).max(64_000),
});

const githubAddIssueCommentOutput = z.object({
  ok: z.boolean(),
  /** GitHub-assigned comment id (numeric). Populated when `ok === true`. */
  commentId: z.number().optional(),
  /** Comment URL (html_url from GitHub's response). */
  commentUrl: z.string().optional(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

// ──────────────────────────────────────────────────────────────────────────
// Tool: webhook.send
// ──────────────────────────────────────────────────────────────────────────

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
});

// ──────────────────────────────────────────────────────────────────────────
// Shared executor scaffolding
// ──────────────────────────────────────────────────────────────────────────

export type IntegrationToolName =
  | "slack.post"
  | "github.create_issue"
  | "github.add_issue_comment"
  | "webhook.send";

type FireRecorderInput = {
  orgId: string;
  tool: IntegrationToolName;
  credentialName: string;
  executionContext: { runId?: string; nodeId?: string; workflowId?: string };
  ok: boolean;
  statusCode?: number;
  error?: string;
  latencyMs: number;
};

async function fireIntegrationRecorder(input: FireRecorderInput): Promise<void> {
  const recorder = getIntegrationUsageRecorder();
  if (!recorder) return;
  try {
    await recorder({
      orgId: input.orgId,
      tool: input.tool,
      credentialName: input.credentialName,
      runId: input.executionContext.runId,
      nodeId: input.executionContext.nodeId,
      workflowId: input.executionContext.workflowId,
      ok: input.ok,
      statusCode: input.statusCode,
      error: input.error,
      latencyMs: input.latencyMs,
    });
  } catch {
    // Telemetry must never break the tool. Drop silently.
  }
}

type GateResult =
  | { ok: true; credentialSecret: string }
  | { ok: false; error: string };

/**
 * The pre-call gate every integration tool runs:
 *   1. Look up the credential by name (multi-tenant scoped).
 *   2. Resolve `secret_ref` → env value.
 *   3. Rate-limit the call.
 *
 * Returns `{ ok: true, credentialSecret }` when ready to call the upstream,
 * `{ ok: false, error }` otherwise. Errors never reference env-var names.
 */
async function gateIntegrationCall(args: {
  orgId: string | undefined;
  tool: IntegrationToolName;
  credentialKind: string;
  credentialName: string;
  rateLimitPerMin: number;
}): Promise<GateResult> {
  if (!args.orgId) {
    return { ok: false, error: `${args.tool} requires multi-tenant context` };
  }

  const credential = await getCredentialByName(args.orgId, args.credentialKind, args.credentialName);
  if (!credential) {
    return { ok: false, error: `credential not found: ${args.credentialName}` };
  }
  const secret = resolveSecretRef(credential.secretRef);
  if (!secret) {
    // Deliberately generic — never echo the secretRef env-var name.
    return { ok: false, error: `credential secret missing for ${args.credentialName}` };
  }

  const limiter = getEngineRateLimiter();
  if (limiter) {
    try {
      await limiter(`tool.${args.tool}`, args.orgId, {
        windowMs: 60_000,
        max: args.rateLimitPerMin,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : "Rate limit exceeded";
      return { ok: false, error };
    }
  }

  return { ok: true, credentialSecret: secret };
}

// ──────────────────────────────────────────────────────────────────────────
// Tool definitions
// ──────────────────────────────────────────────────────────────────────────

export const slackPostTool = {
  name: "slack.post" as const,
  description: "Send a message to a Slack channel via a stored Incoming Webhook URL.",
  inputSchema: slackPostInput,
  outputSchema: slackPostOutput,
  inputExample: { credential: "incidents-slack", text: "Incident detected." },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof slackPostInput>,
    _context: Record<string, unknown>,
    executionContext: {
      orgId?: string;
      runId?: string;
      nodeId?: string;
      workflowId?: string;
      integrations?: { slack?: { rateLimitPerMin?: number } };
    },
  ): Promise<z.infer<typeof slackPostOutput>> {
    const start = Date.now();
    const rateLimitPerMin = executionContext.integrations?.slack?.rateLimitPerMin
      ?? envPositiveInt("JANUSLY_SLACK_RATE_LIMIT_PER_MIN", 60);

    const gate = await gateIntegrationCall({
      orgId: executionContext.orgId,
      tool: "slack.post",
      credentialKind: "slack_webhook",
      credentialName: input.credential,
      rateLimitPerMin,
    });
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      if (executionContext.orgId) {
        await fireIntegrationRecorder({
          orgId: executionContext.orgId,
          tool: "slack.post",
          credentialName: input.credential,
          executionContext,
          ok: false,
          error: gate.error,
          latencyMs,
        });
      }
      return { ok: false, error: gate.error, latencyMs };
    }

    if (!isSlackHookUrl(gate.credentialSecret)) {
      const latencyMs = Date.now() - start;
      const error = "slack webhook URL must point at hooks.slack.com";
      await fireIntegrationRecorder({
        orgId: executionContext.orgId!,
        tool: "slack.post",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error,
        latencyMs,
      });
      return { ok: false, error, latencyMs };
    }

    const body: Record<string, unknown> = {};
    if (input.text) body.text = input.text;
    if (input.blocks) body.blocks = input.blocks;

    const result = await fetchHttpTarget(gate.credentialSecret, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => ({
      // The Slack webhook URL contains the secret token in its path
      // (`/services/T00/B00/<token>`). fetchHttpTarget's error messages
      // may embed the full URL (redirect limit, timeout, etc.) so we
      // intentionally drop the upstream message and return a static
      // string here. Operators debug from the latencyMs + statusCode: 0
      // pair in the usage event, not the error text.
      statusCode: 0,
      ok: false as const,
      body: "",
      headers: {} as Record<string, string>,
      __error: "network error calling slack webhook",
    }));

    const latencyMs = Date.now() - start;
    const errorFromThrow = (result as { __error?: string }).__error;
    if (errorFromThrow) {
      await fireIntegrationRecorder({
        orgId: executionContext.orgId!,
        tool: "slack.post",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: errorFromThrow,
        latencyMs,
      });
      return { ok: false, error: errorFromThrow, latencyMs };
    }

    const ok = result.ok && result.statusCode >= 200 && result.statusCode < 300;
    // Slack 4xx responses are short text codes like "invalid_payload" —
    // safe to surface. Truncate defensively.
    const error = ok ? undefined : `slack responded ${result.statusCode}: ${truncate(result.body)}`;
    await fireIntegrationRecorder({
      orgId: executionContext.orgId!,
      tool: "slack.post",
      credentialName: input.credential,
      executionContext,
      ok,
      statusCode: result.statusCode,
      error,
      latencyMs,
    });
    return ok
      ? { ok: true, statusCode: result.statusCode, latencyMs }
      : { ok: false, statusCode: result.statusCode, error: error!, latencyMs };
  },
};

export const githubCreateIssueTool = {
  name: "github.create_issue" as const,
  description: "Create a GitHub issue using a stored PAT credential.",
  inputSchema: githubCreateIssueInput,
  outputSchema: githubCreateIssueOutput,
  inputExample: {
    credential: "bot-github",
    owner: "janusly",
    repo: "demo",
    title: "Incident triage",
    body: "Details…",
  },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof githubCreateIssueInput>,
    _context: Record<string, unknown>,
    executionContext: {
      orgId?: string;
      runId?: string;
      nodeId?: string;
      workflowId?: string;
      integrations?: { github?: { rateLimitPerMin?: number } };
    },
  ): Promise<z.infer<typeof githubCreateIssueOutput>> {
    const start = Date.now();
    const rateLimitPerMin = executionContext.integrations?.github?.rateLimitPerMin
      ?? envPositiveInt("JANUSLY_GITHUB_RATE_LIMIT_PER_MIN", 60);

    const gate = await gateIntegrationCall({
      orgId: executionContext.orgId,
      tool: "github.create_issue",
      credentialKind: "github_token",
      credentialName: input.credential,
      rateLimitPerMin,
    });
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      if (executionContext.orgId) {
        await fireIntegrationRecorder({
          orgId: executionContext.orgId,
          tool: "github.create_issue",
          credentialName: input.credential,
          executionContext,
          ok: false,
          error: gate.error,
          latencyMs,
        });
      }
      return { ok: false, error: gate.error, latencyMs };
    }

    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`;
    const body: Record<string, unknown> = { title: input.title };
    if (input.body) body.body = input.body;
    if (input.labels) body.labels = input.labels;
    if (input.assignees) body.assignees = input.assignees;

    const result = await fetchHttpTarget(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${gate.credentialSecret}`,
        "user-agent": "janusly-mcp-integration",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
    }).catch((err: unknown) => ({
      // The URL is `api.github.com/repos/<owner>/<repo>/issues` — owner +
      // repo are operator-supplied identifiers, not secrets. The Bearer
      // token lives in the request headers; fetchHttpTarget never echoes
      // request headers in its error messages, so the upstream message
      // is safe to surface to the workflow author for debugging.
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
        tool: "github.create_issue",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: errorFromThrow,
        latencyMs,
      });
      return { ok: false, error: errorFromThrow, latencyMs };
    }

    if (result.statusCode === 201) {
      // GitHub returns the created issue body. We want `number` and `html_url`.
      const parsed = safeParseJson(result.body);
      const issueNumber = typeof parsed?.number === "number" ? parsed.number : undefined;
      const issueUrl = typeof parsed?.html_url === "string" ? parsed.html_url : undefined;
      await fireIntegrationRecorder({
        orgId: executionContext.orgId!,
        tool: "github.create_issue",
        credentialName: input.credential,
        executionContext,
        ok: true,
        statusCode: result.statusCode,
        latencyMs,
      });
      return { ok: true, issueNumber, url: issueUrl, statusCode: result.statusCode, latencyMs };
    }

    // 4xx / 5xx — surface the GitHub-supplied message but never the token.
    const parsed = safeParseJson(result.body);
    const message = typeof parsed?.message === "string" ? parsed.message : `github responded ${result.statusCode}`;
    await fireIntegrationRecorder({
      orgId: executionContext.orgId!,
      tool: "github.create_issue",
      credentialName: input.credential,
      executionContext,
      ok: false,
      statusCode: result.statusCode,
      error: message,
      latencyMs,
    });
    return { ok: false, statusCode: result.statusCode, error: message, latencyMs };
  },
};

export const githubAddIssueCommentTool = {
  name: "github.add_issue_comment" as const,
  description: "Append a Markdown comment to an existing GitHub issue using a stored PAT credential.",
  inputSchema: githubAddIssueCommentInput,
  outputSchema: githubAddIssueCommentOutput,
  inputExample: {
    credential: "bot-github",
    owner: "janusly",
    repo: "demo",
    issueNumber: 42,
    body: "Update on this incident…",
  },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof githubAddIssueCommentInput>,
    _context: Record<string, unknown>,
    executionContext: {
      orgId?: string;
      runId?: string;
      nodeId?: string;
      workflowId?: string;
      integrations?: { github?: { rateLimitPerMin?: number } };
    },
  ): Promise<z.infer<typeof githubAddIssueCommentOutput>> {
    const start = Date.now();
    const rateLimitPerMin = executionContext.integrations?.github?.rateLimitPerMin
      ?? envPositiveInt("JANUSLY_GITHUB_RATE_LIMIT_PER_MIN", 60);

    const gate = await gateIntegrationCall({
      orgId: executionContext.orgId,
      tool: "github.add_issue_comment",
      credentialKind: "github_token",
      credentialName: input.credential,
      rateLimitPerMin,
    });
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      if (executionContext.orgId) {
        await fireIntegrationRecorder({
          orgId: executionContext.orgId,
          tool: "github.add_issue_comment",
          credentialName: input.credential,
          executionContext,
          ok: false,
          error: gate.error,
          latencyMs,
        });
      }
      return { ok: false, error: gate.error, latencyMs };
    }

    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`;

    const result = await fetchHttpTarget(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${gate.credentialSecret}`,
        "user-agent": "janusly-mcp-integration",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ body: input.body }),
    }).catch((err: unknown) => ({
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
        tool: "github.add_issue_comment",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: errorFromThrow,
        latencyMs,
      });
      return { ok: false, error: errorFromThrow, latencyMs };
    }

    if (result.statusCode === 201) {
      const parsed = safeParseJson(result.body);
      const commentId = typeof parsed?.id === "number" ? parsed.id : undefined;
      const commentUrl = typeof parsed?.html_url === "string" ? parsed.html_url : undefined;
      await fireIntegrationRecorder({
        orgId: executionContext.orgId!,
        tool: "github.add_issue_comment",
        credentialName: input.credential,
        executionContext,
        ok: true,
        statusCode: result.statusCode,
        latencyMs,
      });
      return { ok: true, commentId, commentUrl, statusCode: result.statusCode, latencyMs };
    }

    const parsed = safeParseJson(result.body);
    const message = typeof parsed?.message === "string" ? parsed.message : `github responded ${result.statusCode}`;
    await fireIntegrationRecorder({
      orgId: executionContext.orgId!,
      tool: "github.add_issue_comment",
      credentialName: input.credential,
      executionContext,
      ok: false,
      statusCode: result.statusCode,
      error: message,
      latencyMs,
    });
    return { ok: false, statusCode: result.statusCode, error: message, latencyMs };
  },
};

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
        if (lower === "content-type" || lower === "authorization" || lower === headerName) continue;
        merged[lower] = value;
      }
    }
    merged[headerName] = signature;

    const result = await fetchHttpTarget(input.url, {
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
      ? { ok: true, statusCode: result.statusCode, latencyMs }
      : { ok: false, statusCode: result.statusCode, error: error!, latencyMs };
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function envPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function safeParseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function truncate(value: string, max = 200): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
