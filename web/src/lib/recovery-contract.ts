/**
 * Versioned, operator-owned recovery policy attached to a workflow snapshot.
 *
 * The contract is declarative: it names the failure/effect/repair boundaries
 * that later recovery stages must honor. Runtime-specific persistence and I/O
 * stay in the engine/data packages; this module is pure and browser-safe.
 */

import * as z from "zod/mini";
import {
  supportsAutonomousRecovery,
  ValidationEvidenceLevelSchema,
} from "./validation-evidence";
import { WorkflowInputSchema } from "./value-schema";

const boundedTrimmedString = (minimum: number, maximum: number) =>
  z.string().check(z.trim(), z.minLength(minimum), z.maxLength(maximum));

const boundedInt = (minimum: number, maximum: number) =>
  z.int().check(z.minimum(minimum), z.maximum(maximum));

export const RECOVERY_CONTRACT_VERSION = "1" as const;
export const RECOVERY_CONTRACT_V2_VERSION = "2" as const;

export const RecoveryAutonomyLevelSchema = /* @__PURE__ */ z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type RecoveryAutonomyLevel = z.infer<
  typeof RecoveryAutonomyLevelSchema
>;

export const RECOVERY_EVIDENCE_KINDS = [
  "failure_snapshot",
  "run_timeline",
  "audit_trail",
  "validation_receipt",
  "effect_receipt",
  "terminal_outcome",
] as const;
export const RecoveryEvidenceKindSchema = /* @__PURE__ */ z.enum(
  RECOVERY_EVIDENCE_KINDS,
);
export type RecoveryEvidenceKind = z.infer<
  typeof RecoveryEvidenceKindSchema
>;

export const RECOVERY_EFFECT_KINDS = [
  "external_write",
  "financial_mutation",
  "notification",
  "human_action",
] as const;
export const RecoveryEffectKindSchema = /* @__PURE__ */ z.enum(RECOVERY_EFFECT_KINDS);

export const RECOVERY_EFFECT_IDEMPOTENCY = [
  "required",
  "provider_guaranteed",
  "unavailable",
] as const;
export const RecoveryEffectIdempotencySchema = /* @__PURE__ */ z.enum(
  RECOVERY_EFFECT_IDEMPOTENCY,
);

export const RECOVERY_EFFECT_RECEIPTS = [
  "runtime",
  "provider",
  "manual",
] as const;
export const RecoveryEffectReceiptSchema = /* @__PURE__ */ z.enum(
  RECOVERY_EFFECT_RECEIPTS,
);

export const RecoveryEffectV1Schema = /* @__PURE__ */ z.strictObject({
  nodeId: boundedTrimmedString(1, 200),
  kind: RecoveryEffectKindSchema,
  idempotency: RecoveryEffectIdempotencySchema,
  receipt: RecoveryEffectReceiptSchema,
});

export const RECOVERY_REPAIR_CLASSES = [
  "retry",
  "config_patch",
  "structural_patch",
  "rollback",
  "credential_rotation",
  "upstream_wait",
] as const;
export const RecoveryRepairClassSchema = /* @__PURE__ */ z.enum(
  RECOVERY_REPAIR_CLASSES,
);
export type RecoveryRepairClass = z.infer<
  typeof RecoveryRepairClassSchema
>;

const REQUIRED_BASE_EVIDENCE: readonly RecoveryEvidenceKind[] = [
  "failure_snapshot",
  "audit_trail",
  "terminal_outcome",
];

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

const RecoveryTechnicalFailureSchema = /* @__PURE__ */ z.strictObject({
  terminalNodeFailure: z.literal(true),
  stalledNode: z.boolean(),
  autonomy: z.optional(
    z.strictObject({
      terminalNodeFailure: z.optional(RecoveryAutonomyLevelSchema),
      stalledNode: z.optional(RecoveryAutonomyLevelSchema),
    }),
  ),
});

