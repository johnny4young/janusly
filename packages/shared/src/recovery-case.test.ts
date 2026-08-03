import { describe, expect, it } from "vitest";
import {
  buildRecoveryNorthStarSample,
  isLegalRecoveryCaseTransition,
  listLegalRecoveryCaseTransitions,
  RecoveryCaseTransitionReceiptV1Schema,
} from "./recovery-case";

describe("Recovery Case lifecycle", () => {
  it("allows the canonical path and keeps terminal states terminal", () => {
    const path = [
      "detected",
      "contained",
      "diagnosed",
      "candidates_ready",
      "validating",
      "awaiting_approval",
      "publishing",
      "monitoring",
      "verified_recovered",
    ] as const;
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(
        isLegalRecoveryCaseTransition(
          path[index]!,
          path[index + 1]!,
        ),
      ).toBe(true);
    }
    expect(listLegalRecoveryCaseTransitions("verified_recovered")).toEqual(
      [],
    );
    expect(
      isLegalRecoveryCaseTransition("detected", "publishing"),
    ).toBe(false);
  });

  it("requires legal, evidenced transition receipts", () => {
    const receipt = {
      version: "1",
      id: "transition-1",
      caseId: "case-1",
      from: "awaiting_approval",
      to: "publishing",
      actor: { kind: "user", id: "operator-1" },
      occurredAt: "2026-07-27T02:00:00.000Z",
      evidence: [{ kind: "operator_decision", id: "audit-1" }],
    };
    expect(
      RecoveryCaseTransitionReceiptV1Schema.safeParse(receipt).success,
    ).toBe(true);
    expect(
      RecoveryCaseTransitionReceiptV1Schema.safeParse({
        ...receipt,
        to: "verified_recovered",
      }).success,
    ).toBe(false);
    expect(
      RecoveryCaseTransitionReceiptV1Schema.safeParse({
        ...receipt,
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      RecoveryCaseTransitionReceiptV1Schema.safeParse({
        ...receipt,
        actor: { kind: "agent" },
      }).success,
    ).toBe(false);
  });
});

describe("buildRecoveryNorthStarSample", () => {
  it("measures production detection through verified terminal outcome", () => {
    expect(
      buildRecoveryNorthStarSample({
        caseId: "case-1",
        source: "technical_failure",
        verificationKind: "generation_bound_terminal_success",
        runKind: "production",
        outcome: "verified_recovered",
        detectedAt: "2026-07-27T02:00:00.000Z",
        verifiedRecoveredAt: "2026-07-27T02:05:00.000Z",
      }),
    ).toEqual({
      included: true,
      sample: {
        definitionVersion: "1",
        metric: "time_to_verified_recovery",
        caseId: "case-1",
        source: "technical_failure",
        verificationKind: "generation_bound_terminal_success",
        detectedAt: "2026-07-27T02:00:00.000Z",
        verifiedRecoveredAt: "2026-07-27T02:05:00.000Z",
        durationMs: 300_000,
      },
    });
  });

  it("excludes validation, non-recovered outcomes, and invalid clocks", () => {
    const base = {
      caseId: "case-1",
      source: "technical_failure" as const,
      verificationKind: "generation_bound_terminal_success" as const,
      runKind: "production" as const,
      outcome: "verified_recovered" as const,
      detectedAt: "2026-07-27T02:00:00.000Z",
      verifiedRecoveredAt: "2026-07-27T02:05:00.000Z",
    };
    expect(
      buildRecoveryNorthStarSample({
        ...base,
        runKind: "validation",
      }),
    ).toEqual({ included: false, reason: "non_production" });
    expect(
      buildRecoveryNorthStarSample({
        ...base,
        outcome: "accepted_loss",
      }),
    ).toEqual({ included: false, reason: "outcome_not_verified" });
    expect(
      buildRecoveryNorthStarSample({
        ...base,
        verifiedRecoveredAt: "2026-07-27T01:59:59.000Z",
      }),
    ).toEqual({ included: false, reason: "negative_duration" });
  });

  it("keeps a same-timestamp verified recovery as a zero-duration sample", () => {
    expect(
      buildRecoveryNorthStarSample({
        caseId: "case-zero",
        source: "technical_failure",
        verificationKind: "generation_bound_terminal_success",
        runKind: "production",
        outcome: "verified_recovered",
        detectedAt: "2026-07-27T02:00:00.000Z",
        verifiedRecoveredAt: "2026-07-27T02:00:00.000Z",
      }),
    ).toMatchObject({
      included: true,
      sample: { durationMs: 0 },
    });
  });
});
