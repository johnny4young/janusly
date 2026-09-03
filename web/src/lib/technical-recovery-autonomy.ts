import type {
  RecoveryContract,
  RecoveryRepairClass,
} from "./recovery-contract";
import {
  resolveRecoveryAutonomyProfile,
  type RecoveryAutonomyProfile,
} from "./recovery-autonomy";
import {
  VALIDATION_EVIDENCE_LEVELS,
  type ValidationEvidenceLevel,
} from "./validation-evidence";
import {
  computeWorkflowDiff,
  type DiffableWorkflow,
} from "./workflow-diff";

export const TECHNICAL_AUTONOMY_FACTOR_IDS = [
  "policy",
  "repair_scope",
  "validation_evidence",
  "prior_recoveries",
  "blast_radius",
  "rollback",
  "effect_receipts",
] as const;
export type TechnicalAutonomyFactorId =
  (typeof TECHNICAL_AUTONOMY_FACTOR_IDS)[number];

export type TechnicalRecoveryFailure =
  | "terminal_node_failure"
  | "stalled_node";

export const TECHNICAL_AUTONOMY_FACTOR_REASONS = [
  "ready",
  "policy_unavailable",
  "autonomy_level_below_4",
  "mutation_policy_requires_approval",
  "repair_unclassified",
  "repair_not_allowlisted",
  "validation_evidence_insufficient",
  "prior_recoveries_insufficient",
  "blast_radius_exceeded",
  "rollback_unavailable",
  "effect_receipts_unsafe",
] as const;
export type TechnicalAutonomyFactorReason =
  (typeof TECHNICAL_AUTONOMY_FACTOR_REASONS)[number];

export type TechnicalAutonomyFactor = {
  id: TechnicalAutonomyFactorId;
  passed: boolean;
  reason: TechnicalAutonomyFactorReason;
  actual: string | number | boolean | null;
  required: string | number | boolean | null;
};

export type TechnicalRecoveryAutonomyAssessment = {
  eligible: boolean;
  failure: TechnicalRecoveryFailure;
  repairClass: RecoveryRepairClass | null;
  policy: RecoveryAutonomyProfile;
  validationEvidenceLevel: ValidationEvidenceLevel;
  minimumEvidenceLevel: ValidationEvidenceLevel | null;
  priorVerifiedRecoveries: number;
  affectedExecutions: number;
  factors: TechnicalAutonomyFactor[];
};

const EVIDENCE_RANK = new Map(
  VALIDATION_EVIDENCE_LEVELS.map((level, index) => [level, index]),
);