const RecoveryContractCommonSchema = /* @__PURE__ */ z.strictObject({
    evidence: z.strictObject({
      required: z
        .array(RecoveryEvidenceKindSchema)
        .check(z.minLength(1), z.maxLength(RECOVERY_EVIDENCE_KINDS.length)),
    }),
    effects: z.array(RecoveryEffectV1Schema).check(z.maxLength(100)),
    repairs: z.strictObject({
      allowed: z
        .array(RecoveryRepairClassSchema)
        .check(z.minLength(1), z.maxLength(RECOVERY_REPAIR_CLASSES.length)),
    }),
    validation: z.strictObject({
      minimumEvidenceLevel: ValidationEvidenceLevelSchema,
    }),
    approval: z.strictObject({
      productionMutation: z.enum([
        "required",
        "autonomous_level_4",
      ]),
      permission: z.literal("recovery.write"),
    }),
    autonomyLevel: RecoveryAutonomyLevelSchema,
    narrowAutonomy: z.optional(
      z.strictObject({
        allowedRepairClasses: z
          .array(RecoveryRepairClassSchema)
          .check(z.minLength(1), z.maxLength(RECOVERY_REPAIR_CLASSES.length)),
        minimumPriorVerifiedRecoveries: boundedInt(1, 1_000),
        maxAffectedExecutions: boundedInt(1, 100),
        rollbackRequired: z.literal(true),
      }),
    ),
    verification: z.strictObject({
      kind: z.literal("generation_bound_terminal_success"),
    }),
    recurrence: z.strictObject({
      windowDays: boundedInt(1, 30),
    }),
  });

type RecoveryContractCommon = z.infer<
  typeof RecoveryContractCommonSchema
>;
type RecoveryContractWithTechnicalFailure =
  RecoveryContractCommon & {
    failure: {
      technical: z.infer<typeof RecoveryTechnicalFailureSchema>;
    };
  };

