/**
 * Deterministic semantic outcome evaluation.
 *
 * This module is pure: it evaluates operator-authored expressions and the
 * shared JSON-value schema subset. It performs no persistence, provider
 * calls, or authorization decisions, so the same evaluator can run at
 * workflow-save time, in tests, and on the worker hot path.
 */

import type {
  RecoveryContract,
  RecoveryContractV2,
  RecoverySemanticDetectorV2,
} from "@janusly/shared";
import { evaluateExpression } from "./expression";
import { validateInputs } from "./inputs-validator";

export type SemanticOutcomeViolation = {
  detectorId: string;
  sourceNodeId: string;
  kind: RecoverySemanticDetectorV2["kind"];
  action: RecoverySemanticDetectorV2["action"];
  message: string;
  details?: readonly string[];
};

export type SemanticOutcomeEvaluation = {
  sourceNodeId: string;
  evaluated: number;
  violations: SemanticOutcomeViolation[];
  quarantined: boolean;
};

export type SemanticOutcomeFixtureResult = {
  id: string;
  sourceNodeId: string;
  expected: "pass" | "violation";
  actual: "pass" | "violation";
  passed: boolean;
  violations: SemanticOutcomeViolation[];
};

function semanticContract(
  contract: RecoveryContract | undefined,
): RecoveryContractV2 | null {
  return contract?.version === "2" ? contract : null;
}

/**
 * Evaluate every detector attached to one just-completed source node.
 *
 * The supplied `context` may be the pre-completion runtime snapshot. The
 * evaluator overlays the exact completed output so expression detectors see
 * the same `context.<node>.output` shape downstream edges will consume.
 */
export function evaluateSemanticOutcome(input: {
  contract?: RecoveryContract;
  sourceNodeId: string;
  output: unknown;
  context?: Record<string, unknown>;
}): SemanticOutcomeEvaluation {
  const contract = semanticContract(input.contract);
  const detectors =
    contract?.failure.semantic.detectors.filter(
      (detector) => detector.sourceNodeId === input.sourceNodeId,
    ) ?? [];
  const existing =
    input.context?.[input.sourceNodeId] &&
    typeof input.context[input.sourceNodeId] === "object" &&
    !Array.isArray(input.context[input.sourceNodeId])
      ? (input.context[input.sourceNodeId] as Record<string, unknown>)
      : {};
  const context = {
    ...(input.context ?? {}),
    [input.sourceNodeId]: {
      ...existing,
      status: "succeeded",
      output: input.output,
    },
  };

  const violations: SemanticOutcomeViolation[] = [];
  for (const detector of detectors) {
    if (detector.kind === "expression") {
      let passed = false;
      let details: readonly string[] | undefined;
      try {
        passed =
          evaluateExpression(detector.passWhen, {
            context,
            inputs: {},
          }) === true;
      } catch (error) {
        details = [
          error instanceof Error
            ? error.message
            : "Expression evaluation failed",
        ];
      }
      if (!passed) {
        violations.push({
          detectorId: detector.id,
          sourceNodeId: detector.sourceNodeId,
          kind: detector.kind,
          action: detector.action,
          message: detector.message,
          ...(details ? { details } : {}),
        });
      }
      continue;
    }

    const result = validateInputs(detector.schema, input.output);
    if (!result.valid) {
      violations.push({
        detectorId: detector.id,
        sourceNodeId: detector.sourceNodeId,
        kind: detector.kind,
        action: detector.action,
        message: detector.message,
        details: result.errors.slice(0, 50),
      });
    }
  }

  return {
    sourceNodeId: input.sourceNodeId,
    evaluated: detectors.length,
    violations,
    quarantined: violations.some(
      (violation) => violation.action === "quarantine",
    ),
  };
}

/** Replay all bounded contract fixtures with the exact runtime evaluator. */
export function evaluateSemanticOutcomeFixtures(
  contract: RecoveryContract,
): SemanticOutcomeFixtureResult[] {
  const semantic = semanticContract(contract)?.failure.semantic;
  if (!semantic) return [];

  return (semantic.evaluationFixtures ?? []).map((fixture) => {
    const evaluation = evaluateSemanticOutcome({
      contract,
      sourceNodeId: fixture.sourceNodeId,
      output: fixture.output,
      context: fixture.context,
    });
    const actual =
      evaluation.violations.length === 0 ? "pass" : "violation";
    return {
      id: fixture.id,
      sourceNodeId: fixture.sourceNodeId,
      expected: fixture.expected,
      actual,
      passed: actual === fixture.expected,
      violations: evaluation.violations,
    };
  });
}
