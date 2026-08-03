/**
 * Deterministic pre-deployment qualification for semantic outcome contracts.
 *
 * The baseline workflow owns the regression dataset. A candidate is replayed
 * against that immutable fixture snapshot and against its own declared
 * fixtures. No workflow nodes execute, no provider is called, and no external
 * effect can occur.
 */

import { createHash } from "node:crypto";

import {
  RECOVERY_QUALIFICATION_DATASET_VERSION,
  type RecoveryContractV2,
  type RecoverySemanticEvaluationFixtureV2,
  type Workflow,
} from "@janusly/shared";

import {
  evaluateSemanticOutcome,
  evaluateSemanticOutcomeFixtures,
  type SemanticOutcomeViolation,
} from "./semantic-outcomes";

export const RECOVERY_QUALIFICATION_FAILURE_LIMIT = 20;

export type RecoveryQualificationMode =
  | "not_required"
  | "bootstrap"
  | "compare";
export type RecoveryQualificationStatus =
  | "not_required"
  | "passed"
  | "failed";
export type RecoveryQualificationFailureReason =
  | "baseline_dataset_invalid"
  | "candidate_contract_missing"
  | "detector_uncovered"
  | "expected_mismatch";

export type RecoveryQualificationFailure = {
  dataset: "baseline" | "candidate";
  fixtureId: string;
  sourceNodeId: string;
  expected: "pass" | "violation";
  actual: "pass" | "violation" | "uncovered";
  reason: RecoveryQualificationFailureReason;
  violations: SemanticOutcomeViolation[];
};

export type RecoveryQualificationSummary = {
  datasetVersion: typeof RECOVERY_QUALIFICATION_DATASET_VERSION;
  datasetDigest: string;
  mode: RecoveryQualificationMode;
  status: RecoveryQualificationStatus;
  baselineCaseCount: number;
  candidateCaseCount: number;
  candidateAssertionCount: number;
  passedCandidateAssertions: number;
  failedCandidateAssertions: number;
  regressionCount: number;
  coverageFailureCount: number;
  baselineDatasetValid: boolean;
  failures: RecoveryQualificationFailure[];
  failuresTruncated: boolean;
};

export type RecoveryQualificationReceiptSummary = Omit<
  RecoveryQualificationSummary,
  "failures"
> & {
  failures: Array<Omit<RecoveryQualificationFailure, "violations">>;
};

/**
 * Keep durable authorization evidence compact and stable.
 *
 * Violation internals can contain many schema diagnostics and are useful only
 * during the synchronous evaluation. The receipt retains the exact dataset,
 * aggregate result, and bounded actionable failure identity without risking a
 * size-bound sentinel that would make the stored result unreadable.
 */
export function toRecoveryQualificationReceiptSummary(
  summary: RecoveryQualificationSummary,
): RecoveryQualificationReceiptSummary {
  return {
    ...summary,
    failures: summary.failures.map(({ violations: _violations, ...failure }) =>
      failure
    ),
  };
}

function semanticContract(workflow: Workflow): RecoveryContractV2 | null {
  const contract = workflow.recovery?.contract;
  return contract?.version === "2" ? contract : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function datasetDigest(input: {
  baseline: readonly RecoverySemanticEvaluationFixtureV2[];
  candidate: readonly RecoverySemanticEvaluationFixtureV2[];
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        version: RECOVERY_QUALIFICATION_DATASET_VERSION,
        baseline: input.baseline,
        candidate: input.candidate,
      }),
    )
    .digest("hex");
}

function evaluateFixture(
  contract: RecoveryContractV2,
  fixture: RecoverySemanticEvaluationFixtureV2,
): {
  actual: "pass" | "violation" | "uncovered";
  passed: boolean;
  violations: SemanticOutcomeViolation[];
} {
  const covered = contract.failure.semantic.detectors.some(
    (detector) => detector.sourceNodeId === fixture.sourceNodeId,
  );
  if (!covered) {
    return { actual: "uncovered", passed: false, violations: [] };
  }
  const evaluation = evaluateSemanticOutcome({
    contract,
    sourceNodeId: fixture.sourceNodeId,
    output: fixture.output,
    context: fixture.context,
  });
  const actual =
    evaluation.violations.length === 0 ? "pass" : "violation";
  return {
    actual,
    passed: actual === fixture.expected,
    violations: evaluation.violations,
  };
}

/**
 * Compare one immutable baseline and candidate workflow.
 *
 * A V1-to-V2 transition runs in bootstrap mode because no baseline semantic
 * dataset exists yet. Once the baseline is V2, every later candidate must keep
 * the baseline fixture expectations and detector coverage intact.
 */
