import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeToolMock } = vi.hoisted(() => ({ executeToolMock: vi.fn() }));
vi.mock("./tool-registry", () => ({ executeTool: executeToolMock }));

import {
  callGithubAddIssueComment,
  callGithubCreateIssue,
  callSlackPost,
  callWebhookSend,
} from "./integration-dispatch";

beforeEach(() => {
  executeToolMock.mockReset();
});

describe("integration-dispatch — shared per-tool invocation helpers", () => {
  // These thin helpers are the single source of truth for each tool's name +
  // input arg shape, shared by dispatchReportDelivery, the recovery /handoff
  // dispatcher, and the alert dispatcher. The byte-identical
  // `executeTool(name, input, {}, ctx)` args are what keeps all three consumers
  // behavior-preserving after the consolidation.
  const ctx = { orgId: "org1", runId: "run-2" } as const;

  it("callSlackPost → slack.post with {credential,text}", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, latencyMs: 1 });
    await callSlackPost(ctx, { credential: "ops", text: "hi" });
    expect(executeToolMock).toHaveBeenCalledWith("slack.post", { credential: "ops", text: "hi" }, {}, ctx);
  });

  it("callSlackPost includes Block Kit blocks when present", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, latencyMs: 1 });
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Incident" } }];
    await callSlackPost(ctx, { credential: "ops", text: "fallback", blocks });
    expect(executeToolMock).toHaveBeenCalledWith(
      "slack.post",
      { credential: "ops", text: "fallback", blocks },
      {},
      ctx,
    );
  });

  it("callGithubCreateIssue omits labels/assignees when absent", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true });
    await callGithubCreateIssue(ctx, { credential: "gh", owner: "o", repo: "r", title: "t", body: "b" });
    expect(executeToolMock).toHaveBeenCalledWith(
      "github.create_issue",
      { credential: "gh", owner: "o", repo: "r", title: "t", body: "b" },
      {},
      ctx,
    );
  });

  it("callGithubCreateIssue omits empty-array labels/assignees", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true });
    await callGithubCreateIssue(ctx, { credential: "gh", owner: "o", repo: "r", title: "t", body: "b", labels: [], assignees: [] });
    expect(executeToolMock).toHaveBeenCalledWith(
      "github.create_issue",
      { credential: "gh", owner: "o", repo: "r", title: "t", body: "b" },
      {},
      ctx,
    );
  });

  it("callGithubCreateIssue includes labels/assignees when present", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true });
    await callGithubCreateIssue(ctx, {
      credential: "gh", owner: "o", repo: "r", title: "t", body: "b", labels: ["incident"], assignees: ["u1"],
    });
    expect(executeToolMock).toHaveBeenCalledWith(
      "github.create_issue",
      { credential: "gh", owner: "o", repo: "r", title: "t", body: "b", labels: ["incident"], assignees: ["u1"] },
      {},
      ctx,
    );
  });

  it("callGithubAddIssueComment → github.add_issue_comment with issueNumber + body", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, commentId: 5 });
    await callGithubAddIssueComment(ctx, { credential: "gh", owner: "o", repo: "r", issueNumber: 7, body: "b" });
    expect(executeToolMock).toHaveBeenCalledWith(
      "github.add_issue_comment",
      { credential: "gh", owner: "o", repo: "r", issueNumber: 7, body: "b" },
      {},
      ctx,
    );
  });

  it("callWebhookSend omits headers when absent", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true });
    await callWebhookSend(ctx, { credential: "wh", url: "https://hooks.test/x", payload: { a: 1 } });
    expect(executeToolMock).toHaveBeenCalledWith(
      "webhook.send",
      { credential: "wh", url: "https://hooks.test/x", payload: { a: 1 } },
      {},
      ctx,
    );
  });

  it("callWebhookSend includes headers when present", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true });
    await callWebhookSend(ctx, {
      credential: "wh", url: "https://hooks.test/x", payload: { a: 1 }, headers: { "x-idempotency-key": "k" },
    });
    expect(executeToolMock).toHaveBeenCalledWith(
      "webhook.send",
      { credential: "wh", url: "https://hooks.test/x", payload: { a: 1 }, headers: { "x-idempotency-key": "k" } },
      {},
      ctx,
    );
  });

  it("helpers do not catch — a thrown executeTool propagates to the caller", async () => {
    executeToolMock.mockRejectedValueOnce(new Error("boom"));
    await expect(callSlackPost(ctx, { credential: "ops", text: "hi" })).rejects.toThrow("boom");
  });
});
