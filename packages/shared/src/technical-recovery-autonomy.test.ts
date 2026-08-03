import { describe, expect, it } from "vitest";

import type { RecoveryContractV1 } from "./recovery-contract";
import {
  classifyTechnicalRecoveryRepair,
  evaluateTechnicalRecoveryAutonomy,
} from "./technical-recovery-autonomy";

function contract(
  overrides: Partial<RecoveryContractV1> = {},
): RecoveryContractV1 {
  return {
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
    effects: [
      {
        nodeId: "charge",
        kind: "financial_mutation",
        idempotency: "required",
        receipt: "provider",
      },
    ],
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
    verification: {
      kind: "generation_bound_terminal_success",
    },
    recurrence: { windowDays: 7 },
    ...overrides,
  };
}

const original = {
  nodes: [
    {
      id: "charge",
      type: "http",
      config: {
        url: "https://payments.example/charge",
        retry: { maxAttempts: 1 },
      },
    },
  ],
  edges: [],
};

describe("classifyTechnicalRecoveryRepair", () => {
  it("classifies a failing-node retry-only change", () => {
    expect(
      classifyTechnicalRecoveryRepair({
        original,
        candidate: {
          ...original,
          nodes: [
            {
              ...original.nodes[0]!,
              config: {
                ...original.nodes[0]!.config,
                retry: { maxAttempts: 3 },
              },
            },
          ],
        },
        failingNodeId: "charge",
      }),
    ).toBe("retry");
  });

  it("classifies a bounded failing-node config change", () => {
    expect(
      classifyTechnicalRecoveryRepair({
        original,
        candidate: {
          ...original,
          nodes: [
            {
              ...original.nodes[0]!,
              config: {
                ...original.nodes[0]!.config,
                timeoutMs: 30_000,
              },
            },
          ],
        },
        failingNodeId: "charge",
      }),
    ).toBe("config_patch");
  });

  it("classifies only an approval insertion as structural", () => {
    expect(
      classifyTechnicalRecoveryRepair({
        original: {
          ...original,
          nodes: [
            { id: "prepare", type: "noop", config: {} },
            ...original.nodes,
          ],
          edges: [{ from: "prepare", to: "charge" }],
        },
        candidate: {
          ...original,
          nodes: [
            { id: "prepare", type: "noop", config: {} },
            ...original.nodes,
            {
              id: "approve",
              type: "approval",
              config: { message: "Approve" },
            },
          ],
          edges: [
            { from: "prepare", to: "approve" },
            { from: "approve", to: "charge" },
          ],
        },
        failingNodeId: "charge",
      }),
    ).toBe("structural_patch");
  });

  it("rejects an approval insertion that also rewires unrelated graph edges", () => {
    expect(
      classifyTechnicalRecoveryRepair({
        original: {
          ...original,
          nodes: [
            { id: "prepare", type: "noop", config: {} },
            ...original.nodes,
            { id: "notify", type: "noop", config: {} },
          ],
          edges: [
            { from: "prepare", to: "charge" },
            { from: "charge", to: "notify" },
          ],
        },
        candidate: {
          ...original,
          nodes: [
            { id: "prepare", type: "noop", config: {} },
            ...original.nodes,
            { id: "notify", type: "noop", config: {} },
            {
              id: "approve",
              type: "approval",
              config: { message: "Approve" },
            },
          ],
          edges: [
            { from: "prepare", to: "approve" },
            { from: "approve", to: "charge" },
            { from: "prepare", to: "notify" },
          ],
        },
        failingNodeId: "charge",
      }),
    ).toBeNull();
  });

  it("rejects a repair that changes operator-owned recovery policy", () => {
    expect(
      classifyTechnicalRecoveryRepair({
        original: {
          ...original,
          recovery: { circuitBreaker: 3 },
        },
        candidate: {
          ...original,
          recovery: { circuitBreaker: 5 },
          nodes: [
            {
              ...original.nodes[0]!,
              config: {
                ...original.nodes[0]!.config,
                retry: { maxAttempts: 3 },
              },
            },
          ],
        },
        failingNodeId: "charge",
      }),
    ).toBeNull();
  });

  it("rejects changes outside the failing node", () => {
    expect(
      classifyTechnicalRecoveryRepair({
        original: {
          ...original,
          nodes: [
            ...original.nodes,
            { id: "notify", type: "noop", config: {} },
          ],
        },
        candidate: {
          ...original,
          nodes: [
            original.nodes[0]!,
            {
              id: "notify",
              type: "noop",
              config: { changed: true },
            },
          ],
        },
        failingNodeId: "charge",
      }),
    ).toBeNull();
  });
});

describe("evaluateTechnicalRecoveryAutonomy", () => {
  it("allows a bounded repair only when every persisted fact passes", () => {
    const assessment = evaluateTechnicalRecoveryAutonomy({
      contract: contract(),
      failure: "terminal_node_failure",
      repairClass: "retry",
      validationEvidenceLevel: "provider_simulated",
      priorVerifiedRecoveries: 2,
      affectedExecutions: 1,
      rollbackReady: true,
    });

    expect(assessment.eligible).toBe(true);
    expect(assessment.factors.every((item) => item.passed)).toBe(true);
  });

  it("fails closed when a failure override lowers the technical policy", () => {
    const base = contract();
    const assessment = evaluateTechnicalRecoveryAutonomy({
      contract: {
        ...base,
        failure: {
          ...base.failure,
          technical: {
            ...base.failure.technical,
            autonomy: { terminalNodeFailure: 3 },
          },
        },
      },
      failure: "terminal_node_failure",
      repairClass: "retry",
      validationEvidenceLevel: "provider_simulated",
      priorVerifiedRecoveries: 2,
      affectedExecutions: 1,
      rollbackReady: true,
    });

    expect(assessment.eligible).toBe(false);
    expect(
      assessment.factors.find((item) => item.id === "policy"),
    ).toMatchObject({
      passed: false,
      reason: "autonomy_level_below_4",
    });
  });

  it("blocks write-skipped validation and insufficient prior outcomes", () => {
    const assessment = evaluateTechnicalRecoveryAutonomy({
      contract: contract(),
      failure: "terminal_node_failure",
      repairClass: "retry",
      validationEvidenceLevel: "writes_skipped",
      priorVerifiedRecoveries: 1,
      affectedExecutions: 1,
      rollbackReady: true,
    });

    expect(assessment.eligible).toBe(false);
    expect(
      assessment.factors.filter((item) => !item.passed).map(
        (item) => item.id,
      ),
    ).toEqual(["validation_evidence", "prior_recoveries"]);
  });

  it("blocks a repair outside the narrow allowlist", () => {
    const assessment = evaluateTechnicalRecoveryAutonomy({
      contract: contract(),
      failure: "terminal_node_failure",
      repairClass: "config_patch",
      validationEvidenceLevel: "provider_simulated",
      priorVerifiedRecoveries: 3,
      affectedExecutions: 1,
      rollbackReady: true,
    });

    expect(assessment.eligible).toBe(false);
    expect(
      assessment.factors.find((item) => item.id === "repair_scope"),
    ).toMatchObject({
      passed: false,
      reason: "repair_not_allowlisted",
    });
  });
});