export function qualifyRecoveryCandidate(input: {
  baseline: Workflow;
  candidate: Workflow;
}): RecoveryQualificationSummary {
  const baselineContract = semanticContract(input.baseline);
  const candidateContract = semanticContract(input.candidate);
  const baselineFixtures =
    baselineContract?.failure.semantic.evaluationFixtures ?? [];
  const candidateFixtures =
    candidateContract?.failure.semantic.evaluationFixtures ?? [];
  const digest = datasetDigest({
    baseline: baselineFixtures,
    candidate: candidateFixtures,
  });

  if (!baselineContract && !candidateContract) {
    return {
      datasetVersion: RECOVERY_QUALIFICATION_DATASET_VERSION,
      datasetDigest: digest,
      mode: "not_required",
      status: "not_required",
      baselineCaseCount: 0,
      candidateCaseCount: 0,
      candidateAssertionCount: 0,
      passedCandidateAssertions: 0,
      failedCandidateAssertions: 0,
      regressionCount: 0,
      coverageFailureCount: 0,
      baselineDatasetValid: true,
      failures: [],
      failuresTruncated: false,
    };
  }

  const mode: RecoveryQualificationMode = baselineContract
    ? "compare"
    : "bootstrap";
  const failures: RecoveryQualificationFailure[] = [];
  let totalFailures = 0;
  let regressionCount = 0;
  let coverageFailureCount = 0;

  const addFailure = (failure: RecoveryQualificationFailure): void => {
    totalFailures += 1;
    if (failures.length < RECOVERY_QUALIFICATION_FAILURE_LIMIT) {
      failures.push(failure);
    }
  };

  const baselineFixtureResults = baselineContract
    ? evaluateSemanticOutcomeFixtures(baselineContract)
    : [];
  const baselineDatasetValid = baselineFixtureResults.every(
    (result) => result.passed,
  );
  for (const result of baselineFixtureResults) {
    if (result.passed) continue;
    addFailure({
      dataset: "baseline",
      fixtureId: result.id,
      sourceNodeId: result.sourceNodeId,
      expected: result.expected,
      actual: result.actual,
      reason: "baseline_dataset_invalid",
      violations: result.violations,
    });
  }

  if (!candidateContract) {
    addFailure({
      dataset: "candidate",
      fixtureId: "candidate-contract",
      sourceNodeId: "",
      expected: "pass",
      actual: "uncovered",
      reason: "candidate_contract_missing",
      violations: [],
    });
    return {
      datasetVersion: RECOVERY_QUALIFICATION_DATASET_VERSION,
      datasetDigest: digest,
      mode,
      status: "failed",
      baselineCaseCount: baselineFixtures.length,
      candidateCaseCount: 0,
      candidateAssertionCount: baselineFixtures.length,
      passedCandidateAssertions: 0,
      failedCandidateAssertions: baselineFixtures.length,
      regressionCount: baselineFixtures.length,
      coverageFailureCount: baselineFixtures.length,
      baselineDatasetValid,
      failures,
      failuresTruncated: totalFailures > failures.length,
    };
  }

  let passedCandidateAssertions = 0;
  const evaluateDataset = (
    dataset: "baseline" | "candidate",
    fixtures: readonly RecoverySemanticEvaluationFixtureV2[],
  ): void => {
    for (const fixture of fixtures) {
      const result = evaluateFixture(candidateContract, fixture);
      if (result.passed) {
        passedCandidateAssertions += 1;
        continue;
      }
      const reason = result.actual === "uncovered"
        ? "detector_uncovered"
        : "expected_mismatch";
      if (reason === "detector_uncovered") coverageFailureCount += 1;
      if (dataset === "baseline") regressionCount += 1;
      addFailure({
        dataset,
        fixtureId: fixture.id,
        sourceNodeId: fixture.sourceNodeId,
        expected: fixture.expected,
        actual: result.actual,
        reason,
        violations: result.violations,
      });
    }
  };

  evaluateDataset("baseline", baselineFixtures);
  evaluateDataset("candidate", candidateFixtures);
  const candidateAssertionCount =
    baselineFixtures.length + candidateFixtures.length;
  const failedCandidateAssertions =
    candidateAssertionCount - passedCandidateAssertions;
  const passed = baselineDatasetValid && failedCandidateAssertions === 0;

  return {
    datasetVersion: RECOVERY_QUALIFICATION_DATASET_VERSION,
    datasetDigest: digest,
    mode,
    status: passed ? "passed" : "failed",
    baselineCaseCount: baselineFixtures.length,
    candidateCaseCount: candidateFixtures.length,
    candidateAssertionCount,
    passedCandidateAssertions,
    failedCandidateAssertions,
    regressionCount,
    coverageFailureCount,
    baselineDatasetValid,
    failures,
    failuresTruncated: totalFailures > failures.length,
  };
}
