/**
 * End-to-end validation for the three flagship + four supporting
 * canonical demo templates. Each demo runs through its expected
 * terminal state against the live API + worker so any template config
 * drift (renamed tool fields, validation rules tightened, expression
 * grammar changes) surfaces here. The MCP demo (S3) skips runtime
 * since it depends on an operator-set MCP connection — the test
 * validates template structure only.
 *
 * Driven via API requests, not UI, so the spec stays under the 30s
 * Playwright default timeout per test even at 7 demos.
 */

import { expect, test } from "@playwright/test";

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
} from "./_helpers/demo-helpers";

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

  test("F1 incident-triage runs to succeeded with seeded credentials", async ({ request }) => {
    await seedCredential(request, { name: "bot-github", kind: "github_token", secretRef: "JANUSLY_DEMO_GITHUB_TOKEN" });
    await seedCredential(request, { name: "incidents-slack", kind: "slack_webhook", secretRef: "JANUSLY_DEMO_SLACK_WEBHOOK" });

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
    expect(snapshot.status, "integration tools return ok:false envelopes; this template should not fail the run").toBe("succeeded");

    const dlq = await findDeadLetterForRun(request, runId);
    expect(dlq, "incident-triage should not throw to DLQ; tool envelopes carry ok:false instead").toBeNull();
  });

  test("F2 refund-triage-approval pauses on approval, resumes, and reaches succeeded", async ({ request }) => {
    await seedCredential(request, { name: "partner-webhook", kind: "webhook_secret", secretRef: "JANUSLY_DEMO_WEBHOOK_SECRET" });

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
    expect(final.status, "webhook.send returns ok:false envelopes for placeholder billing endpoints; approval flow should still complete").toBe("succeeded");
    const dlq = await findDeadLetterForRun(request, runId);
    expect(dlq, "refund-triage-approval should not throw to DLQ").toBeNull();
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

  test("S2 multi-agent-decision reaches succeeded via the fallback contract", async ({ request }) => {
    const workflow = await loadTemplate(request, "multi-agent-decision");
    const payload = {
      proposal: "Replace our self-hosted Postgres with a managed RDS instance for the analytics database.",
    };
    const { runId } = await startRun(request, workflow, payload);

    await pollUntilWaitingOrTerminal(request, runId, "trigger");
    await resumeWebhook(request, runId, "trigger", payload);

    const snapshot = await pollUntilTerminal(request, runId, 45_000);
    expect(snapshot.status, "AI fallback contract should keep multi-agent-decision succeeded").toBe("succeeded");

    const dlq = await findDeadLetterForRun(request, runId);
    expect(dlq, "AI fallback contract should keep multi-agent off the DLQ").toBeNull();
  });

  test("S3 mcp-notion-summary template parses with the expected mcp_tool shape (runtime skipped)", async ({ request }) => {
    const workflow = (await loadTemplate(request, "mcp-notion-summary")) as { nodes: Array<{ id: string; type: string; config: Record<string, unknown> }> };
    const mcpNode = workflow.nodes.find((n) => n.type === "mcp_tool");
    expect(mcpNode, "mcp-notion-summary must contain an mcp_tool node").toBeTruthy();
    expect(mcpNode?.config.connectionAlias).toBe("notion-demo");
    expect(mcpNode?.config.toolName).toBe("pages.read");
  });

  test("S4 bulk-classify-loop runs end-to-end with a 3-customer batch", async ({ request }) => {
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
    expect(snapshot.status, "loop + AI fallback + noop email should complete the bulk demo").toBe("succeeded");

    const loopNode = snapshot.nodes.find((n) => n.nodeId === "normalize");
    expect(loopNode?.status).toBe("succeeded");
    const loopOutput = (loopNode?.stateJson?.output ?? {}) as { count?: number };
    expect(loopOutput.count, "loop should have iterated 3 times").toBe(3);

    const dlq = await findDeadLetterForRun(request, runId);
    expect(dlq).toBeNull();
  });
});