function validateRecoveryContractCommon(
  contract: RecoveryContractWithTechnicalFailure,
  context: z.core.$RefinementCtx<RecoveryContractWithTechnicalFailure>,
): void {
  const technicalAutonomy = contract.failure.technical.autonomy;
  for (const [failureClass, level] of Object.entries(
    technicalAutonomy ?? {},
  )) {
    if (
      level !== undefined &&
      level > contract.autonomyLevel
    ) {
      context.addIssue({
        code: "custom",
        path: [
          "failure",
          "technical",
          "autonomy",
          failureClass,
        ],
        message:
          "A failure-specific autonomy level cannot exceed the workflow recovery level",
      });
    }
  }
  if (hasDuplicates(contract.evidence.required)) {
    context.addIssue({
      code: "custom",
      path: ["evidence", "required"],
      message: "Recovery evidence kinds must be unique",
    });
  }
  for (const required of REQUIRED_BASE_EVIDENCE) {
    if (!contract.evidence.required.includes(required)) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "required"],
        message: `Recovery contract must retain ${required}`,
      });
    }
  }
  if (hasDuplicates(contract.effects.map((effect) => effect.nodeId))) {
    context.addIssue({
      code: "custom",
      path: ["effects"],
      message: "A workflow node may define only one recovery effect",
    });
  }
  if (hasDuplicates(contract.repairs.allowed)) {
    context.addIssue({
      code: "custom",
      path: ["repairs", "allowed"],
      message: "Recovery repair classes must be unique",
    });
  }
  if (
    contract.validation.minimumEvidenceLevel !== "static" &&
    !contract.evidence.required.includes("validation_receipt")
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidence", "required"],
      message:
        "Validation evidence above static requires validation_receipt retention",
    });
  }
  if (
    supportsAutonomousRecovery(contract.validation.minimumEvidenceLevel) &&
    !contract.evidence.required.includes("effect_receipt")
  ) {
    context.addIssue({
      code: "custom",
      path: ["evidence", "required"],
      message:
        "Provider-simulated or live-canary validation requires effect_receipt retention",
    });
  }
  if (contract.autonomyLevel === 4) {
    if (
      !supportsAutonomousRecovery(
        contract.validation.minimumEvidenceLevel,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["validation", "minimumEvidenceLevel"],
        message:
          "Level 4 autonomy requires provider_simulated or live_canary evidence",
      });
    }
    if (
      contract.approval.productionMutation !==
      "autonomous_level_4"
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval", "productionMutation"],
        message:
          "Level 4 autonomy requires an explicit autonomous_level_4 mutation policy",
      });
    }
    if (!contract.narrowAutonomy) {
      context.addIssue({
        code: "custom",
        path: ["narrowAutonomy"],
        message:
          "Level 4 autonomy requires prior-evidence, blast-radius, and rollback bounds",
      });
    } else {
      if (hasDuplicates(contract.narrowAutonomy.allowedRepairClasses)) {
        context.addIssue({
          code: "custom",
          path: ["narrowAutonomy", "allowedRepairClasses"],
          message:
            "Narrow-autonomy repair classes must be unique",
        });
      }
      for (
        const [index, repair] of contract.narrowAutonomy
          .allowedRepairClasses.entries()
      ) {
        if (!contract.repairs.allowed.includes(repair)) {
          context.addIssue({
            code: "custom",
            path: [
              "narrowAutonomy",
              "allowedRepairClasses",
              index,
            ],
            message:
              "Narrow-autonomy repair classes must be allowed by the recovery contract",
          });
        }
      }
    }
    for (const [index, effect] of contract.effects.entries()) {
      if (effect.idempotency === "unavailable") {
        context.addIssue({
          code: "custom",
          path: ["effects", index, "idempotency"],
          message:
            "Level 4 autonomy cannot include an effect without idempotency",
        });
      }
      if (effect.receipt === "manual") {
        context.addIssue({
          code: "custom",
          path: ["effects", index, "receipt"],
          message:
            "Level 4 autonomy cannot depend on a manual effect receipt",
        });
      }
    }
  } else {
    if (
      contract.approval.productionMutation !== "required"
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval", "productionMutation"],
        message:
          "Autonomous production mutation is valid only at autonomy level 4",
      });
    }
    if (contract.narrowAutonomy) {
      context.addIssue({
        code: "custom",
        path: ["narrowAutonomy"],
        message:
          "Narrow-autonomy bounds are valid only at autonomy level 4",
      });
    }
  }
}

/**
 * Recovery Contract v1 is deliberately honest about semantic recovery:
 * technical failure handling is available, while semantic detection remains
 * disabled on historical snapshots.
 */
export const RecoveryContractV1Schema = /* @__PURE__ */ z.strictObject({
    version: z.literal(RECOVERY_CONTRACT_VERSION),
    failure: z.strictObject({
        technical: RecoveryTechnicalFailureSchema,
        semantic: z.strictObject({
          mode: z.literal("disabled"),
        }),
      }),
    ...RecoveryContractCommonSchema.shape,
  }).check(z.superRefine(validateRecoveryContractCommon));

export type RecoveryContractV1 = z.infer<
  typeof RecoveryContractV1Schema
>;

export const RecoverySemanticExpressionDetectorV2Schema = /* @__PURE__ */ z.strictObject({
    id: boundedTrimmedString(1, 200),
    sourceNodeId: boundedTrimmedString(1, 200),
    kind: z.literal("expression"),
    passWhen: boundedTrimmedString(1, 2_000),
    action: z.enum(["observe", "quarantine"]),
    message: boundedTrimmedString(1, 500),
    autonomyLevel: z.optional(RecoveryAutonomyLevelSchema),
  });

export const RecoverySemanticSchemaDetectorV2Schema = /* @__PURE__ */ z.strictObject({
    id: boundedTrimmedString(1, 200),
    sourceNodeId: boundedTrimmedString(1, 200),
    kind: z.literal("schema"),
    schema: WorkflowInputSchema,
    action: z.enum(["observe", "quarantine"]),
    message: boundedTrimmedString(1, 500),
    autonomyLevel: z.optional(RecoveryAutonomyLevelSchema),
  });

