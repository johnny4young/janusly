import { describe, expect, it } from "vitest";

import type { Workflow } from "@janusly/shared";

import {
  haveCompatibleWorkflowRolloutTriggers,
  workflowRolloutBucket,
} from "./workflowRolloutsRepo";

function workflow(nodes: Workflow["nodes"]): Workflow {
  return { dslVersion: "1.0", id: "workflow-1", name: "Workflow", nodes, edges: [] };
}

describe("workflow rollout assignment", () => {
  it("returns a stable bounded bucket and changes its rollout namespace", () => {
    const first = workflowRolloutBucket("rollout-1", "event-1");
    expect(first).toBe(87);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
    expect(workflowRolloutBucket("rollout-1", "event-1")).toBe(first);
    expect(workflowRolloutBucket("rollout-2", "event-1")).not.toBe(first);
  });

  it("accepts semantically equal external trigger configs despite key order", () => {
    const baseline = workflow([
      { id: "mail", type: "email_received", config: { aliasKey: "ops", enabled: true } },
    ]);
    const canary = workflow([
      { id: "mail", type: "email_received", config: { enabled: true, aliasKey: "ops" } },
      { id: "work", type: "noop", config: { changed: true } },
    ]);
    expect(haveCompatibleWorkflowRolloutTriggers(baseline, canary)).toBe(true);
  });

  it("rejects trigger id, type, or config drift between deployment variants", () => {
    const baseline = workflow([
      { id: "mail", type: "email_received", config: { aliasKey: "ops" } },
    ]);
    expect(haveCompatibleWorkflowRolloutTriggers(
      baseline,
      workflow([{ id: "mail-v2", type: "email_received", config: { aliasKey: "ops" } }]),
    )).toBe(false);
    expect(haveCompatibleWorkflowRolloutTriggers(
      baseline,
      workflow([{ id: "mail", type: "email_received", config: { aliasKey: "billing" } }]),
    )).toBe(false);
  });
});
