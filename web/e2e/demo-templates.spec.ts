/**
 * End-to-end validation for the three flagship + four supporting
 * canonical demo templates. Each demo runs through its expected
 * terminal state against the live API + worker so any template config
 * drift (renamed tool fields, validation rules tightened, expression
 * grammar changes) surfaces here. The MCP demo (S3) skips runtime
 * since it depends on an operator-set MCP connection — the test
 * validates template structure only.
 *
 * Write-side tool steps default to `require_ok`, and the lane has no mailer
 * or reachable integration credentials, so a demo whose write cannot be
 * delivered must fail on that step and land in the DLQ instead of passing an
 * `ok: false` envelope downstream.
 *
 * Driven via API requests, not UI, so the spec stays under the 30s
 * Playwright default timeout per test even at 7 demos.
 */

import { expect, test, type APIRequestContext } from "@playwright/test";

import {
  ALL_DEMO_TEMPLATE_IDS,
  fetchReadiness,
  findDeadLetterForRun,
  loadTemplate,
  pollUntilTerminal,
  pollUntilWaitingOrTerminal,
  resumeApproval,
  resumeWebhook,
  seedCredential,
  startRun,
  type RunSnapshot,
} from "./_helpers/demo-helpers";

/** The write step failed with the tool's own reason, nothing after it ran, and the DLQ holds that step. */
async function expectUndeliveredWriteStopsRun(
  request: APIRequestContext,
  runId: string,
  snapshot: RunSnapshot,
  write: { nodeId: string; reason: string; notReached: string[] },
): Promise<void> {
  expect(snapshot.status, `${write.nodeId} could not deliver its write, so the run must fail`).toBe("failed");
  const node = snapshot.nodes.find((n) => n.nodeId === write.nodeId);
  expect(node?.status).toBe("failed");
  expect(node?.errorJson).toMatchObject({ code: "TOOL_RESULT_NOT_OK", writeSide: true });
  expect((node?.errorJson as { message?: string } | undefined)?.message).toContain(write.reason);
  for (const nodeId of write.notReached) {
    expect(snapshot.nodes.find((n) => n.nodeId === nodeId)?.status, `${nodeId} must not run after a failed write`).toBe("pending");
  }
  const dlq = await findDeadLetterForRun(request, runId);
  expect(dlq?.nodeId, "the failed write must reach the DLQ").toBe(write.nodeId);
}

function nodeStatus(snapshot: RunSnapshot, nodeId: string): string | undefined {
  return snapshot.nodes.find((n) => n.nodeId === nodeId)?.status;
}

const NO_MAILER = "Mailer not configured";

test.describe.configure({ mode: "serial" });