export const RecoverySemanticDetectorV2Schema = /* @__PURE__ */ z.discriminatedUnion(
  "kind",
  [
    RecoverySemanticExpressionDetectorV2Schema,
    RecoverySemanticSchemaDetectorV2Schema,
  ],
);

export const RecoverySemanticEvaluationFixtureV2Schema = /* @__PURE__ */ z.strictObject({
    id: boundedTrimmedString(1, 200),
    sourceNodeId: boundedTrimmedString(1, 200),
    output: z.unknown().check(z.refine((value) => value !== undefined, {
      message: "Fixture output is required",
    })),
    context: z.optional(z.record(z.string(), z.unknown())),
    expected: z.enum(["pass", "violation"]),
  });

export const RecoveryContractV2Schema = /* @__PURE__ */ z.strictObject({
    version: z.literal(RECOVERY_CONTRACT_V2_VERSION),
    failure: z.strictObject({
        technical: RecoveryTechnicalFailureSchema,
        semantic: z.strictObject({
            mode: z.literal("deterministic"),
            detectors: z
              .array(RecoverySemanticDetectorV2Schema)
              .check(z.minLength(1), z.maxLength(50)),
            evaluationFixtures: z
              .array(RecoverySemanticEvaluationFixtureV2Schema)
              .check(z.minLength(2), z.maxLength(50))
          }),
      }),
    ...RecoveryContractCommonSchema.shape,
  }).check(z.superRefine((contract, context) => {
    validateRecoveryContractCommon(contract, context);
    if (
      hasDuplicates(
        contract.failure.semantic.detectors.map(
          (detector) => detector.id,
        ),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure", "semantic", "detectors"],
        message: "Semantic detector ids must be unique",
      });
    }
    for (const [index, detector] of contract.failure.semantic.detectors.entries()) {
      if (
        detector.autonomyLevel !== undefined &&
        detector.autonomyLevel > contract.autonomyLevel
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "failure",
            "semantic",
            "detectors",
            index,
            "autonomyLevel",
          ],
          message:
            "A failure-specific autonomy level cannot exceed the workflow recovery level",
        });
      }
    }
    if (
      hasDuplicates(
        (contract.failure.semantic.evaluationFixtures ?? []).map(
          (fixture) => fixture.id,
        ),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure", "semantic", "evaluationFixtures"],
        message: "Semantic evaluation fixture ids must be unique",
      });
    }
  }));

export const RecoveryContractSchema = /* @__PURE__ */ z.discriminatedUnion("version", [
  RecoveryContractV1Schema,
  RecoveryContractV2Schema,
]);
export type RecoveryContract = z.infer<
  typeof RecoveryContractSchema
>;

export const RECOVERY_CIRCUIT_BREAKER_MIN = 2;
export const RECOVERY_CIRCUIT_BREAKER_MAX = 100;

const RecoveryCircuitBreakerThresholdSchema = /* @__PURE__ */ boundedInt(
  RECOVERY_CIRCUIT_BREAKER_MIN,
  RECOVERY_CIRCUIT_BREAKER_MAX,
);

export const RecoveryCircuitBreakerSchema = /* @__PURE__ */ z.union([
  z.literal(false),
  RecoveryCircuitBreakerThresholdSchema,
  z.strictObject({
      consecutiveFailures: z.union([
        z.literal(false),
        RecoveryCircuitBreakerThresholdSchema,
      ]),
    }),
]);

/** Optional workflow-level recovery settings persisted in the DAG snapshot. */
export const WorkflowRecoverySchema = /* @__PURE__ */ z.strictObject({
  circuitBreaker: z.optional(RecoveryCircuitBreakerSchema),
  contract: z.optional(RecoveryContractSchema),
});

export type WorkflowRecovery = z.infer<typeof WorkflowRecoverySchema>;
