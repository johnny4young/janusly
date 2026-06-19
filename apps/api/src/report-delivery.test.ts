import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { executeToolMock } = vi.hoisted(() => ({ executeToolMock: vi.fn() }));
vi.mock("@janusly/engine/src/tool-registry", () => ({ executeTool: executeToolMock }));

import {
  callGithubAddIssueComment,
  callGithubCreateIssue,
  callSlackPost,
  callWebhookSend,
  deliverDestinationSchema,
  dispatchReportDelivery,
  refineDeliveryDestination,
} from "./report-delivery";

// Mirror how both routes wrap the shared destination schema + refine.
const wrap = z
  .object({ destination: deliverDestinationSchema })
  .superRefine((value, ctx) => refineDeliveryDestination(value.destination, ctx));

beforeEach(() => {
  executeToolMock.mockReset();
});

describe("refineDeliveryDestination — per-kind required fields", () => {
  it("requires owner + repo for github", () => {
    expect(wrap.safeParse({ destination: { kind: "github", credentialName: "gh" } }).success).toBe(false);
    expect(wrap.safeParse({ destination: { kind: "github", credentialName: "gh", owner: "o" } }).success).toBe(false);
    expect(wrap.safeParse({ destination: { kind: "github", credentialName: "gh", owner: "o", repo: "r" } }).success).toBe(true);
  });

  it("requires url for webhook", () => {
    expect(wrap.safeParse({ destination: { kind: "webhook", credentialName: "wh" } }).success).toBe(false);
    expect(wrap.safeParse({ destination: { kind: "webhook", credentialName: "wh", url: "https://hooks.test/x" } }).success).toBe(true);
  });

  it("slack needs only a credential", () => {
    expect(wrap.safeParse({ destination: { kind: "slack", credentialName: "ops-channel" } }).success).toBe(true);
  });
});

describe("dispatchReportDelivery — per-destination executeTool wiring", () => {
  const base = { orgId: "org1", slackText: "SLACK", githubTitle: "TITLE", githubBody: "BODY", webhookPayload: { a: 1 } } as const;

  it("routes slack via slack.post and normalizes the envelope", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, statusCode: 200, latencyMs: 7 });
    const out = await dispatchReportDelivery({ ...base, destination: { kind: "slack", credentialName: "ops" } });
    const [name, input, ctxArg, exec] = executeToolMock.mock.calls[0]!;
    expect(name).toBe("slack.post");
    expect(input).toEqual({ credential: "ops", text: "SLACK" });
    expect(ctxArg).toEqual({});
    expect(exec).toEqual({ orgId: "org1" });
    expect(out).toMatchObject({ ok: true, statusCode: 200, latencyMs: 7 });
  });

  it("routes github via github.create_issue, threads runId, and surfaces the issue URL as deliveryId", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, statusCode: 201, latencyMs: 9, url: "https://github.com/o/r/issues/3" });
    const out = await dispatchReportDelivery({
      ...base,
      runId: "run-9",
      destination: { kind: "github", credentialName: "gh", owner: "o", repo: "r", labels: ["incident"] },
    });
    const [name, input, , exec] = executeToolMock.mock.calls[0]!;
    expect(name).toBe("github.create_issue");
    expect(input).toMatchObject({ credential: "gh", owner: "o", repo: "r", title: "TITLE", body: "BODY", labels: ["incident"] });
    expect(exec).toEqual({ orgId: "org1", runId: "run-9" });
    expect(out.deliveryId).toBe("https://github.com/o/r/issues/3");
  });

  it("routes webhook via webhook.send with the JSON payload", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, latencyMs: 3 });
    await dispatchReportDelivery({ ...base, destination: { kind: "webhook", credentialName: "wh", url: "https://hooks.test/x" } });
    const [name, input] = executeToolMock.mock.calls[0]!;
    expect(name).toBe("webhook.send");
    expect(input).toEqual({ credential: "wh", url: "https://hooks.test/x", payload: { a: 1 } });
  });

  it("never throws — a thrown executeTool becomes { ok: false, latencyMs: 0 }", async () => {
    executeToolMock.mockRejectedValueOnce(new Error("boom"));
    const out = await dispatchReportDelivery({ ...base, destination: { kind: "slack", credentialName: "ops" } });
    expect(out).toEqual({ ok: false, error: "boom", latencyMs: 0 });
  });

  it("propagates a tool { ok: false, error } envelope verbatim (e.g. missing credential)", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: false, error: "credential secret missing for ops", latencyMs: 5 });
    const out = await dispatchReportDelivery({ ...base, destination: { kind: "slack", credentialName: "ops" } });
    expect(out).toMatchObject({ ok: false, error: "credential secret missing for ops", latencyMs: 5 });
  });
});

describe("shared per-tool invocation helpers", () => {
  // These thin helpers are the single source of truth for each tool's name +
  // input arg shape, shared by dispatchReportDelivery AND the recovery /handoff
  // dispatcher. The byte-identical `executeTool(name, input, {}, ctx)` args are
  // what keeps both consumers behavior-preserving after the consolidation.
  const ctx = { orgId: "org1", runId: "run-2" } as const;

  it("callSlackPost → slack.post with {credential,text}", async () => {
    executeToolMock.mockResolvedValueOnce({ ok: true, latencyMs: 1 });
    await callSlackPost(ctx, { credential: "ops", text: "hi" });
    expect(executeToolMock).toHaveBeenCalledWith("slack.post", { credential: "ops", text: "hi" }, {}, ctx);
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
