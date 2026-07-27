import { describe, expect, it } from "vitest";
import {
  RecoveryContractV1Schema,
  RecoveryContractV2Schema,
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

describe("RecoveryContractV2Schema", () => {
  function contractV2(overrides: Record<string, unknown> = {}) {
    const base = contract();
    return {
      ...base,
      version: "2",
      failure: {
        technical: base.failure.technical,
        semantic: {
          mode: "deterministic",
          detectors: [
            {
              id: "acceptable-answer",
              sourceNodeId: "answer",
              kind: "expression",
              passWhen:
                'context.answer.output.mode === "ai"',
              action: "quarantine",
              message: "The model must produce a reviewed answer",
            },
          ],
          evaluationFixtures: [
            {
              id: "accepts-ai",
              sourceNodeId: "answer",
              output: { mode: "ai" },
              expected: "pass",
            },
            {
              id: "rejects-fallback",
              sourceNodeId: "answer",
              output: { mode: "fallback" },
              expected: "violation",
            },
          ],
        },
      },
      ...overrides,
    };
  }

  it("accepts deterministic expression and schema detectors", () => {
    expect(
      RecoveryContractV2Schema.safeParse(contractV2()).success,
    ).toBe(true);
    expect(
      RecoveryContractV2Schema.safeParse(
        contractV2({
          failure: {
            technical: {
              terminalNodeFailure: true,
              stalledNode: true,
            },
            semantic: {
              mode: "deterministic",
              detectors: [
                {
                  id: "typed-answer",
                  sourceNodeId: "answer",
                  kind: "schema",
                  schema: {
                    type: "object",
                    required: ["answer"],
                    properties: {
                      answer: { type: "string" },
                    },
                  },
                  action: "observe",
                  message: "Answer must be a string",
                },
              ],
              evaluationFixtures: [
                {
                  id: "typed-answer-pass",
                  sourceNodeId: "answer",
                  output: { answer: "ready" },
                  expected: "pass",
                },
                {
                  id: "typed-answer-fail",
                  sourceNodeId: "answer",
                  output: {},
                  expected: "violation",
                },
              ],
            },
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("requires a bounded evaluation dataset with at least two fixtures", () => {
    const candidate = contractV2();
    expect(
      RecoveryContractV2Schema.safeParse({
        ...candidate,
        failure: {
          ...candidate.failure,
          semantic: {
            ...candidate.failure.semantic,
            evaluationFixtures: [
              candidate.failure.semantic.evaluationFixtures[0],
            ],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate detector and fixture identities", () => {
    const candidate = contractV2();
    const failure = candidate.failure;
    expect(
      RecoveryContractV2Schema.safeParse({
        ...candidate,
        failure: {
          ...failure,
          semantic: {
            ...failure.semantic,
            detectors: [
              failure.semantic.detectors[0],
              failure.semantic.detectors[0],
            ],
            evaluationFixtures: [
              failure.semantic.evaluationFixtures[0],
              failure.semantic.evaluationFixtures[0],
            ],
          },
        },
      }).success,
    ).toBe(false);
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
