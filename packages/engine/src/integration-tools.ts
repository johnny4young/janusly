/**
 * Integration tools — third-party API surfaces exposed as runtime tools.
 *
 * Provider tools today include:
 *   - `slack.post` — POST to a Slack Incoming Webhook URL.
 *   - `github.create_issue` — POST to GitHub's issues REST endpoint.
 *   - `webhook.send` — signed outbound HTTP POST (Stripe-style HMAC sig).
 *   - PagerDuty incident read, policy evaluation, acknowledge, and snooze.
 *
 * Provider-backed tools follow the same shape:
 *   1. Resolve the credential by name from the persisted `credentials` row
 *      (multi-tenant scoped via `getCredentialByName`).
 *   2. Resolve the actual value through the central SecretStore. Managed
 *      encrypted values and legacy environment references share this path.
 *      The secret reference is NEVER echoed in errors / logs / usage
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
 * - `packages/engine/src/tool-registry.ts` — registers the tools.
 *
 * Invariants:
 * - No vendor SDKs (`@slack/web-api`, `@octokit/*`, etc.). The closed
 *   chokepoint is `fetchHttpTarget`; new integrations must reuse it.
 * - Workflow JSON never carries credential URLs / API keys / signing
 *   secrets. Slack webhook URLs, GitHub and PagerDuty tokens, and signing
 *   secrets come from the credential name through the central Secret Store.
 *   `webhook.send` still carries the destination URL as ordinary tool input,
 *   but not the signing secret.
 * - The HMAC signature format on `webhook.send` is Stripe-style:
 *   `t=<unix-seconds>,v1=<hex-hmac-sha256>` with the signed body
 *   `<timestamp>.<json-body>`. Receivers can verify with a 5-line check.
 */

import { createHmac } from "node:crypto";
import { z } from "zod";

import { getCredentialByName, resolveCredentialSecretRef } from "@janusly/data";
import { RATE_LIMIT_WINDOW_MS } from "./constants";
import { fetchHttpTarget } from "./http-policy";
import { getIntegrationUsageRecorder } from "./integration-usage";
import {
  isLocalIntegrationSimulatorEndpoint,
  isLocalSlackSimulatorUrl,
  localIntegrationSimulatorEndpoint,
  parseProviderSimulationReceipt,
  resolveLocalWebhookDestination,
} from "./local-integration-simulator";
import { getEngineRateLimiter } from "./rate-limit";
import { parseLocalMinute, windowContains, zonedClock } from "./zoned-window";

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

/** Slack Incoming Webhook URL must be Slack's canonical hostname for safety. */
function isSlackHookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" && parsed.hostname === "hooks.slack.com")
      || isLocalSlackSimulatorUrl(url);
  } catch {
    return false;
  }
}

