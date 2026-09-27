import { describe, expect, it } from "vitest";

import en from "../i18n/locales/en/common.json";
import es from "../i18n/locales/es/common.json";
import {
  combineRecoveryAutonomyProfiles,
  resolveRecoveryAutonomyProfile,
  type RecoveryAutonomyCapability,
  type RecoveryAutonomyPolicySource,
  type RecoveryAutonomyUnavailableReason,
} from "./recovery-autonomy";
import { RecoveryContractV2Schema } from "./recovery-contract";

function contract(options: {
  workflowLevel?: 0 | 1 | 2 | 3 | 4;
  detectorLevel?: 0 | 1 | 2 | 3 | 4;
} = {}) {
  const workflowLevel = options.workflowLevel ?? 3;
  return RecoveryContractV2Schema.parse({
    version: "2",
    failure: {
      technical: {
        terminalNodeFailure: true,
        stalledNode: true,
      },
      semantic: {
        mode: "deterministic",
        detectors: [
          {
            id: "approved-answer",
            sourceNodeId: "answer",
            kind: "expression",
            passWhen:
              "context.answer.output.approved === true",
            action: "quarantine",
            message: "Answer must be approved",
            ...(options.detectorLevel === undefined
              ? {}
              : { autonomyLevel: options.detectorLevel }),
          },
        ],
        evaluationFixtures: [
          {
            id: "approved",
            sourceNodeId: "answer",
            output: { approved: true },
            expected: "pass",
          },
          {
            id: "unapproved",
            sourceNodeId: "answer",
            output: { approved: false },
            expected: "violation",
          },
        ],
      },
    },
    evidence: {
      required: [
        "failure_snapshot",
        "audit_trail",
        "terminal_outcome",
      ],
    },
    effects: [],
    repairs: { allowed: ["config_patch"] },
    validation: { minimumEvidenceLevel: "static" },
    approval: {
      productionMutation: "required",
      permission: "recovery.write",
    },
    autonomyLevel: workflowLevel,
    verification: {
      kind: "generation_bound_terminal_success",
    },
    recurrence: { windowDays: 7 },
  });
}

describe("resolveRecoveryAutonomyProfile", () => {
  it("inherits the workflow level when the detector has no override", () => {
    expect(
      resolveRecoveryAutonomyProfile(contract(), {
        kind: "semantic",
        detectorId: "approved-answer",
      }),
    ).toMatchObject({
      level: 3,
      source: "workflow_default",
      capabilities: {
        observe: true,
        recommend: true,
        validate: true,
        applyWithApproval: true,
        autonomousApply: false,
      },
    });
  });

  it("uses a lower detector override as the effective ceiling", () => {
    const result = resolveRecoveryAutonomyProfile(
      contract({ detectorLevel: 1 }),
      {
        kind: "semantic",
        detectorId: "approved-answer",
      },
    );
    expect(result).toMatchObject({
      level: 1,
      source: "failure_override",
      detectorIds: ["approved-answer"],
      capabilities: {
        observe: true,
        recommend: true,
        validate: false,
        applyWithApproval: false,
        autonomousApply: false,
      },
    });
    expect(result.factors.map((factor) => factor.enabled)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("fails closed when the detector is absent", () => {
    expect(
      resolveRecoveryAutonomyProfile(contract(), {
        kind: "semantic",
        detectorId: "missing",
      }),
    ).toMatchObject({
      level: null,
      source: "unavailable",
      unavailableReason: "failure_policy_missing",
      capabilities: {
        applyWithApproval: false,
        autonomousApply: false,
      },
    });
  });

  it("combines same-source policies using the strictest detector", () => {
    const combined = combineRecoveryAutonomyProfiles([
      resolveRecoveryAutonomyProfile(contract(), {
        kind: "semantic",
        detectorId: "approved-answer",
      }),
      resolveRecoveryAutonomyProfile(
        contract({ detectorLevel: 1 }),
        {
          kind: "semantic",
          detectorId: "approved-answer",
        },
      ),
    ]);
    expect(combined).toMatchObject({
      level: 1,
      source: "strictest_failure",
      capabilities: { applyWithApproval: false },
    });
  });
});

// Keyed by the manifest unions: a value Go adds fails typecheck until it has copy.
const SOURCES: Record<RecoveryAutonomyPolicySource, true> = {
  failure_override: true, workflow_default: true, strictest_failure: true, unavailable: true,
};
const REASONS: Record<RecoveryAutonomyUnavailableReason, true> = {
  contract_missing: true, failure_policy_missing: true,
};
const CAPABILITIES: Record<RecoveryAutonomyCapability, true> = {
  observe: true, recommend: true, validate: true, apply_with_approval: true, autonomous_apply: true,
};

describe("recovery autonomy copy", () => {
  it("translates every source, unavailable reason and capability the manifest admits", () => {
    const keys = [
      ...Object.keys(SOURCES).map((value) => `recoveryCase.autonomy.source.${value}`),
      ...Object.keys(REASONS).map((value) => `recoveryCase.autonomy.reason.${value}`),
      ...Object.keys(CAPABILITIES).map((value) => `recoveryCase.autonomy.capability.${value}`),
    ];
    for (const catalog of [en, es] as Record<string, string>[]) {
      expect(keys.filter((key) => !catalog[key])).toEqual([]);
    }
  });
});
