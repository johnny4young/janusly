/**
 * Shared report-delivery dispatch — used by both `POST /reports/run-explain/deliver`
 * and `POST /recovery/items/:id/evidence/deliver`. Both push a pre-rendered report
 * to one of three destinations (Slack message / GitHub issue / signed webhook)
 * through the `executeTool` chokepoint, which owns credential resolution, the
 * per-tool rate-limit, usage events, and the SSRF / body-cap / timeout guards via
 * `fetchHttpTarget`.
 *
 * The dispatcher NEVER throws on a runtime failure (missing credential, non-2xx,
 * network blip) — it returns `{ ok: false, error, ... }` so the caller can audit
 * and respond uniformly. `credentialName` is the operator-visible credential
 * identifier, NEVER the env-var that backs the secret; the env-var name never
 * appears in any request, response, or audit metadata.
 */

import { z } from "zod";

import {
  callGithubCreateIssue,
  callSlackPost,
  callWebhookSend,
} from "@janusly/engine/src/integration-dispatch";

/** Outer route-level rate-limit bucket shared by both report-deliver routes. The
 *  inner per-tool bucket (`tool.<name>`) is enforced inside the chokepoint. */
export const REPORTS_DELIVER_RATE_LIMIT_BUCKET = "reports.deliver";
/** Outer-bucket default — 60/min/org for report delivery. */
export const REPORTS_DELIVER_RATE_LIMIT_PER_MIN = 60;

/**
 * A delivery destination: the closed `kind`, the operator-visible credential
 * name, and the per-kind extra fields. Kept a single non-union object (no
 * `discriminatedUnion`) so the Zod parse stays one pass and the dispatcher's
 * TypeScript handling is uniform; per-kind required fields are enforced via
 * `refineDeliveryDestination` and the integration tool's own input schema is the
 * final gate.
 */
export const deliverDestinationSchema = z.object({
  kind: z.enum(["slack", "github", "webhook"]),
  credentialName: z.string().min(1),
  // GitHub-only fields.
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).max(10).optional(),
  // Webhook-only field.
  url: z.string().url().optional(),
});

/** A parsed delivery destination. */
export type DeliveryDestination = z.infer<typeof deliverDestinationSchema>;

/**
 * Per-kind required-field check, shared by both routes' body `superRefine`.
 * `basePath` lets each caller point the issue path at its own `destination`
 * field location (both currently use the default `["destination"]`).
 */
export function refineDeliveryDestination(
  destination: DeliveryDestination,
  ctx: z.RefinementCtx,
  basePath: (string | number)[] = ["destination"],
): void {
  if (destination.kind === "github") {
    if (!destination.owner) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...basePath, "owner"], message: "owner is required for github destination" });
    }
    if (!destination.repo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...basePath, "repo"], message: "repo is required for github destination" });
    }
  }
  if (destination.kind === "webhook") {
    if (!destination.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...basePath, "url"], message: "url is required for webhook destination" });
    }
  }
}

/** Terminal outcome of a delivery attempt — never throws; failures become `ok: false`. */
export type DeliveryOutcome = {
  ok: boolean;
  statusCode?: number;
  error?: string;
  latencyMs: number;
  /** For GitHub, the created issue URL (when the tool returned one). */
  deliveryId?: string;
};

function normalizeDeliveryResult(result: Record<string, unknown>): DeliveryOutcome {
  return {
    ok: result.ok === true,
    statusCode: typeof result.statusCode === "number" ? result.statusCode : undefined,
    error: typeof result.error === "string" ? result.error : undefined,
    latencyMs: typeof result.latencyMs === "number" ? result.latencyMs : 0,
  };
}

/**
 * Dispatch a pre-rendered report to the destination. The caller renders the
 * Slack text + GitHub title (report-specific phrasing) and supplies the GitHub
 * issue body (Markdown) + the webhook payload (the structured JSON envelope the
 * receiver's HMAC path signs).
 *
 * dryRun posture: write-side tools normally honour `executionContext.dryRun` to
 * skip the upstream call from a `replayMode="validation"` workflow run. These
 * routes run outside a workflow run, so that runtime gate isn't applicable; the
 * rate-limit + credential + audit gates are the right safeguards at this layer.
 */
export async function dispatchReportDelivery(args: {
  orgId: string;
  runId?: string;
  destination: DeliveryDestination;
  slackText: string;
  githubTitle: string;
  githubBody: string;
  webhookPayload: Record<string, unknown>;
}): Promise<DeliveryOutcome> {
  const { orgId, runId, destination } = args;
  // `runId` (when present) rides usage_events for traceability; nodeId/workflowId
  // stay unset — this is a route-level call, not a workflow-node execution.
  const ctx = runId ? { orgId, runId } : { orgId };

  try {
    if (destination.kind === "slack") {
      const result = await callSlackPost(ctx, { credential: destination.credentialName, text: args.slackText });
      return normalizeDeliveryResult(result);
    }

    if (destination.kind === "github") {
      const result = await callGithubCreateIssue(ctx, {
        credential: destination.credentialName,
        owner: destination.owner!,
        repo: destination.repo!,
        title: args.githubTitle,
        body: args.githubBody,
        labels: destination.labels,
      });
      const issueUrl = typeof result.url === "string" ? result.url : undefined;
      return { ...normalizeDeliveryResult(result), deliveryId: issueUrl };
    }

    // webhook — the structured JSON envelope is the receiver-friendly shape and
    // is exactly what the tool's HMAC-SHA256 path signs.
    const result = await callWebhookSend(ctx, {
      credential: destination.credentialName,
      url: destination.url!,
      payload: args.webhookPayload,
    });
    return normalizeDeliveryResult(result);
  } catch (err) {
    // executeTool throws only on (a) unknown tool name or (b) zod input/output
    // validation failure — neither reachable given the route gates inputs upfront.
    // Mirror the tool contract by never propagating throws so the audit row still lands.
    const message = err instanceof Error ? err.message : "delivery failed";
    return { ok: false, error: message, latencyMs: 0 };
  }
}
