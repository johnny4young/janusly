import { describe, expect, it } from "vitest";

import { evaluateRecoveryPassport } from "./recovery-passport";

describe("evaluateRecoveryPassport", () => {
  it("returns structured passing factors for an evidenced read-side candidate", () => {
    expect(
      evaluateRecoveryPassport({
        suggestionMode: "ai",
        actionable: true,
        safety: {
          writeSide: false,
          approvalRequired: false,
          approvalPresent: false,
        },
        evidenceCount: 2,
        sandboxStatus: "passed",
      }),
    ).toEqual({
      verdict: "safe_to_apply",
      reasons: ["sandbox_passed"],
      factors: [
        { id: "candidate", status: "pass", reason: null },
        { id: "sandbox", status: "pass", reason: null },
        { id: "effect_risk", status: "pass", reason: null },
        { id: "approval", status: "pass", reason: null },
        { id: "evidence", status: "pass", reason: null },
      ],
    });
  });

  it("keeps write-side and missing approval factors reviewable", () => {
    const result = evaluateRecoveryPassport({
      suggestionMode: "playbook",
      actionable: true,
      safety: {
        writeSide: true,
        approvalRequired: true,
        approvalPresent: false,
      },
      evidenceCount: 1,
      sandboxStatus: "passed",
    });
    expect(result.verdict).toBe("needs_review");
    expect(result.reasons).toEqual([
      "write_side_requires_review",
      "approval_missing",
    ]);
    expect(result.factors).toEqual(
      expect.arrayContaining([
        {
          id: "effect_risk",
          status: "review",
          reason: "write_side_requires_review",
        },
        {
          id: "approval",
          status: "review",
          reason: "approval_missing",
        },
      ]),
    );
  });

  it("lets blocking factors dominate review factors", () => {
    const result = evaluateRecoveryPassport({
      suggestionMode: "fallback",
      actionable: false,
      safety: undefined,
      evidenceCount: 0,
      sandboxStatus: "failed",
    });
    expect(result.verdict).toBe("unsafe");
    expect(result.factors.filter((factor) => factor.status === "block"))
      .toEqual([
        {
          id: "candidate",
          status: "block",
          reason: "suggestion_unavailable",
        },
        {
          id: "sandbox",
          status: "block",
          reason: "sandbox_failed",
        },
      ]);
  });
});