function passesEvidenceMinimum(
  actual: ValidationEvidenceLevel,
  required: ValidationEvidenceLevel,
): boolean {
  return (EVIDENCE_RANK.get(actual) ?? -1) >=
    (EVIDENCE_RANK.get(required) ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Classify only the bounded patch shapes the supervised recovery path can
 * prove from an exact before/after workflow pair.
 */
export function classifyTechnicalRecoveryRepair(input: {
  original: DiffableWorkflow;
  candidate: DiffableWorkflow;
  failingNodeId: string;
}): RecoveryRepairClass | null {
  const diff = computeWorkflowDiff(input.original, input.candidate);
  if (diff.summary.totalChanges === 0 || diff.workflow.length > 0) {
    return null;
  }

  const addedNodes = diff.nodes.filter((change) => change.kind === "added");
  const removedNodes = diff.nodes.filter((change) => change.kind === "removed");
  const changedNodes = diff.nodes.filter((change) => change.kind === "changed");
  const hasGraphChange =
    addedNodes.length > 0 ||
    removedNodes.length > 0 ||
    diff.edges.length > 0;

  if (hasGraphChange) {
    return isExactApprovalInsertion({
      original: input.original,
      candidate: input.candidate,
      failingNodeId: input.failingNodeId,
      addedNodes,
      removedNodes,
      changedNodes,
    })
      ? "structural_patch"
      : null;
  }

  if (
    changedNodes.length !== 1 ||
    changedNodes[0]?.nodeId !== input.failingNodeId
  ) {
    return null;
  }
  const fields = changedNodes[0].fields;
  if (
    fields.length > 0 &&
    fields.every(
      (field) =>
        field.path === "config.retry" ||
        field.path.startsWith("config.retry."),
    )
  ) {
    return "retry";
  }
  if (
    fields.length > 0 &&
    fields.every(
      (field) =>
        field.path === "config" ||
        field.path.startsWith("config."),
    )
  ) {
    return "config_patch";
  }
  return null;
}

function isExactApprovalInsertion(input: {
  original: DiffableWorkflow;
  candidate: DiffableWorkflow;
  failingNodeId: string;
  addedNodes: Extract<
    ReturnType<typeof computeWorkflowDiff>["nodes"][number],
    { kind: "added" }
  >[];
  removedNodes: Extract<
    ReturnType<typeof computeWorkflowDiff>["nodes"][number],
    { kind: "removed" }
  >[];
  changedNodes: Extract<
    ReturnType<typeof computeWorkflowDiff>["nodes"][number],
    { kind: "changed" }
  >[];
}): boolean {
  const approval = input.addedNodes[0]?.node;
  if (
    input.addedNodes.length !== 1 ||
    approval?.type !== "approval" ||
    input.removedNodes.length !== 0 ||
    input.changedNodes.length !== 0 ||
    !input.original.nodes?.some((node) => node.id === input.failingNodeId)
  ) {
    return false;
  }
  const approvalConfig = asRecord(approval.config);
  if (
    Object.keys(approvalConfig).length !== 1 ||
    typeof approvalConfig.message !== "string" ||
    approvalConfig.message.trim().length === 0
  ) {
    return false;
  }

  const expectedEdges = (input.original.edges ?? []).map((edge) =>
    edge.to === input.failingNodeId
      ? { ...edge, to: approval.id }
      : edge
  );
  expectedEdges.push({ from: approval.id, to: input.failingNodeId });
  return equalEdgeSets(expectedEdges, input.candidate.edges ?? []);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function equalEdgeSets(
  left: readonly { id?: string; from: string; to: string; condition?: string }[],
  right: readonly { id?: string; from: string; to: string; condition?: string }[],
): boolean {
  if (left.length !== right.length) return false;
  const canonical = (
    edge: { id?: string; from: string; to: string; condition?: string },
  ) => JSON.stringify([
    edge.id ?? null,
    edge.from,
    edge.to,
    edge.condition ?? null,
  ]);
  const leftEdges = left.map(canonical).sort();
  const rightEdges = right.map(canonical).sort();
  return leftEdges.every(
    (edge, index) => edge === rightEdges[index],
  );
}

function factor(
  id: TechnicalAutonomyFactorId,
  passed: boolean,
  blockedReason: Exclude<TechnicalAutonomyFactorReason, "ready">,
  actual: TechnicalAutonomyFactor["actual"],
  required: TechnicalAutonomyFactor["required"],
): TechnicalAutonomyFactor {
  return {
    id,
    passed,
    reason: passed ? "ready" : blockedReason,
    actual,
    required,
  };
}

/**
 * Evaluate Level 4 technical recovery from operator-owned policy and
 * persisted runtime facts. The result explains authority; it never performs a
 * mutation itself.
 */
export function evaluateTechnicalRecoveryAutonomy(input: {
  contract: RecoveryContract | null | undefined;
  failure: TechnicalRecoveryFailure;
  repairClass: RecoveryRepairClass | null;
  validationEvidenceLevel: ValidationEvidenceLevel;
  priorVerifiedRecoveries: number;
  affectedExecutions: number;
  rollbackReady: boolean;
}): TechnicalRecoveryAutonomyAssessment {
  const policy = resolveRecoveryAutonomyProfile(input.contract, {
    kind: "technical",
    failure: input.failure,
  });
  const narrow = input.contract?.narrowAutonomy;
  const minimumEvidenceLevel =
    input.contract?.validation.minimumEvidenceLevel ?? null;
  const policyReady =
    policy.level === 4 &&
    input.contract?.approval.productionMutation === "autonomous_level_4";
  const repairReady = Boolean(
    input.repairClass &&
    input.contract?.repairs.allowed.includes(input.repairClass) &&
    narrow?.allowedRepairClasses.includes(input.repairClass),
  );
  const evidenceReady = Boolean(
    minimumEvidenceLevel &&
    passesEvidenceMinimum(
      input.validationEvidenceLevel,
      minimumEvidenceLevel,
    ) &&
    (
      input.validationEvidenceLevel === "provider_simulated" ||
      input.validationEvidenceLevel === "live_canary"
    ),
  );
  const priorReady = Boolean(
    narrow &&
    input.priorVerifiedRecoveries >=
      narrow.minimumPriorVerifiedRecoveries,
  );
  const blastRadiusReady = Boolean(
    narrow &&
    input.affectedExecutions >= 1 &&
    input.affectedExecutions <= narrow.maxAffectedExecutions,
  );
  const rollbackReady = Boolean(
    narrow?.rollbackRequired && input.rollbackReady,
  );
  const effectReceiptsReady = Boolean(
    input.contract?.evidence.required.includes("effect_receipt") &&
    input.contract.effects.every(
      (effect) =>
        effect.idempotency !== "unavailable" &&
        effect.receipt !== "manual",
    ),
  );

  const factors: TechnicalAutonomyFactor[] = [
    factor(
      "policy",
      policyReady,
      policy.level === null
        ? "policy_unavailable"
        : policy.level < 4
          ? "autonomy_level_below_4"
          : "mutation_policy_requires_approval",
      policy.level,
      4,
    ),
    factor(
      "repair_scope",
      repairReady,
      input.repairClass
        ? "repair_not_allowlisted"
        : "repair_unclassified",
      input.repairClass,
      narrow?.allowedRepairClasses.join(", ") ?? null,
    ),
    factor(
      "validation_evidence",
      evidenceReady,
      "validation_evidence_insufficient",
      input.validationEvidenceLevel,
      minimumEvidenceLevel,
    ),
    factor(
      "prior_recoveries",
      priorReady,
      "prior_recoveries_insufficient",
      input.priorVerifiedRecoveries,
      narrow?.minimumPriorVerifiedRecoveries ?? null,
    ),
    factor(
      "blast_radius",
      blastRadiusReady,
      "blast_radius_exceeded",
      input.affectedExecutions,
      narrow?.maxAffectedExecutions ?? null,
    ),
    factor(
      "rollback",
      rollbackReady,
      "rollback_unavailable",
      input.rollbackReady,
      narrow?.rollbackRequired ?? null,
    ),
    factor(
      "effect_receipts",
      effectReceiptsReady,
      "effect_receipts_unsafe",
      effectReceiptsReady,
      true,
    ),
  ];

  return {
    eligible: factors.every((item) => item.passed),
    failure: input.failure,
    repairClass: input.repairClass,
    policy,
    validationEvidenceLevel: input.validationEvidenceLevel,
    minimumEvidenceLevel,
    priorVerifiedRecoveries: input.priorVerifiedRecoveries,
    affectedExecutions: input.affectedExecutions,
    factors,
  };
}
