import { describe, expect, it } from "vitest";

import { buildDedupeKey } from "./dedupe-key";

describe("buildDedupeKey", () => {
  it("dlq.entry_created → sig:<errorSignature>", () => {
    expect(
      buildDedupeKey("dlq.entry_created", { errorSignature: "Missing secret: GITHUB_TOKEN" }),
    ).toBe("sig:Missing secret: GITHUB_TOKEN");
  });

  it("dlq.entry_created falls back to no-key when signature is absent", () => {
    expect(buildDedupeKey("dlq.entry_created", {})).toBe("__none__");
  });

  it("failure_cluster.threshold → cluster:<signature>", () => {
    expect(
      buildDedupeKey("failure_cluster.threshold", { signature: "HTTP 401 on http node", frequency: 5 }),
    ).toBe("cluster:HTTP 401 on http node");
  });

  it("budget.blocked includes scope + workflowId when present", () => {
    expect(buildDedupeKey("budget.blocked", { scope: "workflow", workflowId: "wf_1" })).toBe(
      "budget:workflow:wf_1",
    );
    expect(buildDedupeKey("budget.blocked", { scope: "org" })).toBe("budget:org");
    expect(buildDedupeKey("budget.blocked", {})).toBe("budget:org");
  });

  it("limiter.degraded → bucket:<bucket>", () => {
    expect(buildDedupeKey("limiter.degraded", { bucket: "llm.completion" })).toBe(
      "bucket:llm.completion",
    );
  });

  it("workflow.slo_breach sorts metric names for stability", () => {
    expect(
      buildDedupeKey("workflow.slo_breach", { workflowId: "wf_1", metricNames: ["p95", "successRate"] }),
    ).toBe("slo:wf_1:p95,successRate");
    expect(
      buildDedupeKey("workflow.slo_breach", { workflowId: "wf_1", metricNames: ["successRate", "p95"] }),
    ).toBe("slo:wf_1:p95,successRate");
    expect(buildDedupeKey("workflow.slo_breach", { workflowId: "wf_1" })).toBe("slo:wf_1");
  });

  it("approval.stalled requires both runId and nodeId", () => {
    expect(
      buildDedupeKey("approval.stalled", { runId: "run_1", nodeId: "approval-1" }),
    ).toBe("approval:run_1:approval-1");
    expect(buildDedupeKey("approval.stalled", { runId: "run_1" })).toBe("__none__");
  });

  it("recovery_item.created keys by deadLetterId so multi-fire from the same DLQ collapses", () => {
    expect(
      buildDedupeKey("recovery_item.created", { deadLetterId: "dl_123" }),
    ).toBe("item:dl_123");
    expect(buildDedupeKey("recovery_item.created", {})).toBe("__none__");
  });

  it("recovery_item.sla_breached keys by itemId (items can re-breach after reopen)", () => {
    expect(
      buildDedupeKey("recovery_item.sla_breached", { itemId: "ri_99" }),
    ).toBe("sla:ri_99");
    expect(buildDedupeKey("recovery_item.sla_breached", {})).toBe("__none__");
  });
});
