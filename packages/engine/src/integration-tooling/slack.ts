/** Slack Incoming Webhook integration tool. */

import { z } from "zod";

import { fetchHttpTarget } from "../http-policy";
import { isLocalSlackSimulatorUrl } from "../local-integration-simulator";
import {
  envPositiveInt,
  fireIntegrationRecorder,
  gateIntegrationCall,
  truncate,
} from "./shared";

function isSlackHookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" && parsed.hostname === "hooks.slack.com")
      || isLocalSlackSimulatorUrl(url);
  } catch {
    return false;
  }
}

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
