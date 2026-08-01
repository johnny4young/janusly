/** GitHub issue integration tools. */

import { z } from "zod";

import { fetchHttpTarget } from "../http-policy";
import { localIntegrationSimulatorEndpoint } from "../local-integration-simulator";
import {
  envPositiveInt,
  fireIntegrationRecorder,
  gateIntegrationCall,
  safeParseJson,
} from "./shared";

function githubApiUrl(path: string): string {
  return localIntegrationSimulatorEndpoint(`/github${path}`) ?? `https://api.github.com${path}`;
}

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
