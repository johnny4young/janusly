import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoHealingRun } from "@janusly/data";

const {
  listContextsMock,
  queryRecoveriesMock,
} = vi.hoisted(() => ({
  listContextsMock: vi.fn(),
  queryRecoveriesMock: vi.fn(),
}));

vi.mock("@janusly/data", () => ({
  listAutoHealingAutonomyContexts: listContextsMock,
  queryVerifiedAutoHealingRecoveries: queryRecoveriesMock,
}));

import {
  assessAutoHealingAutonomyRows,
  buildAutoHealingAutonomyAssessment,
} from "./auto-healing-autonomy";

const contract = {
  version: "1",
  failure: {
    technical: {
      terminalNodeFailure: true,
      stalledNode: true,
    },
    semantic: { mode: "disabled" },
  },
  evidence: {
    required: [
      "failure_snapshot",
      "audit_trail",
      "validation_receipt",
      "effect_receipt",
      "terminal_outcome",
    ],
  },
  effects: [{
    nodeId: "charge",
    kind: "financial_mutation",
    idempotency: "required",
    receipt: "provider",
  }],
  repairs: { allowed: ["retry", "config_patch"] },
  validation: { minimumEvidenceLevel: "provider_simulated" },
  approval: {
    productionMutation: "autonomous_level_4",
    permission: "recovery.write",
  },
  autonomyLevel: 4,
  narrowAutonomy: {
    allowedRepairClasses: ["retry"],
    minimumPriorVerifiedRecoveries: 2,
    maxAffectedExecutions: 1,
    rollbackRequired: true,
  },
  verification: { kind: "generation_bound_terminal_success" },
  recurrence: { windowDays: 7 },
} as const;

const original = {
  id: "billing",
  name: "Billing",
  recovery: { contract },
  nodes: [{
    id: "charge",
    type: "http",
    config: {
      url: "https://payments.example/charge",
      retry: { maxAttempts: 1 },
    },
  }],
  edges: [],
};

const candidate = {
  ...original,
  nodes: [{
    ...original.nodes[0],
    config: {
      ...original.nodes[0].config,
      retry: { maxAttempts: 3 },
    },
  }],
};

function row(
  overrides: Partial<AutoHealingRun> = {},
): AutoHealingRun {
  return {
    id: "heal-1",
    orgId: "org-1",
    deadLetterId: "dlq-1",
    signature: "sig-1",
    status: "validated",
    proposedPatchJson: candidate,
    approachLabel: "add_retry",
    confidence: 90,
    validationRunId: "validation-1",
    validationSignature: null,
    validationEvidenceLevel: "provider_simulated",
    decisionActor: null,
    publicationReceipt: null,
    publicationRepairAfter: null,
    publicationAttempts: 0,
    declineReason: null,
    loopAttemptCount: 1,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

beforeEach(() => {
  listContextsMock.mockReset().mockResolvedValue([{
    deadLetterId: "dlq-1",
    workflowJson: original,
    nodeId: "charge",
    errorJson: { code: "provider_timeout" },
  }]);
  queryRecoveriesMock.mockReset().mockResolvedValue([{
    signature: "sig-1",
    count: 2,
  }]);
});

describe("assessAutoHealingAutonomyRows", () => {
  it("projects one server-authoritative assessment without per-row reads", async () => {
    const result = await assessAutoHealingAutonomyRows(
      "org-1",
      [row(), row({ id: "heal-2" })],
    );

    expect(result).toHaveLength(2);
    expect(result.every((item) => item.autonomyAssessment.eligible)).toBe(
      true,
    );
    expect(listContextsMock).toHaveBeenCalledOnce();
    expect(queryRecoveriesMock).toHaveBeenCalledOnce();
  });

  it("fails closed when the DLQ context no longer exists", async () => {
    listContextsMock.mockResolvedValueOnce([]);

    const [result] = await assessAutoHealingAutonomyRows(
      "org-1",
      [row()],
    );

    expect(result?.autonomyAssessment.eligible).toBe(false);
    expect(
      result?.autonomyAssessment.factors.find(
        (factor) => factor.id === "policy",
      ),
    ).toMatchObject({ passed: false, reason: "policy_unavailable" });
  });
});

describe("buildAutoHealingAutonomyAssessment", () => {
  it("resolves a stalled-node failure from persisted error evidence", () => {
    const result = buildAutoHealingAutonomyAssessment({
      row: row(),
      context: {
        deadLetterId: "dlq-1",
        workflowJson: original,
        nodeId: "charge",
        errorJson: { code: "worker_stalled" },
      },
      priorVerifiedRecoveries: 2,
    });

    expect(result.failure).toBe("stalled_node");
    expect(result.eligible).toBe(true);
  });
});
