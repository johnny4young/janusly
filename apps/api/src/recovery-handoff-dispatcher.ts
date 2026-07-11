/**
 * Per-destination dispatch helper for recovery incident handoffs. Each branch
 * routes through the shared per-tool invocation helpers in
 * `@janusly/engine/src/integration-dispatch` (`callSlackPost` /
 * `callGithubCreateIssue` / `callGithubAddIssueComment` / `callWebhookSend`) — the
 * same `executeTool` chokepoint `dispatchReportDelivery` and the alert dispatcher
 * use — so SSRF / body-cap / rate-limit / usage events / audit / safe-persist all
 * apply for free. Only the low-level tool-invocation layer is shared: this dispatcher
 * keeps its own result mapping (`externalId` / `externalUrl` / `commentId`), wall-clock
 * latency, and error cap, which legitimately differ from the report-deliver envelope.
 *
 * Branching summary:
 *  - **slack**: `slack.post` with composed markdown. v1 is post-only —
 *    incoming webhooks are channel-bound and have no thread API, so the
 *    route's cooldown gate handles the "edit not duplicate" promise on
 *    Slack by responding 200 `{ alreadyDispatched: true }` without
 *    re-firing.
 *  - **github**: lookup `recovery_item_handoffs`. First call →
 *    `github.create_issue` (captures `issueNumber` + `url`). Subsequent
 *    calls → `github.add_issue_comment` against the captured
 *    `issueNumber`. No duplicate issues created.
 *  - **linear** + **webhook**: `webhook.send` against the operator-
 *    configured URL with `X-Idempotency-Key` header. The receiver dedupes
 *    by that key. Linear is just webhook.send disguised; the operator's
 *    Linear automation translates to native API calls.
 *
 * Every helper returns `{ ok, statusCode?, error?, latencyMs,
 * externalId?, externalUrl?, commentId? }` — NEVER throws.
 */

import {
  buildHandoffIdempotencyKey,
  composeHandoffMessage,
  type HandoffDispatchResult,
  type HandoffMessageInput,
  type RecoveryHandoffDestination,
} from "@janusly/shared";
import {
  type RecoveryItemHandoff,
} from "@janusly/data";

import {
  callGithubAddIssueComment,
  callGithubCreateIssue,
  callSlackPost,
  callWebhookSend,
} from "@janusly/engine/src/integration-dispatch";

export type DispatchContext = {
  orgId: string;
  recoveryItemId: string;
  destination: RecoveryHandoffDestination;
  credentialName: string;
  message: ReturnType<typeof composeHandoffMessage>;
  /** Existing handoff row for this `(orgId, item, destination)` triple, if any. */
  existing: RecoveryItemHandoff | null;
  /** Body fields from the request, per destination. */
  request: {
    owner?: string;
    repo?: string;
    labels?: string[];
    assignees?: string[];
    url?: string;
    channel?: string;
  };
};

/**
 * Build a fresh `HandoffMessageInput` for the append branch — the
 * route calls this when a GitHub handoff already has an issue number so the
 * message lines read "Recovery item update (dispatch #N)" instead of the
 * create-mode header.
 */
export function composeAppendMessage(
  base: HandoffMessageInput,
  existing: RecoveryItemHandoff,
): ReturnType<typeof composeHandoffMessage> {
  return composeHandoffMessage({
    ...base,
    appendMode: true,
    dispatchCount: existing.dispatchCount + 1,
  });
}

async function dispatchSlack(ctx: DispatchContext): Promise<HandoffDispatchResult> {
  const started = Date.now();
  try {
    const result = await callSlackPost(
      { orgId: ctx.orgId },
      { credential: ctx.credentialName, text: ctx.message.markdown },
    );
    return {
      destination: "slack",
      ok: result.ok === true,
      statusCode: typeof result.statusCode === "number" ? Math.trunc(result.statusCode) : null,
      error: typeof result.error === "string" ? result.error.slice(0, 1000) : null,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      destination: "slack",
      ok: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      latencyMs: Date.now() - started,
    };
  }
}

