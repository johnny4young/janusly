/**
 * Pure Recovery Case lifecycle and measurement contracts.
 *
 * `recovery_items` remains the technical DLQ incident substrate. Durable
 * semantic incidents use `recovery_cases`; both surfaces share this stable
 * state and receipt vocabulary without coupling the browser-safe contract to
 * persistence.
 */

import { z } from "zod";

export const RECOVERY_CASE_STATES = [
  "detected",
  "contained",
  "diagnosed",
  "candidates_ready",
  "validating",
  "awaiting_approval",
  "publishing",
  "monitoring",
  "verified_recovered",
  "recurred",
  "accepted_loss",
  "abandoned",
] as const;
export const RecoveryCaseStateSchema = z.enum(RECOVERY_CASE_STATES);
export type RecoveryCaseState = z.infer<typeof RecoveryCaseStateSchema>;

export const RECOVERY_CASE_TERMINAL_STATES = [
  "verified_recovered",
  "recurred",
  "accepted_loss",
  "abandoned",
] as const satisfies readonly RecoveryCaseState[];
const recoveryCaseTerminalStateSet = new Set<RecoveryCaseState>(
  RECOVERY_CASE_TERMINAL_STATES,
);
export const RECOVERY_CASE_OPEN_STATES = RECOVERY_CASE_STATES.filter(
  (state) => !recoveryCaseTerminalStateSet.has(state),
);

const LEGAL_RECOVERY_CASE_TRANSITIONS: Readonly<
  Record<RecoveryCaseState, readonly RecoveryCaseState[]>
> = {
  detected: ["contained", "accepted_loss", "abandoned"],
  contained: ["diagnosed", "accepted_loss", "abandoned"],
  diagnosed: ["candidates_ready", "accepted_loss", "abandoned"],
  candidates_ready: ["validating", "accepted_loss", "abandoned"],
  validating: [
    "candidates_ready",
    "awaiting_approval",
    "accepted_loss",
    "abandoned",
  ],
  awaiting_approval: [
    "candidates_ready",
    "publishing",
    "accepted_loss",
    "abandoned",
  ],
  publishing: ["monitoring", "abandoned"],
  monitoring: [
    "verified_recovered",
    "recurred",
    "accepted_loss",
    "abandoned",
  ],
  verified_recovered: [],
  recurred: [],
  accepted_loss: [],
  abandoned: [],
};

export function listLegalRecoveryCaseTransitions(
  state: RecoveryCaseState,
): readonly RecoveryCaseState[] {
  return LEGAL_RECOVERY_CASE_TRANSITIONS[state];
}

export function isLegalRecoveryCaseTransition(
  from: RecoveryCaseState,
  to: RecoveryCaseState,
): boolean {
  return LEGAL_RECOVERY_CASE_TRANSITIONS[from].includes(to);
}

export const RECOVERY_CASE_EVIDENCE_REFERENCE_KINDS = [
  "run",
  "run_node",
  "run_event",
  "semantic_detector",
  "dead_letter",
  "validation",
  "publication",
  "effect",
  "audit",
  "operator_decision",
] as const;

export const RecoveryCaseEvidenceReferenceV1Schema = z
  .object({
    kind: z.enum(RECOVERY_CASE_EVIDENCE_REFERENCE_KINDS),
    id: z.string().trim().min(1).max(500),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

const RecoveryCaseActorV1Schema = z
  .object({
    kind: z.enum(["system", "user", "agent"]),
    id: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((actor, context) => {
    if (actor.kind !== "system" && !actor.id) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "User and agent transition actors require an id",
      });
    }
  });

/**
 * Every case transition is expected to be persisted with this receipt shape.
 * The state machine validator is separate so a store can apply it inside the
 * same CAS transaction that writes the receipt.
 */
export const RecoveryCaseTransitionReceiptV1Schema = z
  .object({
    version: z.literal("1"),
    id: z.string().trim().min(1).max(200),
    caseId: z.string().trim().min(1).max(200),
    from: RecoveryCaseStateSchema,
    to: RecoveryCaseStateSchema,
    actor: RecoveryCaseActorV1Schema,
    occurredAt: z.string().datetime(),
    evidence: z
      .array(RecoveryCaseEvidenceReferenceV1Schema)
      .min(1)
      .max(100),
    reason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (!isLegalRecoveryCaseTransition(receipt.from, receipt.to)) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: `Illegal recovery case transition: ${receipt.from} -> ${receipt.to}`,
      });
    }
  });

