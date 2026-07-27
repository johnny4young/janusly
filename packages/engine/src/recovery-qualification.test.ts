import { describe, expect, it } from "vitest";

import type {
  RecoveryContractV2,
  RecoverySemanticEvaluationFixtureV2,
  Workflow,
} from "@janusly/shared";

import {
  qualifyRecoveryCandidate,
  RECOVERY_QUALIFICATION_FAILURE_LIMIT,
  toRecoveryQualificationReceiptSummary,
} from "./recovery-qualification";

function fixtures(
  sourceNodeId = "outcome",
): RecoverySemanticEvaluationFixtureV2[] {
  return [
    {
      id: "approved",
      sourceNodeId,
      output: { approved: true },
      expected: "pass",
    },
    {
      id: "rejected",
      sourceNodeId,
      output: { approved: false },
      expected: "violation",
    },
  ];
}

function contract(
  options: {
    sourceNodeId?: string;
    passWhen?: string;
    evaluationFixtures?: RecoverySemanticEvaluationFixtureV2[];
  } = {},
): RecoveryContractV2 {
  const sourceNodeId = options.sourceNodeId ?? "outcome";
  return {
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
            id: "approved-outcome",
            sourceNodeId,
            kind: "expression",
            passWhen:
              options.passWhen
              ?? `context.${sourceNodeId}.output.approved === true`,
            action: "quarantine",
            message: "The outcome must be approved",
          },
        ],
        evaluationFixtures:
          options.evaluationFixtures ?? fixtures(sourceNodeId),
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
    repairs: { allowed: ["retry"] },
    validation: { minimumEvidenceLevel: "static" },
    approval: {
      productionMutation: "required",
      permission: "recovery.write",
    },
    autonomyLevel: 0,
    verification: {
      kind: "generation_bound_terminal_success",
    },
    recurrence: { windowDays: 7 },
  };
}

function workflow(
  recoveryContract?: RecoveryContractV2,
  id = "workflow",
): Workflow {
  return {
    dslVersion: "1.0",
    id,
    name: "Qualification",
    nodes: [{ id: "outcome", type: "noop", config: {} }],
    edges: [],
    ...(recoveryContract
      ? { recovery: { contract: recoveryContract } }
      : {}),
  };
}