async function dispatchGithub(ctx: DispatchContext): Promise<HandoffDispatchResult> {
  const started = Date.now();
  const owner = ctx.request.owner!;
  const repo = ctx.request.repo!;

  try {
    // Append branch: prior dispatch returned an externalId (the issue
    // number). Use `github.add_issue_comment` to keep context in one
    // thread instead of spawning duplicates.
    if (ctx.existing && ctx.existing.externalId && /^\d+$/.test(ctx.existing.externalId)) {
      const issueNumber = Number.parseInt(ctx.existing.externalId, 10);
      const result = await callGithubAddIssueComment(
        { orgId: ctx.orgId },
        {
          credential: ctx.credentialName,
          owner,
          repo,
          issueNumber,
          body: ctx.message.markdown,
        },
      );
      const ok = result.ok === true;
      const commentId = typeof result.commentId === "number" ? String(result.commentId) : null;
      return {
        destination: "github",
        ok,
        statusCode: typeof result.statusCode === "number" ? Math.trunc(result.statusCode) : null,
        error: typeof result.error === "string" ? result.error.slice(0, 1000) : null,
        latencyMs: Date.now() - started,
        // Preserve the original issueNumber + issueUrl; commentId is an
        // additive surface (rendered as "Comment added" in the UI).
        externalId: ctx.existing.externalId,
        externalUrl: ctx.existing.externalUrl,
        commentId,
      };
    }

    // Create branch.
    const result = await callGithubCreateIssue(
      { orgId: ctx.orgId },
      {
        credential: ctx.credentialName,
        owner,
        repo,
        title: ctx.message.subject,
        body: ctx.message.markdown,
        labels: ctx.request.labels,
        assignees: ctx.request.assignees,
      },
    );
    const ok = result.ok === true;
    const issueNumber = typeof result.issueNumber === "number" ? result.issueNumber : null;
    const issueUrl = typeof result.url === "string" ? result.url : null;
    return {
      destination: "github",
      ok,
      statusCode: typeof result.statusCode === "number" ? Math.trunc(result.statusCode) : null,
      error: typeof result.error === "string" ? result.error.slice(0, 1000) : null,
      latencyMs: Date.now() - started,
      externalId: issueNumber !== null ? String(issueNumber) : null,
      externalUrl: issueUrl,
    };
  } catch (err) {
    return {
      destination: "github",
      ok: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      latencyMs: Date.now() - started,
    };
  }
}

async function dispatchWebhookOrLinear(
  ctx: DispatchContext,
  destination: "webhook" | "linear",
): Promise<HandoffDispatchResult> {
  const started = Date.now();
  const url = ctx.request.url!;
  const idempotencyKey = buildHandoffIdempotencyKey(ctx.recoveryItemId, destination);

  try {
    const result = await callWebhookSend(
      { orgId: ctx.orgId },
      {
        credential: ctx.credentialName,
        url,
        payload: {
          ...ctx.message.structured,
          idempotencyKey,
        },
        headers: {
          "x-idempotency-key": idempotencyKey,
        },
      },
    );
    return {
      destination,
      ok: result.ok === true,
      statusCode: typeof result.statusCode === "number" ? Math.trunc(result.statusCode) : null,
      error: typeof result.error === "string" ? result.error.slice(0, 1000) : null,
      latencyMs: Date.now() - started,
      externalId: ctx.existing?.externalId ?? null,
      externalUrl: ctx.existing?.externalUrl ?? null,
    };
  } catch (err) {
    return {
      destination,
      ok: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Route the dispatch to the correct per-destination helper. The caller
 * (the route handler) is responsible for the Slack cooldown short-circuit
 * + `upsertHandoff` persistence + audit row writing.
 */
export async function dispatchHandoff(ctx: DispatchContext): Promise<HandoffDispatchResult> {
  switch (ctx.destination) {
    case "slack":
      return dispatchSlack(ctx);
    case "github":
      return dispatchGithub(ctx);
    case "webhook":
      return dispatchWebhookOrLinear(ctx, "webhook");
    case "linear":
      return dispatchWebhookOrLinear(ctx, "linear");
    default: {
      const exhaustive: never = ctx.destination;
      throw new Error(`unhandled handoff destination: ${String(exhaustive)}`);
    }
  }
}
