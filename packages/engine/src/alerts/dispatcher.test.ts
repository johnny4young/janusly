import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tool-registry", () => ({
  executeTool: vi.fn(),
}));

import { executeTool } from "../tool-registry";
import { __dispatchOneChannelForTests, matchesPolicyFilter } from "./dispatcher";
import type { AlertPolicy } from "@janusly/data/src/alertPoliciesRepo";

beforeEach(() => {
  vi.mocked(executeTool).mockReset();
});

function makePolicy(overrides: Partial<AlertPolicy>): AlertPolicy {
  return {
    id: "p1",
    orgId: "org_1",
    name: "test",
    trigger: "dlq.entry_created",
    parameters: {},
    channels: [],
    cooldownSeconds: 900,
    enabled: true,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("matchesPolicyFilter", () => {
  it("dlq.entry_created with no filters matches every payload", () => {
    const policy = makePolicy({ parameters: {} });
    expect(matchesPolicyFilter(policy, {})).toBe(true);
    expect(matchesPolicyFilter(policy, { errorSignature: "anything", workflowId: "wf_x" })).toBe(true);
  });

  it("dlq.entry_created applies errorSignaturePattern glob", () => {
    const policy = makePolicy({
      parameters: { errorSignaturePattern: "Missing secret: *" },
    });
    expect(matchesPolicyFilter(policy, { errorSignature: "Missing secret: GITHUB_TOKEN" })).toBe(true);
    expect(matchesPolicyFilter(policy, { errorSignature: "HTTP 401 on http node" })).toBe(false);
  });

  it("dlq.entry_created applies workflowIds whitelist", () => {
    const policy = makePolicy({
      parameters: { workflowIds: ["wf_1", "wf_2"] },
    });
    expect(matchesPolicyFilter(policy, { workflowId: "wf_1" })).toBe(true);
    expect(matchesPolicyFilter(policy, { workflowId: "wf_other" })).toBe(false);
  });

  it("failure_cluster.threshold compares frequency to minFrequency", () => {
    const policy = makePolicy({
      trigger: "failure_cluster.threshold",
      parameters: { minFrequency: 5 },
    });
    expect(matchesPolicyFilter(policy, { frequency: 5 })).toBe(true);
    expect(matchesPolicyFilter(policy, { frequency: 10 })).toBe(true);
    expect(matchesPolicyFilter(policy, { frequency: 4 })).toBe(false);
  });

  it("budget.blocked filters by scope", () => {
    const policy = makePolicy({
      trigger: "budget.blocked",
      parameters: { scope: "workflow" },
    });
    expect(matchesPolicyFilter(policy, { scope: "workflow", workflowId: "wf_1" })).toBe(true);
    expect(matchesPolicyFilter(policy, { scope: "org" })).toBe(false);
  });

  it("limiter.degraded filters by bucket", () => {
    const policy = makePolicy({
      trigger: "limiter.degraded",
      parameters: { buckets: ["llm.completion"] },
    });
    expect(matchesPolicyFilter(policy, { bucket: "llm.completion" })).toBe(true);
    expect(matchesPolicyFilter(policy, { bucket: "tool.slack.post" })).toBe(false);
  });

  it("workflow.slo_breach metricNames requires overlap with payload metricNames", () => {
    const policy = makePolicy({
      trigger: "workflow.slo_breach",
      parameters: { metricNames: ["successRate"] },
    });
    expect(matchesPolicyFilter(policy, { workflowId: "wf_1", metricNames: ["successRate"] })).toBe(true);
    expect(matchesPolicyFilter(policy, { workflowId: "wf_1", metricNames: ["p95"] })).toBe(false);
    expect(
      matchesPolicyFilter(policy, { workflowId: "wf_1", metricNames: ["successRate", "p95"] }),
    ).toBe(true);
  });

  it("approval.stalled filters by workflowIds", () => {
    const policy = makePolicy({
      trigger: "approval.stalled",
      parameters: { stalledMinutes: 30, workflowIds: ["wf_critical"] },
    });
    expect(matchesPolicyFilter(policy, { workflowId: "wf_critical", stalledMinutes: 30 })).toBe(true);
    expect(matchesPolicyFilter(policy, { workflowId: "wf_unrelated", stalledMinutes: 30 })).toBe(false);
  });

  it("approval.stalled compares payload age to the policy threshold", () => {
    const policy = makePolicy({
      trigger: "approval.stalled",
      parameters: { stalledMinutes: 30 },
    });
    expect(matchesPolicyFilter(policy, { stalledMinutes: 30 })).toBe(true);
    expect(matchesPolicyFilter(policy, { stalledMinutes: 45 })).toBe(true);
    expect(matchesPolicyFilter(policy, { stalledMinutes: 29 })).toBe(false);
  });

  it("failure_cluster.threshold filters by its declared window", () => {
    const policy = makePolicy({
      trigger: "failure_cluster.threshold",
      parameters: { minFrequency: 5, windowDays: 7 },
    });
    expect(matchesPolicyFilter(policy, { frequency: 5, windowDays: 7 })).toBe(true);
    expect(matchesPolicyFilter(policy, { frequency: 5, windowDays: 30 })).toBe(false);
  });
});

describe("__dispatchOneChannelForTests", () => {
  it("passes orgId through to tenant-scoped integration tools", async () => {
    vi.mocked(executeTool).mockResolvedValueOnce({ ok: true, latencyMs: 12 });
    const result = await __dispatchOneChannelForTests({
      orgId: "org-1",
      channel: { destination: "slack", credentialName: "Ops Slack", params: {} },
      subject: "Incident",
      markdown: "Incident body",
      structured: {},
    });

    expect(result.ok).toBe(true);
    expect(executeTool).toHaveBeenCalledWith(
      "slack.post",
      { credential: "Ops Slack", text: "Incident body" },
      {},
      { orgId: "org-1" },
    );
  });
});
