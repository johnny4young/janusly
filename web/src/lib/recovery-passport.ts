/**
 * Deterministic Recovery Passport verdict and factor model.
 *
 * Model confidence is deliberately absent. It remains display-only evidence
 * and can never turn an unavailable, unvalidated, or unsafe candidate into an
 * applicable one.
 */

export type RecoverySandboxStatus =
  | "not_run"
  | "running"
  | "passed"
  | "failed";
export type RecoveryPassportVerdict =
  | "safe_to_apply"
  | "needs_review"
  | "unsafe";
export type RecoveryPassportReason =
  | "suggestion_unavailable"
  | "sandbox_required"
  | "sandbox_running"
  | "sandbox_failed"
  | "write_side_requires_review"
  | "approval_missing"
  | "risk_unknown"
  | "evidence_missing"
  | "sandbox_passed";
export type RecoveryPassportFactorId =
  | "candidate"
  | "sandbox"
  | "effect_risk"
  | "approval"
  | "evidence";
export type RecoveryPassportFactorStatus =
  | "pass"
  | "review"
  | "block";

export type RecoveryPassportFactor = {
  id: RecoveryPassportFactorId;
  status: RecoveryPassportFactorStatus;
  reason: RecoveryPassportReason | null;
};

export type RecoveryPassportEvaluation = {
  verdict: RecoveryPassportVerdict;
  reasons: RecoveryPassportReason[];
  factors: RecoveryPassportFactor[];
};

export function evaluateRecoveryPassport(input: {
  suggestionMode: "ai" | "fallback" | "playbook";
  actionable: boolean;
  safety:
    | {
        writeSide: boolean;
        approvalRequired: boolean;
        approvalPresent: boolean;
      }
    | undefined;
  evidenceCount: number;
  sandboxStatus: RecoverySandboxStatus;
}): RecoveryPassportEvaluation {
  const candidateUnavailable =
    input.suggestionMode === "fallback" || !input.actionable;
  const factors: RecoveryPassportFactor[] = [
    {
      id: "candidate",
      status: candidateUnavailable ? "block" : "pass",
      reason: candidateUnavailable
        ? "suggestion_unavailable"
        : null,
    },
    {
      id: "sandbox",
      status:
        input.sandboxStatus === "failed"
          ? "block"
          : input.sandboxStatus === "passed"
            ? "pass"
            : "review",
      reason:
        input.sandboxStatus === "failed"
          ? "sandbox_failed"
          : input.sandboxStatus === "not_run"
            ? "sandbox_required"
            : input.sandboxStatus === "running"
              ? "sandbox_running"
              : null,
    },
    {
      id: "effect_risk",
      status:
        !input.safety || input.safety.writeSide
          ? "review"
          : "pass",
      reason:
        !input.safety
          ? "risk_unknown"
          : input.safety.writeSide
            ? "write_side_requires_review"
            : null,
    },
    {
      id: "approval",
      status:
        input.safety?.approvalRequired &&
        !input.safety.approvalPresent
          ? "review"
          : "pass",
      reason:
        input.safety?.approvalRequired &&
        !input.safety.approvalPresent
          ? "approval_missing"
          : null,
    },
    {
      id: "evidence",
      status: input.evidenceCount > 0 ? "pass" : "review",
      reason:
        input.evidenceCount > 0 ? null : "evidence_missing",
    },
  ];
  const reasons = factors
    .map((factor) => factor.reason)
    .filter(
      (reason): reason is RecoveryPassportReason => reason !== null,
    );
  const verdict = factors.some((factor) => factor.status === "block")
    ? "unsafe"
    : factors.some((factor) => factor.status === "review")
      ? "needs_review"
      : "safe_to_apply";
  return {
    verdict,
    reasons:
      reasons.length > 0 ? reasons : ["sandbox_passed"],
    factors,
  };
}
