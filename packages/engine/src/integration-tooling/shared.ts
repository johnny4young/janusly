/** Shared credential, rate-limit, and usage chokepoint for integration tools. */

import { getCredentialByName, resolveCredentialSecretRef } from "@janusly/data";
import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { getIntegrationUsageRecorder } from "../integration-usage";
import { getEngineRateLimiter } from "../rate-limit";

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

export async function fireIntegrationRecorder(input: FireRecorderInput): Promise<void> {
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

export type GateResult =
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
export async function gateIntegrationCall(args: {
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

export function envPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

export function safeParseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function truncate(value: string, max = 200): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
