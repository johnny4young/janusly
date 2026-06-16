import { describe, expect, it } from "vitest";

import { collectScheduleAnomalyWorkflowTargets } from "./scanner";

describe("collectScheduleAnomalyWorkflowTargets", () => {
  it("prioritizes workflowIds filters and leaves the general scan off when every policy is targeted", () => {
    expect(
      collectScheduleAnomalyWorkflowTargets([
        { parameters: { workflowIds: ["wf_critical", "wf_nightly"] } },
        { parameters: { workflowIds: ["wf_critical", "wf_weekly"] } },
      ]),
    ).toEqual({
      includeOtherScheduledWorkflows: false,
      priorityWorkflowIds: ["wf_critical", "wf_nightly", "wf_weekly"],
    });
  });

  it("keeps the general scan on when any policy has no workflowIds allowlist", () => {
    expect(
      collectScheduleAnomalyWorkflowTargets([
        { parameters: { workflowIds: ["wf_critical"] } },
        { parameters: {} },
      ]),
    ).toEqual({
      includeOtherScheduledWorkflows: true,
      priorityWorkflowIds: ["wf_critical"],
    });
  });
});