describe("qualifyRecoveryCandidate", () => {
  it("does not require a dataset comparison when neither version has V2", () => {
    const result = qualifyRecoveryCandidate({
      baseline: workflow(),
      candidate: workflow(),
    });

    expect(result).toMatchObject({
      mode: "not_required",
      status: "not_required",
      candidateAssertionCount: 0,
      failures: [],
    });
  });

  it("bootstraps the first V2 version against its own fixtures", () => {
    const result = qualifyRecoveryCandidate({
      baseline: workflow(),
      candidate: workflow(contract()),
    });

    expect(result).toMatchObject({
      mode: "bootstrap",
      status: "passed",
      baselineCaseCount: 0,
      candidateCaseCount: 2,
      candidateAssertionCount: 2,
      passedCandidateAssertions: 2,
      regressionCount: 0,
    });
  });

  it("replays the candidate against immutable baseline and candidate datasets", () => {
    const result = qualifyRecoveryCandidate({
      baseline: workflow(contract()),
      candidate: workflow(contract()),
    });

    expect(result).toMatchObject({
      mode: "compare",
      status: "passed",
      baselineCaseCount: 2,
      candidateCaseCount: 2,
      candidateAssertionCount: 4,
      passedCandidateAssertions: 4,
      failedCandidateAssertions: 0,
      baselineDatasetValid: true,
    });
  });

  it("fails when a candidate changes baseline outcome behavior", () => {
    const result = qualifyRecoveryCandidate({
      baseline: workflow(contract()),
      candidate: workflow(
        contract({
          passWhen: "context.outcome.output.approved === false",
        }),
      ),
    });

    expect(result.status).toBe("failed");
    expect(result.regressionCount).toBe(2);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataset: "baseline",
          fixtureId: "approved",
          reason: "expected_mismatch",
        }),
      ]),
    );
  });

  it("fails closed when the candidate no longer covers a baseline source", () => {
    const result = qualifyRecoveryCandidate({
      baseline: workflow(contract()),
      candidate: workflow(contract({ sourceNodeId: "other" })),
    });

    expect(result.status).toBe("failed");
    expect(result.regressionCount).toBe(2);
    expect(result.coverageFailureCount).toBe(2);
    expect(result.failures[0]).toMatchObject({
      actual: "uncovered",
      reason: "detector_uncovered",
    });
  });

  it("prevents a V2 canary from silently dropping semantic protection", () => {
    const result = qualifyRecoveryCandidate({
      baseline: workflow(contract()),
      candidate: workflow(),
    });

    expect(result).toMatchObject({
      mode: "compare",
      status: "failed",
      failedCandidateAssertions: 2,
      regressionCount: 2,
      coverageFailureCount: 2,
    });
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        reason: "candidate_contract_missing",
      }),
    );
  });

  it("marks a corrupt baseline dataset invalid instead of blaming only the candidate", () => {
    const invalidBaseline = contract({
      evaluationFixtures: [
        {
          id: "wrong-pass",
          sourceNodeId: "outcome",
          output: { approved: false },
          expected: "pass",
        },
        fixtures()[0]!,
      ],
    });
    const result = qualifyRecoveryCandidate({
      baseline: workflow(invalidBaseline),
      candidate: workflow(contract()),
    });

    expect(result.status).toBe("failed");
    expect(result.baselineDatasetValid).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({
        fixtureId: "wrong-pass",
        reason: "baseline_dataset_invalid",
      }),
    );
  });

  it("produces a stable digest despite object key order", () => {
    const left = contract({
      evaluationFixtures: [
        {
          id: "approved",
          sourceNodeId: "outcome",
          output: { approved: true, metadata: { b: 2, a: 1 } },
          expected: "pass",
        },
        fixtures()[1]!,
      ],
    });
    const right = contract({
      evaluationFixtures: [
        {
          id: "approved",
          sourceNodeId: "outcome",
          output: { metadata: { a: 1, b: 2 }, approved: true },
          expected: "pass",
        },
        fixtures()[1]!,
      ],
    });

    expect(
      qualifyRecoveryCandidate({
        baseline: workflow(left),
        candidate: workflow(right),
      }).datasetDigest,
    ).toBe(
      qualifyRecoveryCandidate({
        baseline: workflow(right),
        candidate: workflow(left),
      }).datasetDigest,
    );
  });

  it("bounds failure details while preserving aggregate counts", () => {
    const manyFixtures = Array.from({ length: 50 }, (_, index) => ({
      id: `fixture-${index}`,
      sourceNodeId: "outcome",
      output: { approved: index % 2 === 0 },
      expected: "pass" as const,
    }));
    const result = qualifyRecoveryCandidate({
      baseline: workflow(
        contract({ evaluationFixtures: manyFixtures }),
      ),
      candidate: workflow(
        contract({
          passWhen: "context.outcome.output.approved === false",
          evaluationFixtures: manyFixtures,
        }),
      ),
    });

    expect(result.failedCandidateAssertions).toBeGreaterThan(
      RECOVERY_QUALIFICATION_FAILURE_LIMIT,
    );
    expect(result.failures).toHaveLength(
      RECOVERY_QUALIFICATION_FAILURE_LIMIT,
    );
    expect(result.failuresTruncated).toBe(true);
  });

  it("keeps durable receipts readable without verbose violation internals", () => {
    const result = qualifyRecoveryCandidate({
      baseline: workflow(contract()),
      candidate: workflow(
        contract({
          passWhen: "context.outcome.output.approved === false",
        }),
      ),
    });

    const receipt = toRecoveryQualificationReceiptSummary(result);

    expect(receipt.failures.length).toBeGreaterThan(0);
    expect(receipt.failures[0]).not.toHaveProperty("violations");
    expect(receipt).toMatchObject({
      datasetDigest: result.datasetDigest,
      status: "failed",
      regressionCount: result.regressionCount,
    });
  });
});
