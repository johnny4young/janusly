/**
 * Thin per-tool `executeTool` invocation helpers, shared by every surface that
 * pushes a rendered report / notification to an external destination through the
 * integration-tool chokepoint: the report-deliver routes
 * (`apps/api/src/report-delivery.ts`), the recovery incident-handoff dispatcher
 * (`apps/api/src/recovery-handoff-dispatcher.ts`), and the alert dispatcher
 * (`packages/engine/src/alerts/dispatcher.ts`).
 *
 * Each helper owns exactly ONE thing — the tool name string and the input arg
 * shape, including the conditional omission of optional fields — and returns the
 * RAW tool envelope. They deliberately do NOT compute latency or catch: every
 * caller keeps its own try/catch, its own latency semantics (tool-reported vs
 * wall-clock), and its own result-to-envelope mapping, all of which legitimately
 * differ across the three surfaces. Centralising the call shape here means a
 * change to a tool's input contract (e.g. `webhook.send` gaining `headers`) is a
 * one-place edit rather than drifting across three hand-rolled dispatchers.
 *
 * The integration-tool chokepoint these wrap (`executeTool`) still owns
 * credential resolution, the per-tool rate-limit, usage events, and the SSRF /
 * body-cap / timeout guards. Lives in `@janusly/engine` so all three callers can
 * import it (apps/api → engine is the established direction; engine never imports
 * apps/api).
 */

import { executeTool, type ToolExecutionContext } from "./tool-registry";

/** `slack.post` — post composed text to a stored Incoming Webhook credential. */
export async function callSlackPost(
  ctx: ToolExecutionContext,
  args: { credential: string; text: string; blocks?: Array<Record<string, unknown>> },
): Promise<Record<string, unknown>> {
  return executeTool(
    "slack.post",
    {
      credential: args.credential,
      text: args.text,
      ...(args.blocks && args.blocks.length > 0 ? { blocks: args.blocks } : {}),
    },
    {},
    ctx,
  );
}

/** `github.create_issue` — open a new issue; `labels` / `assignees` omitted when empty. */
export async function callGithubCreateIssue(
  ctx: ToolExecutionContext,
  args: {
    credential: string;
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels?: string[];
    assignees?: string[];
  },
): Promise<Record<string, unknown>> {
  return executeTool(
    "github.create_issue",
    {
      credential: args.credential,
      owner: args.owner,
      repo: args.repo,
      title: args.title,
      body: args.body,
      ...(args.labels && args.labels.length > 0 ? { labels: args.labels } : {}),
      ...(args.assignees && args.assignees.length > 0 ? { assignees: args.assignees } : {}),
    },
    {},
    ctx,
  );
}

/** `github.add_issue_comment` — append a comment to an existing issue (handoff append branch). */
export async function callGithubAddIssueComment(
  ctx: ToolExecutionContext,
  args: { credential: string; owner: string; repo: string; issueNumber: number; body: string },
): Promise<Record<string, unknown>> {
  return executeTool(
    "github.add_issue_comment",
    {
      credential: args.credential,
      owner: args.owner,
      repo: args.repo,
      issueNumber: args.issueNumber,
      body: args.body,
    },
    {},
    ctx,
  );
}

/** `webhook.send` — POST the JSON payload to the operator URL; `headers` omitted when absent. */
export async function callWebhookSend(
  ctx: ToolExecutionContext,
  args: { credential: string; url: string; payload: Record<string, unknown>; headers?: Record<string, string> },
): Promise<Record<string, unknown>> {
  return executeTool(
    "webhook.send",
    {
      credential: args.credential,
      url: args.url,
      payload: args.payload,
      ...(args.headers ? { headers: args.headers } : {}),
    },
    {},
    ctx,
  );
}