test.describe("Demo templates", () => {
  test("catalog exposes all 3 flagship and 4 supporting demo ids", async ({ request }) => {
    const response = await request.get(`${process.env.E2E_API_URL ?? "http://localhost:3001"}/templates`, {
      headers: { "x-org-id": "default", "x-user-id": "dev-user" },
    });
    expect(response.ok()).toBe(true);
    const templates = (await response.json()) as Array<{ id: string; name: string; description: string; workflow: { nodes: unknown[] } }>;
    const ids = templates.map((t) => t.id);
    for (const id of ALL_DEMO_TEMPLATE_IDS) {
      expect(ids, `template ${id} missing from /templates`).toContain(id);
    }
    for (const id of ALL_DEMO_TEMPLATE_IDS) {
      const entry = templates.find((t) => t.id === id);
      expect(entry?.name, `template ${id} name`).toBeTruthy();
      expect(entry?.description, `template ${id} description`).toBeTruthy();
      expect(entry?.workflow.nodes.length, `template ${id} nodes`).toBeGreaterThan(0);
    }
  });

  test("F1 incident-triage summarizes, then stops at the GitHub write its credential cannot authorize", async ({ request }) => {
    await seedCredential(request, { name: "bot-github", kind: "github_token", secretRef: "JANUSLY_CRED_DEMO_GITHUB_TOKEN" });
    await seedCredential(request, { name: "incidents-slack", kind: "slack_webhook", secretRef: "JANUSLY_CRED_DEMO_SLACK_WEBHOOK" });

    const workflow = await loadTemplate(request, "incident-triage");
    const payload = {
      alertName: "API p95 above 800ms",
      service: "checkout-api",
      severity: "high",
    };
    const { runId } = await startRun(request, workflow, payload);

    await pollUntilWaitingOrTerminal(request, runId, "trigger");
    await resumeWebhook(request, runId, "trigger", payload);

    const snapshot = await pollUntilTerminal(request, runId);
    expect(nodeStatus(snapshot, "summarize"), "the AI fallback contract keeps the summary step succeeded").toBe("succeeded");
    await expectUndeliveredWriteStopsRun(request, runId, snapshot, {
      nodeId: "github_issue",
      reason: "credential secret missing for bot-github",
      notReached: ["slack_notify"],
    });
  });

  test("F2 refund-triage-approval pauses on approval, resumes, and stops at the undeliverable refund", async ({ request }) => {
    await seedCredential(request, { name: "partner-webhook", kind: "webhook_secret", secretRef: "JANUSLY_CRED_DEMO_WEBHOOK_SECRET" });

    const workflow = await loadTemplate(request, "refund-triage-approval");
    const payload = {
      customer: "leah@example.com",
      orderId: "ord_8421",
      amountUsd: 49.0,
      reason: "Charged twice for the same order",
    };
    const { runId } = await startRun(request, workflow, payload);

    await pollUntilWaitingOrTerminal(request, runId, "trigger");
    await resumeWebhook(request, runId, "trigger", payload);

    await pollUntilWaitingOrTerminal(request, runId, "human_review");
    await resumeApproval(request, runId, "human_review");

    const final = await pollUntilTerminal(request, runId);
    expect(nodeStatus(final, "analyze")).toBe("succeeded");
    expect(nodeStatus(final, "human_review"), "the approval resumes before the refund write").toBe("succeeded");
    await expectUndeliveredWriteStopsRun(request, runId, final, {
      nodeId: "process_refund",
      reason: "credential secret missing for partner-webhook",
      notReached: ["confirm_email"],
    });
  });

  test("F3 failed-workflow-recovery fails on the http node and lands in DLQ", async ({ request }) => {
    const workflow = await loadTemplate(request, "failed-workflow-recovery");

    const readiness = await fetchReadiness(request, workflow);
    const codes = readiness.issues.map((i) => i.code);
    expect(codes, "readiness should flag sensitive_action_missing_approval").toContain("sensitive_action_missing_approval");

    const payload = {
      customer: "leah@example.com",
      amountUsd: 49.0,
    };
    const { runId } = await startRun(request, workflow, payload);

    await pollUntilWaitingOrTerminal(request, runId, "trigger");
    await resumeWebhook(request, runId, "trigger", payload);

    const snapshot = await pollUntilTerminal(request, runId);
    expect(snapshot.status, "F3 is intentionally broken — run must reach failed").toBe("failed");

    const dlq = await findDeadLetterForRun(request, runId);
    expect(dlq, "F3 must produce a DLQ entry — that is the demo").not.toBeNull();
    expect(dlq?.nodeId).toBe("charge");
  });

  test("S1 monthly-report-pdf reaches a terminal status (analytics URL is a placeholder)", async ({ request }) => {
    const workflow = await loadTemplate(request, "monthly-report-pdf");
    const { runId } = await startRun(request, workflow);

    // Schedule trigger is a passthrough when fired manually — no /resume needed.
    // The fetch_metrics URL is a placeholder (https://analytics.example.com)
    // matching the existing churn-risk template convention — DNS will not
    // resolve in CI, so the http node lands in DLQ on `fetch_metrics`. The
    // template still parses, the runtime executes correctly through the
    // schedule passthrough, and the failure path is documented in the demo
    // narrative as "operator points this at your real analytics endpoint."
    const snapshot = await pollUntilTerminal(request, runId);
    expect(["succeeded", "failed"]).toContain(snapshot.status);

    if (snapshot.status === "failed") {
      const dlq = await findDeadLetterForRun(request, runId);
      expect(dlq, "if monthly-report-pdf failed, the DLQ entry must be on the placeholder fetch_metrics URL").not.toBeNull();
      expect(dlq?.nodeId).toBe("fetch_metrics");
    }
  });

  test("S2 multi-agent-decision debates via the fallback contract, then stops at the unsent email", async ({ request }) => {
    const workflow = await loadTemplate(request, "multi-agent-decision");
    const payload = {
      proposal: "Replace our self-hosted Postgres with a managed RDS instance for the analytics database.",
    };
    const { runId } = await startRun(request, workflow, payload);

    await pollUntilWaitingOrTerminal(request, runId, "trigger");
    await resumeWebhook(request, runId, "trigger", payload);

    const snapshot = await pollUntilTerminal(request, runId, 45_000);
    expect(nodeStatus(snapshot, "debate"), "the AI fallback contract keeps the debate step succeeded").toBe("succeeded");
    await expectUndeliveredWriteStopsRun(request, runId, snapshot, {
      nodeId: "send_decision",
      reason: NO_MAILER,
      notReached: [],
    });
  });

  test("S3 mcp-notion-summary template parses with the expected mcp_tool shape (runtime skipped)", async ({ request }) => {
    const workflow = (await loadTemplate(request, "mcp-notion-summary")) as { nodes: Array<{ id: string; type: string; config: Record<string, unknown> }> };
    const mcpNode = workflow.nodes.find((n) => n.type === "mcp_tool");
    expect(mcpNode, "mcp-notion-summary must contain an mcp_tool node").toBeTruthy();
    expect(mcpNode?.config.connectionAlias).toBe("notion-demo");
    expect(mcpNode?.config.toolName).toBe("pages.read");
  });

  test("S4 bulk-classify-loop classifies a 3-customer batch, then stops at the unsent digest", async ({ request }) => {
    const workflow = await loadTemplate(request, "bulk-classify-loop");
    const payload = {
      customers: [
        { id: "c1", email: "leah@example.com", plan: "free" },
        { id: "c2", email: "max@example.com", plan: "team" },
        { id: "c3", email: "sam@example.com", plan: "free" },
      ],
    };
    const { runId } = await startRun(request, workflow, payload);

    await pollUntilWaitingOrTerminal(request, runId, "trigger");
    await resumeWebhook(request, runId, "trigger", payload);

    const snapshot = await pollUntilTerminal(request, runId, 45_000);
    const loopNode = snapshot.nodes.find((n) => n.nodeId === "normalize");
    expect(loopNode?.status).toBe("succeeded");
    const loopOutput = (loopNode?.stateJson?.output ?? {}) as { count?: number };
    expect(loopOutput.count, "loop should have iterated 3 times").toBe(3);
    expect(nodeStatus(snapshot, "classify"), "the AI fallback contract keeps classification succeeded").toBe("succeeded");

    await expectUndeliveredWriteStopsRun(request, runId, snapshot, {
      nodeId: "send_digest",
      reason: NO_MAILER,
      notReached: [],
    });
  });
});