export type RecoveryCaseTransitionReceiptV1 = z.infer<
  typeof RecoveryCaseTransitionReceiptV1Schema
>;

export const RECOVERY_NORTH_STAR_DEFINITION_V1 = {
  version: "1",
  key: "time_to_verified_recovery",
  statistic: "median",
  unit: "milliseconds",
  startsAt: "detected_at",
  stopsAt: "verified_recovered_at",
  eligibleOutcome: "verified_recovered",
  productionOnly: true,
} as const;

export const RecoveryNorthStarSampleV1Schema = z
  .object({
    definitionVersion: z.literal(
      RECOVERY_NORTH_STAR_DEFINITION_V1.version,
    ),
    metric: z.literal(RECOVERY_NORTH_STAR_DEFINITION_V1.key),
    caseId: z.string().trim().min(1).max(200),
    source: z.enum(["technical_failure", "semantic_violation"]),
    verificationKind: z.enum([
      "generation_bound_terminal_success",
      "contract_outcome_verified",
    ]),
    detectedAt: z.string().datetime(),
    verifiedRecoveredAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type RecoveryNorthStarSampleV1 = z.infer<
  typeof RecoveryNorthStarSampleV1Schema
>;

export type RecoveryNorthStarExclusionReason =
  | "non_production"
  | "outcome_not_verified"
  | "invalid_timestamp"
  | "negative_duration";

export type BuildRecoveryNorthStarSampleResult =
  | { included: true; sample: RecoveryNorthStarSampleV1 }
  | { included: false; reason: RecoveryNorthStarExclusionReason };

export function buildRecoveryNorthStarSample(input: {
  caseId: string;
  source: RecoveryNorthStarSampleV1["source"];
  verificationKind: RecoveryNorthStarSampleV1["verificationKind"];
  runKind: "production" | "validation";
  outcome: RecoveryCaseState;
  detectedAt: Date | string;
  verifiedRecoveredAt: Date | string;
}): BuildRecoveryNorthStarSampleResult {
  if (input.runKind !== "production") {
    return { included: false, reason: "non_production" };
  }
  if (input.outcome !== "verified_recovered") {
    return { included: false, reason: "outcome_not_verified" };
  }
  const detectedAt = new Date(input.detectedAt);
  const verifiedRecoveredAt = new Date(input.verifiedRecoveredAt);
  const detectedMs = detectedAt.getTime();
  const verifiedMs = verifiedRecoveredAt.getTime();
  if (!Number.isFinite(detectedMs) || !Number.isFinite(verifiedMs)) {
    return { included: false, reason: "invalid_timestamp" };
  }
  const rawDurationMs = verifiedMs - detectedMs;
  if (rawDurationMs < 0) {
    return { included: false, reason: "negative_duration" };
  }
  const durationMs = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.round(rawDurationMs),
  );
  const sample = RecoveryNorthStarSampleV1Schema.parse({
    definitionVersion: RECOVERY_NORTH_STAR_DEFINITION_V1.version,
    metric: RECOVERY_NORTH_STAR_DEFINITION_V1.key,
    caseId: input.caseId,
    source: input.source,
    verificationKind: input.verificationKind,
    detectedAt: detectedAt.toISOString(),
    verifiedRecoveredAt: verifiedRecoveredAt.toISOString(),
    durationMs,
  });
  return { included: true, sample };
}