function githubApiUrl(path: string): string {
  return localIntegrationSimulatorEndpoint(`/github${path}`) ?? `https://api.github.com${path}`;
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

// ──────────────────────────────────────────────────────────────────────────
// Tools: PagerDuty incident automation
// ──────────────────────────────────────────────────────────────────────────

const pagerDutyRegion = z.enum(["us", "eu"]);

const pagerDutyIncident = z.object({
  id: z.string().min(1),
  status: z.enum(["triggered", "acknowledged", "resolved"]),
  title: z.string().nullable(),
  urgency: z.string().nullable(),
  serviceId: z.string().nullable(),
  assignedUserIds: z.array(z.string()),
});

const pagerDutyConnectionInput = z.object({
  /** Stored credential name (kind: `pagerduty_api_token`). */
  credential: z.string().min(1),
  /** PagerDuty requires a From header containing a valid account email. */
  requesterEmail: z.email(),
  /** PagerDuty account data residency. */
  region: pagerDutyRegion.optional().default("us"),
  /** Optional per-flow outbound call ceiling. */
  rateLimitPerMin: z.number().int().min(1).max(10_000).optional(),
});

const pagerDutyIncidentGetInput = pagerDutyConnectionInput.extend({
  incidentId: z.string().min(1).max(300),
});

const pagerDutyIncidentGetOutput = z.object({
  ok: z.boolean(),
  incident: pagerDutyIncident.optional(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

const pagerDutyWorkingWindow = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
}).refine((window) => window.start !== window.end, {
  message: "working window start and end must differ",
});

const workflowTemplateReference = z.string().regex(/^\{\{[^{}]+\}\}$/u);

const pagerDutyPolicyEvaluateInput = z.object({
  eventType: z.string().min(1).max(120),
  occurredAt: z.union([z.iso.datetime({ offset: true }), workflowTemplateReference]),
  receivedAt: z.union([z.iso.datetime({ offset: true }), workflowTemplateReference]),
  incident: z.union([pagerDutyIncident, workflowTemplateReference]),
  pagerDutyUserId: z.string().min(1).max(300),
  timeZone: z.string().min(1).max(100),
  workingHours: z.array(pagerDutyWorkingWindow).min(1).max(14),
  serviceIds: z.array(z.string().min(1).max(300)).max(100).optional().default([]),
  urgencies: z.array(z.string().min(1).max(100)).max(20).optional().default([]),
  actionableEventTypes: z.array(z.string().min(1).max(120)).max(20).optional(),
});

const pagerDutyPolicyEvaluateOutput = z.object({
  ok: z.literal(true),
  shouldAct: z.boolean(),
  reason: z.string(),
  eventOutsideWorkingHours: z.boolean(),
  receivedOutsideWorkingHours: z.boolean(),
  latencyMs: z.number(),
});

const pagerDutyMutationOutput = z.object({
  ok: z.boolean(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

const pagerDutyAcknowledgeInput = pagerDutyConnectionInput.extend({
  incidentId: z.string().min(1).max(300),
});

const pagerDutySnoozeInput = pagerDutyConnectionInput.extend({
  incidentId: z.string().min(1).max(300),
  durationSeconds: z.number().int().min(60).max(604_800),
});

// ──────────────────────────────────────────────────────────────────────────
// Shared executor scaffolding
// ──────────────────────────────────────────────────────────────────────────

export type IntegrationToolName =
  | "slack.post"
  | "github.create_issue"
  | "github.add_issue_comment"
  | "webhook.send"
  | "pagerduty.incident.get"
  | "pagerduty.incident.acknowledge"
  | "pagerduty.incident.snooze";

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
 *   2. Resolve `secret_ref` through the tenant SecretStore.
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
  const secret = await resolveCredentialSecretRef(args.orgId, credential.secretRef);
  if (!secret) {
    // Deliberately generic — never echo the managed/legacy secret reference.
    return { ok: false, error: `credential secret missing for ${args.credentialName}` };
  }

  const limiter = getEngineRateLimiter();
  if (limiter) {
    try {
      await limiter(`tool.${args.tool}`, args.orgId, {
        windowMs: RATE_LIMIT_WINDOW_MS,
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
      const error = "slack webhook URL must point at hooks.slack.com or the enabled local simulator";
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

    const url = githubApiUrl(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`);
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

    const url = githubApiUrl(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`);

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

const PAGERDUTY_RESPONSE_MAX_BYTES = 256 * 1024;
const PAGERDUTY_DEFAULT_RATE_LIMIT_PER_MIN = 120;
const PAGERDUTY_ACTIONABLE_EVENTS = new Set([
  "incident.triggered",
  "incident.reassigned",
  "incident.escalated",
  "incident.reopened",
]);

type PagerDutyToolContext = {
  orgId?: string;
  runId?: string;
  nodeId?: string;
  workflowId?: string;
};

type PagerDutyConnectionFields = z.infer<typeof pagerDutyConnectionInput>;

function pagerDutyApiBase(region: "us" | "eu"): string {
  return localIntegrationSimulatorEndpoint("/pagerduty")
    ?? (region === "eu" ? "https://api.eu.pagerduty.com" : "https://api.pagerduty.com");
}

function pagerDutyHeaders(token: string, requesterEmail: string): Record<string, string> {
  return {
    accept: "application/vnd.pagerduty+json;version=2",
    authorization: `Token token=${token}`,
    "content-type": "application/json",
    from: requesterEmail,
  };
}

function parsePagerDutyIncident(body: string): z.infer<typeof pagerDutyIncident> | null {
  const parsed = safeParseJson(body);
  const raw = parsed?.incident;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const service = record.service && typeof record.service === "object" && !Array.isArray(record.service)
    ? record.service as Record<string, unknown>
    : null;
  const assignments = Array.isArray(record.assignments) ? record.assignments : [];
  const candidate = {
    id: record.id,
    status: record.status,
    title: typeof record.title === "string" ? record.title.slice(0, 2_000) : null,
    urgency: typeof record.urgency === "string" ? record.urgency : null,
    serviceId: typeof service?.id === "string" ? service.id : null,
    assignedUserIds: assignments.flatMap((assignment) => {
      if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return [];
      const assignee = (assignment as Record<string, unknown>).assignee;
      if (!assignee || typeof assignee !== "object" || Array.isArray(assignee)) return [];
      const id = (assignee as Record<string, unknown>).id;
      return typeof id === "string" ? [id] : [];
    }),
  };
  const result = pagerDutyIncident.safeParse(candidate);
  return result.success ? result.data : null;
}

async function gatePagerDutyCall(
  tool: Extract<IntegrationToolName, `pagerduty.${string}`>,
  input: PagerDutyConnectionFields,
  executionContext: PagerDutyToolContext,
): Promise<GateResult> {
  return gateIntegrationCall({
    orgId: executionContext.orgId,
    tool,
    credentialKind: "pagerduty_api_token",
    credentialName: input.credential,
    rateLimitPerMin: input.rateLimitPerMin ?? PAGERDUTY_DEFAULT_RATE_LIMIT_PER_MIN,
  });
}

async function recordPagerDutyCall(input: {
  tool: Extract<IntegrationToolName, `pagerduty.${string}`>;
  credentialName: string;
  executionContext: PagerDutyToolContext;
  ok: boolean;
  statusCode?: number;
  error?: string;
  latencyMs: number;
}): Promise<void> {
  if (!input.executionContext.orgId) return;
  await fireIntegrationRecorder({
    orgId: input.executionContext.orgId,
    tool: input.tool,
    credentialName: input.credentialName,
    executionContext: input.executionContext,
    ok: input.ok,
    statusCode: input.statusCode,
    error: input.error,
    latencyMs: input.latencyMs,
  });
}

/**
 * Safe-default working-hours evaluator. Invalid policy data is treated as
 * working time, so malformed configuration cannot authorize mutations.
 *
 * Zone resolution and midnight-crossing matching come from `zoned-window.ts`,
 * shared with the generic `time.window` tool. The BIAS stays here: that tool
 * rejects malformed configuration, this one absorbs it as "working hours".
 */
export function isWithinPagerDutyWorkingHours(
  at: Date,
  timeZone: string,
  windows: Array<{ days: number[]; start: string; end: string }>,
): boolean {
  if (windows.length === 0) return true;
  const clock = zonedClock(at, timeZone);
  if (!clock) return true;
  for (const window of windows) {
    const start = parseLocalMinute(window.start);
    const end = parseLocalMinute(window.end);
    if (start === null || end === null || start === end || window.days.length === 0) return true;
    if (windowContains(clock, window.days, start, end)) return true;
  }
  return false;
}

export const pagerDutyIncidentGetTool = {
  name: "pagerduty.incident.get" as const,
  description: "Read one authoritative PagerDuty incident using a stored API token.",
  inputSchema: pagerDutyIncidentGetInput,
  outputSchema: pagerDutyIncidentGetOutput,
  inputExample: {
    credential: "pagerduty-api",
    requesterEmail: "operator@example.com",
    region: "us",
    incidentId: "{{context.on_pagerduty.output.event.incidentId}}",
  },
  writeSide: false as const,
  async execute(
    input: z.infer<typeof pagerDutyIncidentGetInput>,
    _context: Record<string, unknown>,
    executionContext: PagerDutyToolContext,
  ): Promise<z.infer<typeof pagerDutyIncidentGetOutput>> {
    const start = Date.now();
    const gate = await gatePagerDutyCall("pagerduty.incident.get", input, executionContext);
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await recordPagerDutyCall({
        tool: "pagerduty.incident.get",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: gate.error,
        latencyMs,
      });
      return { ok: false, error: gate.error, latencyMs };
    }
    const result = await fetchHttpTarget(
      `${pagerDutyApiBase(input.region)}/incidents/${encodeURIComponent(input.incidentId)}`,
      {
        method: "GET",
        headers: pagerDutyHeaders(gate.credentialSecret, input.requesterEmail),
        maxResponseBytes: PAGERDUTY_RESPONSE_MAX_BYTES,
      },
    ).catch(() => null);
    const latencyMs = Date.now() - start;
    const incident = result?.ok ? parsePagerDutyIncident(result.body) : null;
    const ok = Boolean(result?.ok && incident && incident.id === input.incidentId);
    const error = ok ? undefined : `pagerduty incident read failed${result ? ` (${result.statusCode})` : ""}`;
    await recordPagerDutyCall({
      tool: "pagerduty.incident.get",
      credentialName: input.credential,
      executionContext,
      ok,
      statusCode: result?.statusCode,
      error,
      latencyMs,
    });
    return ok
      ? { ok: true, incident: incident!, statusCode: result!.statusCode, latencyMs }
      : { ok: false, statusCode: result?.statusCode, error: error!, latencyMs };
  },
};

export const pagerDutyPolicyEvaluateTool = {
  name: "pagerduty.policy.evaluate" as const,
  description: "Evaluate PagerDuty event type, assignment, filters, and working hours without an LLM.",
  inputSchema: pagerDutyPolicyEvaluateInput,
  outputSchema: pagerDutyPolicyEvaluateOutput,
  inputExample: {
    eventType: "{{context.on_pagerduty.output.event.eventType}}",
    occurredAt: "{{context.on_pagerduty.output.event.occurredAt}}",
    receivedAt: "{{context.on_pagerduty.output.event.receivedAt}}",
    incident: "{{context.load_incident.output.result.incident}}",
    pagerDutyUserId: "PAGERDUTY_USER_ID",
    timeZone: "UTC",
    workingHours: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
  },
  writeSide: false as const,
  async execute(
    input: z.infer<typeof pagerDutyPolicyEvaluateInput>,
  ): Promise<z.infer<typeof pagerDutyPolicyEvaluateOutput>> {
    const start = Date.now();
    const actionable = new Set(input.actionableEventTypes ?? PAGERDUTY_ACTIONABLE_EVENTS);
    const eventAt = new Date(input.occurredAt);
    const receivedAt = new Date(input.receivedAt);
    const incident = pagerDutyIncident.safeParse(input.incident);
    if (!incident.success || Number.isNaN(eventAt.getTime()) || Number.isNaN(receivedAt.getTime())) {
      return {
        ok: true,
        shouldAct: false,
        reason: "invalid_runtime_input",
        eventOutsideWorkingHours: false,
        receivedOutsideWorkingHours: false,
        latencyMs: Date.now() - start,
      };
    }
    const eventOutsideWorkingHours = !isWithinPagerDutyWorkingHours(eventAt, input.timeZone, input.workingHours);
    const receivedOutsideWorkingHours = !isWithinPagerDutyWorkingHours(receivedAt, input.timeZone, input.workingHours);
    let reason = "matched";
    if (!actionable.has(input.eventType)) reason = "event_not_actionable";
    else if (incident.data.status === "resolved") reason = "incident_resolved";
    else if (!incident.data.assignedUserIds.includes(input.pagerDutyUserId)) reason = "user_not_assigned";
    else if (input.serviceIds.length > 0 && (!incident.data.serviceId || !input.serviceIds.includes(incident.data.serviceId))) reason = "service_filtered";
    else if (input.urgencies.length > 0 && (!incident.data.urgency || !input.urgencies.includes(incident.data.urgency))) reason = "urgency_filtered";
    else if (!eventOutsideWorkingHours) reason = "event_in_working_hours";
    else if (!receivedOutsideWorkingHours) reason = "received_in_working_hours";
    return {
      ok: true,
      shouldAct: reason === "matched",
      reason,
      eventOutsideWorkingHours,
      receivedOutsideWorkingHours,
      latencyMs: Date.now() - start,
    };
  },
};

export const pagerDutyAcknowledgeTool = {
  name: "pagerduty.incident.acknowledge" as const,
  description: "Acknowledge one PagerDuty incident using a stored API token.",
  inputSchema: pagerDutyAcknowledgeInput,
  outputSchema: pagerDutyMutationOutput,
  inputExample: {
    credential: "pagerduty-api",
    requesterEmail: "operator@example.com",
    region: "us",
    incidentId: "{{context.on_pagerduty.output.event.incidentId}}",
  },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof pagerDutyAcknowledgeInput>,
    _context: Record<string, unknown>,
    executionContext: PagerDutyToolContext,
  ): Promise<z.infer<typeof pagerDutyMutationOutput>> {
    const start = Date.now();
    const gate = await gatePagerDutyCall("pagerduty.incident.acknowledge", input, executionContext);
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await recordPagerDutyCall({
        tool: "pagerduty.incident.acknowledge",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: gate.error,
        latencyMs,
      });
      return { ok: false, error: gate.error, latencyMs };
    }
    const result = await fetchHttpTarget(
      `${pagerDutyApiBase(input.region)}/incidents/${encodeURIComponent(input.incidentId)}`,
      {
        method: "PUT",
        headers: pagerDutyHeaders(gate.credentialSecret, input.requesterEmail),
        body: JSON.stringify({
          incident: {
            id: input.incidentId,
            type: "incident_reference",
            status: "acknowledged",
          },
        }),
        maxResponseBytes: PAGERDUTY_RESPONSE_MAX_BYTES,
      },
    ).catch(() => null);
    const latencyMs = Date.now() - start;
    const ok = Boolean(result?.ok);
    const error = ok ? undefined : `pagerduty acknowledge failed${result ? ` (${result.statusCode})` : ""}`;
    await recordPagerDutyCall({
      tool: "pagerduty.incident.acknowledge",
      credentialName: input.credential,
      executionContext,
      ok,
      statusCode: result?.statusCode,
      error,
      latencyMs,
    });
    return ok
      ? { ok: true, statusCode: result!.statusCode, latencyMs }
      : { ok: false, statusCode: result?.statusCode, error: error!, latencyMs };
  },
};

export const pagerDutySnoozeTool = {
  name: "pagerduty.incident.snooze" as const,
  description: "Snooze one PagerDuty incident for a bounded duration using a stored API token.",
  inputSchema: pagerDutySnoozeInput,
  outputSchema: pagerDutyMutationOutput,
  inputExample: {
    credential: "pagerduty-api",
    requesterEmail: "operator@example.com",
    region: "us",
    incidentId: "{{context.on_pagerduty.output.event.incidentId}}",
    durationSeconds: 43_200,
  },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof pagerDutySnoozeInput>,
    _context: Record<string, unknown>,
    executionContext: PagerDutyToolContext,
  ): Promise<z.infer<typeof pagerDutyMutationOutput>> {
    const start = Date.now();
    const gate = await gatePagerDutyCall("pagerduty.incident.snooze", input, executionContext);
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await recordPagerDutyCall({
        tool: "pagerduty.incident.snooze",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: gate.error,
        latencyMs,
      });
      return { ok: false, error: gate.error, latencyMs };
    }
    const result = await fetchHttpTarget(
      `${pagerDutyApiBase(input.region)}/incidents/${encodeURIComponent(input.incidentId)}/snooze`,
      {
        method: "POST",
        headers: pagerDutyHeaders(gate.credentialSecret, input.requesterEmail),
        body: JSON.stringify({ duration: input.durationSeconds }),
        maxResponseBytes: PAGERDUTY_RESPONSE_MAX_BYTES,
      },
    ).catch(() => null);
    const latencyMs = Date.now() - start;
    const ok = Boolean(result?.ok);
    const error = ok ? undefined : `pagerduty snooze failed${result ? ` (${result.statusCode})` : ""}`;
    await recordPagerDutyCall({
      tool: "pagerduty.incident.snooze",
      credentialName: input.credential,
      executionContext,
      ok,
      statusCode: result?.statusCode,
      error,
      latencyMs,
    });
    return ok
      ? { ok: true, statusCode: result!.statusCode, latencyMs }
      : { ok: false, statusCode: result?.statusCode, error: error!, latencyMs };
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
