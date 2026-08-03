import { describe, expect, it } from "vitest";
import type { RecoveryContractV2 } from "@janusly/shared";
import {
  evaluateSemanticOutcome,
  evaluateSemanticOutcomeFixtures,
} from "./semantic-outcomes";

function contract(): RecoveryContractV2 {
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
            id: "mode",
            sourceNodeId: "answer",
            kind: "expression",
            passWhen: 'context.answer.output.mode === "ai"',
            action: "quarantine",
            message: "AI mode is required",
          },
          {
            id: "shape",
            sourceNodeId: "answer",
            kind: "schema",
            schema: {
              type: "object",
              required: ["text"],
              properties: {
                text: { type: "string" },
              },
            },
            action: "observe",
            message: "Text is required",
          },
        ],
        evaluationFixtures: [
          {
            id: "good",
            sourceNodeId: "answer",
            output: { mode: "ai", text: "ready" },
            expected: "pass",
          },
          {
            id: "bad",
            sourceNodeId: "answer",
            output: { mode: "fallback" },
            expected: "violation",
          },
        ],
      },
    },
    evidence: {
      required: [
        "failure_snapshot",
        "audit_trail",
        "validation_receipt",
        "terminal_outcome",
      ],
    },
    effects: [],
    repairs: { allowed: ["retry"] },
    validation: { minimumEvidenceLevel: "writes_skipped" },
    approval: {
      productionMutation: "required",
      permission: "recovery.write",
    },
    autonomyLevel: 3,
    verification: {
      kind: "generation_bound_terminal_success",
    },
    recurrence: { windowDays: 7 },
  };
}

describe("semantic outcome evaluator", () => {
  it("overlays the just-completed output and quarantines only on a failed quarantine detector", () => {
    const good = evaluateSemanticOutcome({
      contract: contract(),
      sourceNodeId: "answer",
      output: { mode: "ai", text: "ready" },
      context: {
        answer: { status: "running", output: {} },
      },
    });
    expect(good).toEqual({
      sourceNodeId: "answer",
      evaluated: 2,
      violations: [],
      quarantined: false,
    });

    const bad = evaluateSemanticOutcome({
      contract: contract(),
      sourceNodeId: "answer",
      output: { mode: "fallback" },
    });
    expect(bad.quarantined).toBe(true);
    expect(bad.violations.map((item) => item.detectorId)).toEqual([
      "mode",
      "shape",
    ]);
  });

  it("replays bounded fixtures through the runtime evaluator", () => {
    expect(evaluateSemanticOutcomeFixtures(contract())).toEqual([
      expect.objectContaining({
        id: "good",
        expected: "pass",
        actual: "pass",
        passed: true,
      }),
      expect.objectContaining({
        id: "bad",
        expected: "violation",
        actual: "violation",
        passed: true,
      }),
    ]);
  });

  it("evaluates an explicit null output without coercing it to an object", () => {
    const nullContract: RecoveryContractV2 = {
      ...contract(),
      failure: {
        ...contract().failure,
        semantic: {
          mode: "deterministic",
          detectors: [
            {
              id: "nullable",
              sourceNodeId: "answer",
              kind: "expression",
              passWhen: "context.answer.output === null",
              action: "quarantine",
              message: "Null is required",
            },
          ],
          evaluationFixtures: [
            {
              id: "null-pass",
              sourceNodeId: "answer",
              output: null,
              expected: "pass",
            },
            {
              id: "object-fail",
              sourceNodeId: "answer",
              output: {},
              expected: "violation",
            },
          ],
        },
      },
    };

    expect(
      evaluateSemanticOutcome({
        contract: nullContract,
        sourceNodeId: "answer",
        output: null,
      }),
    ).toMatchObject({ violations: [], quarantined: false });
  });

  it("leaves v1 contracts and unrelated nodes untouched", () => {
    expect(
      evaluateSemanticOutcome({
        sourceNodeId: "other",
        output: {},
        contract: contract(),
      }),
    ).toEqual({
      sourceNodeId: "other",
      evaluated: 0,
      violations: [],
      quarantined: false,
    });
  });
});
