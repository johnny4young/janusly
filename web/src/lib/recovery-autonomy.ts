/**
 * Pure recovery-autonomy policy projection.
 *
 * A workflow contract owns the maximum autonomy level. Failure-specific
 * overrides may only lower that ceiling, never raise it. This module turns the
 * declaration into one explainable capability ladder that API, engine, MCP,
 * and web projections can share without granting mutation authority itself.
 */

import type {
  RecoveryAutonomyLevel,
  RecoveryContract,
} from "./recovery-contract";
export type { RecoveryAutonomyLevel } from "./recovery-contract";

export const RECOVERY_AUTONOMY_CAPABILITIES = [
  "observe",
  "recommend",
  "validate",
  "apply_with_approval",
  "autonomous_apply",
] as const;
export type RecoveryAutonomyCapability =
  (typeof RECOVERY_AUTONOMY_CAPABILITIES)[number];

export const RECOVERY_AUTONOMY_CAPABILITY_LEVEL = {
  observe: 0,
  recommend: 1,
  validate: 2,
  apply_with_approval: 3,
  autonomous_apply: 4,
} as const satisfies Readonly<
  Record<RecoveryAutonomyCapability, RecoveryAutonomyLevel>
>;

export type RecoveryAutonomyPolicySource =
  | "failure_override"
  | "workflow_default"
  | "strictest_failure"
  | "unavailable";

export type RecoveryAutonomyUnavailableReason =
  | "contract_missing"
  | "failure_policy_missing";

export type RecoveryAutonomyFactor = {
  capability: RecoveryAutonomyCapability;
  requiredLevel: RecoveryAutonomyLevel;
  enabled: boolean;
};

export type RecoveryAutonomyProfile = {
  level: RecoveryAutonomyLevel | null;
  source: RecoveryAutonomyPolicySource;
  detectorIds: string[];
  unavailableReason: RecoveryAutonomyUnavailableReason | null;
  capabilities: {
    observe: boolean;
    recommend: boolean;
    validate: boolean;
    applyWithApproval: boolean;
    autonomousApply: boolean;
  };
  factors: RecoveryAutonomyFactor[];
};

export type RecoveryFailureClass =
  | {
      kind: "technical";
      failure: "terminal_node_failure" | "stalled_node";
    }
  | {
      kind: "semantic";
      detectorId: string;
    };

function capabilityFactors(
  level: RecoveryAutonomyLevel | null,
): RecoveryAutonomyFactor[] {
  return RECOVERY_AUTONOMY_CAPABILITIES.map((capability) => ({
    capability,
    requiredLevel: RECOVERY_AUTONOMY_CAPABILITY_LEVEL[capability],
    enabled:
      level !== null &&
      level >= RECOVERY_AUTONOMY_CAPABILITY_LEVEL[capability],
  }));
}

function profile(
  level: RecoveryAutonomyLevel | null,
  source: RecoveryAutonomyPolicySource,
  detectorIds: string[],
  unavailableReason: RecoveryAutonomyUnavailableReason | null = null,
): RecoveryAutonomyProfile {
  return {
    level,
    source,
    detectorIds: [...detectorIds],
    unavailableReason,
    capabilities: {
      observe: level !== null && level >= 0,
      recommend: level !== null && level >= 1,
      validate: level !== null && level >= 2,
      applyWithApproval: level !== null && level >= 3,
      autonomousApply: level !== null && level >= 4,
    },
    factors: capabilityFactors(level),
  };
}

export function resolveRecoveryAutonomyProfile(
  contract: RecoveryContract | null | undefined,
  failureClass: RecoveryFailureClass,
): RecoveryAutonomyProfile {
  if (!contract) {
    return profile(
      null,
      "unavailable",
      failureClass.kind === "semantic"
        ? [failureClass.detectorId]
        : [],
      "contract_missing",
    );
  }

  if (failureClass.kind === "technical") {
    const override =
      failureClass.failure === "terminal_node_failure"
        ? contract.failure.technical.autonomy?.terminalNodeFailure
        : contract.failure.technical.autonomy?.stalledNode;
    return profile(
      override ?? contract.autonomyLevel,
      override === undefined
        ? "workflow_default"
        : "failure_override",
      [],
    );
  }

  if (contract.version !== "2") {
    return profile(
      null,
      "unavailable",
      [failureClass.detectorId],
      "failure_policy_missing",
    );
  }
  const detector = contract.failure.semantic.detectors.find(
    (candidate) => candidate.id === failureClass.detectorId,
  );
  if (!detector) {
    return profile(
      null,
      "unavailable",
      [failureClass.detectorId],
      "failure_policy_missing",
    );
  }
  return profile(
    detector.autonomyLevel ?? contract.autonomyLevel,
    detector.autonomyLevel === undefined
      ? "workflow_default"
      : "failure_override",
    [detector.id],
  );
}

/**
 * One replacement can close several same-source detectors atomically. The
 * strictest detector therefore governs the whole decision; an unavailable
 * policy fails closed rather than disappearing from the aggregate.
 */
export function combineRecoveryAutonomyProfiles(
  profiles: readonly RecoveryAutonomyProfile[],
): RecoveryAutonomyProfile {
  if (profiles.length === 0) {
    return profile(
      null,
      "unavailable",
      [],
      "failure_policy_missing",
    );
  }
  const detectorIds = [
    ...new Set(profiles.flatMap((item) => item.detectorIds)),
  ];
  const unavailable = profiles.find((item) => item.level === null);
  if (unavailable) {
    return profile(
      null,
      "unavailable",
      detectorIds,
      unavailable.unavailableReason ?? "failure_policy_missing",
    );
  }
  const levels = profiles.map((item) => item.level).filter(
    (level): level is RecoveryAutonomyLevel => level !== null,
  );
  const level = Math.min(...levels) as RecoveryAutonomyLevel;
  const source =
    profiles.length === 1
      ? profiles[0]!.source
      : "strictest_failure";
  return profile(level, source, detectorIds);
}
