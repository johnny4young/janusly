import { describe, expect, it } from "vitest";
import {
  RecoveryContractV1Schema,
  RecoveryCircuitBreakerSchema,
} from "./recovery-contract";

function contract(overrides: Record<string, unknown> = {}) {
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
        "run_timeline",
        "audit_trail",
        "validation_receipt",
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
    repairs: {
      allowed: ["retry", "config_patch", "rollback"],
    },
    validation: {
      minimumEvidenceLevel: "writes_skipped",
    },
    approval: {
      productionMutation: "required",
      permission: "recovery.write",
    },
    autonomyLevel: 3,
    verification: {
      kind: "generation_bound_terminal_success",
    },
    recurrence: {
      windowDays: 7,
    },
    ...overrides,
  };
}

describe("RecoveryContractV1Schema", () => {
  it("accepts a bounded approval-gated recovery contract", () => {
    expect(RecoveryContractV1Schema.safeParse(contract()).success).toBe(
      true,
    );
  });

  it("requires base evidence and validation receipts", () => {
    expect(
      RecoveryContractV1Schema.safeParse(
        contract({
          evidence: {
            required: ["failure_snapshot", "terminal_outcome"],
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      RecoveryContractV1Schema.safeParse(
        contract({
          evidence: {
            required: [
              "failure_snapshot",
              "audit_trail",
              "terminal_outcome",
            ],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects duplicate evidence, effects, and repair classes", () => {
    const duplicated = contract({
      evidence: {
        required: [
          "failure_snapshot",
          "failure_snapshot",
          "audit_trail",
          "validation_receipt",
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
        {
          nodeId: "charge",
          kind: "external_write",
          idempotency: "required",
          receipt: "runtime",
        },
      ],
      repairs: {
        allowed: ["retry", "retry"],
      },
    });
    expect(RecoveryContractV1Schema.safeParse(duplicated).success).toBe(
      false,
    );
  });

  it("fails closed for level 4 autonomy without strong evidence and idempotency", () => {
    expect(
      RecoveryContractV1Schema.safeParse(
        contract({
          autonomyLevel: 4,
          approval: {
            productionMutation: "autonomous_level_4",
            permission: "recovery.write",
          },
        }),
      ).success,
    ).toBe(false);

    expect(
      RecoveryContractV1Schema.safeParse(
        contract({
          autonomyLevel: 4,
          validation: {
            minimumEvidenceLevel: "provider_simulated",
          },
          approval: {
            productionMutation: "autonomous_level_4",
            permission: "recovery.write",
          },
          narrowAutonomy: {
            allowedRepairClasses: ["retry"],
            minimumPriorVerifiedRecoveries: 3,
            maxAffectedExecutions: 5,
            rollbackRequired: true,
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
              idempotency: "unavailable",
              receipt: "provider",
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts explicitly authorized level 4 only with effect evidence", () => {
    const parsed = RecoveryContractV1Schema.safeParse(
      contract({
        autonomyLevel: 4,
        validation: {
          minimumEvidenceLevel: "provider_simulated",
        },
        approval: {
          productionMutation: "autonomous_level_4",
          permission: "recovery.write",
        },
        narrowAutonomy: {
          allowedRepairClasses: ["retry"],
          minimumPriorVerifiedRecoveries: 3,
          maxAffectedExecutions: 5,
          rollbackRequired: true,
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
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects level 4 repair scope that exceeds the declared contract", () => {
    const parsed = RecoveryContractV1Schema.safeParse(
      contract({
        autonomyLevel: 4,
        validation: {
          minimumEvidenceLevel: "provider_simulated",
        },
        approval: {
          productionMutation: "autonomous_level_4",
          permission: "recovery.write",
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
        narrowAutonomy: {
          allowedRepairClasses: ["credential_rotation"],
          minimumPriorVerifiedRecoveries: 3,
          maxAffectedExecutions: 5,
          rollbackRequired: true,
        },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("keeps semantic recovery disabled until its evaluator ships", () => {
    const invalid = contract({
      failure: {
        technical: {
          terminalNodeFailure: true,
          stalledNode: true,
        },
        semantic: { mode: "enforce" },
      },
    });
    expect(RecoveryContractV1Schema.safeParse(invalid).success).toBe(
      false,
    );
  });
});

describe("RecoveryCircuitBreakerSchema", () => {
  it("accepts the persisted workflow forms and rejects hair triggers", () => {
    expect(RecoveryCircuitBreakerSchema.safeParse(false).success).toBe(
      true,
    );
    expect(RecoveryCircuitBreakerSchema.safeParse(5).success).toBe(true);
    expect(
      RecoveryCircuitBreakerSchema.safeParse({
        consecutiveFailures: 7,
      }).success,
    ).toBe(true);
    expect(
      RecoveryCircuitBreakerSchema.safeParse({
        consecutiveFailures: false,
      }).success,
    ).toBe(true);
    expect(RecoveryCircuitBreakerSchema.safeParse(1).success).toBe(
      false,
    );
  });
});
