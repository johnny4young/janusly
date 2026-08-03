/**
 * Versioned, operator-owned recovery policy attached to a workflow snapshot.
 *
 * The contract is declarative: it names the failure/effect/repair boundaries
 * that later recovery stages must honor. Runtime-specific persistence and I/O
 * stay in the engine/data packages; this module is pure and browser-safe.
 */

import { z } from "zod";
import {
  supportsAutonomousRecovery,
  ValidationEvidenceLevelSchema,
} from "./validation-evidence";
import { WorkflowInputSchema } from "./value-schema";

export const RECOVERY_CONTRACT_VERSION = "1" as const;
export const RECOVERY_CONTRACT_V2_VERSION = "2" as const;
export const RECOVERY_QUALIFICATION_DATASET_VERSION =
  "semantic-outcomes-v1" as const;

export const RECOVERY_AUTONOMY_LEVELS = [0, 1, 2, 3, 4] as const;
export const RecoveryAutonomyLevelSchema = z.union([
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
export const RecoveryEvidenceKindSchema = z.enum(
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
export const RecoveryEffectKindSchema = z.enum(RECOVERY_EFFECT_KINDS);

export const RECOVERY_EFFECT_IDEMPOTENCY = [
  "required",
  "provider_guaranteed",
  "unavailable",
] as const;
export const RecoveryEffectIdempotencySchema = z.enum(
  RECOVERY_EFFECT_IDEMPOTENCY,
);

export const RECOVERY_EFFECT_RECEIPTS = [
  "runtime",
  "provider",
  "manual",
] as const;
export const RecoveryEffectReceiptSchema = z.enum(
  RECOVERY_EFFECT_RECEIPTS,
);

export const RecoveryEffectV1Schema = z
  .object({
    nodeId: z.string().trim().min(1).max(200),
    kind: RecoveryEffectKindSchema,
    idempotency: RecoveryEffectIdempotencySchema,
    receipt: RecoveryEffectReceiptSchema,
  })
  .strict();
export type RecoveryEffectV1 = z.infer<typeof RecoveryEffectV1Schema>;

export const RECOVERY_REPAIR_CLASSES = [
  "retry",
  "config_patch",
  "structural_patch",
  "rollback",
  "credential_rotation",
  "upstream_wait",
] as const;
export const RecoveryRepairClassSchema = z.enum(
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

const RecoveryTechnicalFailureSchema = z
  .object({
    terminalNodeFailure: z.literal(true),
    stalledNode: z.boolean(),
    autonomy: z
      .object({
        terminalNodeFailure: RecoveryAutonomyLevelSchema.optional(),
        stalledNode: RecoveryAutonomyLevelSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const RecoveryContractCommonSchema = z
  .object({
    evidence: z
      .object({
        required: z
          .array(RecoveryEvidenceKindSchema)
          .min(1)
          .max(RECOVERY_EVIDENCE_KINDS.length),
      })
      .strict(),
    effects: z.array(RecoveryEffectV1Schema).max(100),
    repairs: z
      .object({
        allowed: z
          .array(RecoveryRepairClassSchema)
          .min(1)
          .max(RECOVERY_REPAIR_CLASSES.length),
      })
      .strict(),
    validation: z
      .object({
        minimumEvidenceLevel: ValidationEvidenceLevelSchema,
      })
      .strict(),
    approval: z
      .object({
        productionMutation: z.enum([
          "required",
          "autonomous_level_4",
        ]),
        permission: z.literal("recovery.write"),
      })
      .strict(),
    autonomyLevel: RecoveryAutonomyLevelSchema,
    narrowAutonomy: z
      .object({
        allowedRepairClasses: z
          .array(RecoveryRepairClassSchema)
          .min(1)
          .max(RECOVERY_REPAIR_CLASSES.length),
        minimumPriorVerifiedRecoveries: z.number().int().min(1).max(1_000),
        maxAffectedExecutions: z.number().int().min(1).max(100),
        rollbackRequired: z.literal(true),
      })
      .strict()
      .optional(),
    verification: z
      .object({
        kind: z.literal("generation_bound_terminal_success"),
      })
      .strict(),
    recurrence: z
      .object({
        windowDays: z.number().int().min(1).max(30),
      })
      .strict(),
  })
  .strict();

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
  context: z.RefinementCtx,
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
export const RecoveryContractV1Schema = z
  .object({
    version: z.literal(RECOVERY_CONTRACT_VERSION),
    failure: z
      .object({
        technical: RecoveryTechnicalFailureSchema,
        semantic: z
          .object({
            mode: z.literal("disabled"),
          })
          .strict(),
      })
      .strict(),
    ...RecoveryContractCommonSchema.shape,
  })
  .strict()
  .superRefine(validateRecoveryContractCommon);

export type RecoveryContractV1 = z.infer<
  typeof RecoveryContractV1Schema
>;

export const RecoverySemanticExpressionDetectorV2Schema = z
  .object({
    id: z.string().trim().min(1).max(200),
    sourceNodeId: z.string().trim().min(1).max(200),
    kind: z.literal("expression"),
    passWhen: z.string().trim().min(1).max(2_000),
    action: z.enum(["observe", "quarantine"]),
    message: z.string().trim().min(1).max(500),
    autonomyLevel: RecoveryAutonomyLevelSchema.optional(),
  })
  .strict();

export const RecoverySemanticSchemaDetectorV2Schema = z
  .object({
    id: z.string().trim().min(1).max(200),
    sourceNodeId: z.string().trim().min(1).max(200),
    kind: z.literal("schema"),
    schema: WorkflowInputSchema,
    action: z.enum(["observe", "quarantine"]),
    message: z.string().trim().min(1).max(500),
    autonomyLevel: RecoveryAutonomyLevelSchema.optional(),
  })
  .strict();

export const RecoverySemanticDetectorV2Schema = z.discriminatedUnion(
  "kind",
  [
    RecoverySemanticExpressionDetectorV2Schema,
    RecoverySemanticSchemaDetectorV2Schema,
  ],
);
export type RecoverySemanticDetectorV2 = z.infer<
  typeof RecoverySemanticDetectorV2Schema
>;

export const RecoverySemanticEvaluationFixtureV2Schema = z
  .object({
    id: z.string().trim().min(1).max(200),
    sourceNodeId: z.string().trim().min(1).max(200),
    output: z.unknown(),
    context: z.record(z.string(), z.unknown()).optional(),
    expected: z.enum(["pass", "violation"]),
  })
  .strict();
export type RecoverySemanticEvaluationFixtureV2 = z.infer<
  typeof RecoverySemanticEvaluationFixtureV2Schema
>;

export const RecoveryContractV2Schema = z
  .object({
    version: z.literal(RECOVERY_CONTRACT_V2_VERSION),
    failure: z
      .object({
        technical: RecoveryTechnicalFailureSchema,
        semantic: z
          .object({
            mode: z.literal("deterministic"),
            detectors: z
              .array(RecoverySemanticDetectorV2Schema)
              .min(1)
              .max(50),
            evaluationFixtures: z
              .array(RecoverySemanticEvaluationFixtureV2Schema)
              .min(2)
              .max(50)
          })
          .strict(),
      })
      .strict(),
    ...RecoveryContractCommonSchema.shape,
  })
  .strict()
  .superRefine((contract, context) => {
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
  });

export type RecoveryContractV2 = z.infer<
  typeof RecoveryContractV2Schema
>;

export const RecoveryContractSchema = z.discriminatedUnion("version", [
  RecoveryContractV1Schema,
  RecoveryContractV2Schema,
]);
export type RecoveryContract = z.infer<
  typeof RecoveryContractSchema
>;

export const RECOVERY_CIRCUIT_BREAKER_MIN = 2;
export const RECOVERY_CIRCUIT_BREAKER_MAX = 100;

const RecoveryCircuitBreakerThresholdSchema = z
  .number()
  .int()
  .min(RECOVERY_CIRCUIT_BREAKER_MIN)
  .max(RECOVERY_CIRCUIT_BREAKER_MAX);

export const RecoveryCircuitBreakerSchema = z.union([
  z.literal(false),
  RecoveryCircuitBreakerThresholdSchema,
  z
    .object({
      consecutiveFailures: z.union([
        z.literal(false),
        RecoveryCircuitBreakerThresholdSchema,
      ]),
    })
    .strict(),
]);

/** Optional workflow-level recovery settings persisted in the DAG snapshot. */
export const WorkflowRecoverySchema = z
  .object({
    circuitBreaker: RecoveryCircuitBreakerSchema.optional(),
    contract: RecoveryContractSchema.optional(),
  })
  .strict();

export type WorkflowRecovery = z.infer<typeof WorkflowRecoverySchema>;
