import { describe, expect, it } from "vitest";

import {
  buildRecoveryDrillOutcome,
  type RecoveryDrillOutcomeFacts,
} from "./recoveryDrillOutcomeRepo";

const STARTED = new Date("2026-07-01T10:00:00.000Z");
const NOW = new Date("2026-07-03T10:00:00.000Z");

function facts(overrides: Partial<RecoveryDrillOutcomeFacts> = {}): RecoveryDrillOutcomeFacts {
  return {
    rootCreatedAt: STARTED,
    rootStatus: "open",
    latestDeadLetterId: "dlq-1",
    latestStatus: "open",
    attemptCount: 1,
    chainCapped: false,
    replayStartedAt: null,
    recoveredAt: null,
    acceptedItemAt: null,
    acceptedAuditAt: null,
    recurredAt: null,
    ...overrides,
  };
}

describe("buildRecoveryDrillOutcome", () => {
  it("does not treat replay acceptance as terminal recovery", () => {
    const replayStartedAt = new Date("2026-07-01T10:01:00.000Z");
    expect(buildRecoveryDrillOutcome(facts({
      rootStatus: "replayed",
      latestStatus: "replayed",
      replayStartedAt,
    }), NOW)).toEqual({
      status: "replay_in_progress",
      startedAt: STARTED.toISOString(),
      completedAt: null,
      elapsedMs: null,
      evidence: null,
      attemptCount: 1,
      latestDeadLetterId: "dlq-1",
      chainCapped: false,
      recurrence: {
        status: "not_applicable",
        windowEndsAt: null,
        recurredAt: null,
      },
    });
  });

  it("uses terminal impact for recovery duration and monitors seven-day recurrence", () => {
    const recoveredAt = new Date("2026-07-01T10:04:30.000Z");
    expect(buildRecoveryDrillOutcome(facts({
      rootStatus: "replayed",
      latestStatus: "replayed",
      recoveredAt,
    }), NOW)).toEqual({
      status: "recovered",
      startedAt: STARTED.toISOString(),
      completedAt: recoveredAt.toISOString(),
      elapsedMs: 270_000,
      evidence: "terminal_impact",
      attemptCount: 1,
      latestDeadLetterId: "dlq-1",
      chainCapped: false,
      recurrence: {
        status: "monitoring",
        windowEndsAt: "2026-07-08T10:04:30.000Z",
        recurredAt: null,
      },
    });
  });

  it("prefers stronger terminal recovery evidence over an earlier accepted-loss click", () => {
    const recoveredAt = new Date("2026-07-01T10:05:00.000Z");
    const acceptedAt = new Date("2026-07-01T10:02:00.000Z");
    const result = buildRecoveryDrillOutcome(facts({
      rootStatus: "resolved",
      latestStatus: "resolved",
      recoveredAt,
      acceptedItemAt: acceptedAt,
    }), NOW);
    expect(result).toMatchObject({
      status: "recovered",
      completedAt: recoveredAt.toISOString(),
      elapsedMs: 300_000,
      evidence: "terminal_impact",
    });
  });

  it("uses the earliest explicit-resolution fact as accepted-loss duration", () => {
    const itemAt = new Date("2026-07-01T10:03:00.000Z");
    const auditAt = new Date("2026-07-01T10:02:30.000Z");
    expect(buildRecoveryDrillOutcome(facts({
      rootStatus: "resolved",
      latestStatus: "resolved",
      acceptedItemAt: itemAt,
      acceptedAuditAt: auditAt,
    }), NOW)).toMatchObject({
      status: "accepted_loss",
      completedAt: auditAt.toISOString(),
      elapsedMs: 150_000,
      evidence: "explicit_resolution",
      recurrence: { status: "not_applicable" },
    });
  });

  it("marks recurrence immediately and clears only after the full observation window", () => {
    const recoveredAt = new Date("2026-07-01T10:00:30.000Z");
    const recurredAt = new Date("2026-07-02T10:00:30.000Z");
    const recurred = buildRecoveryDrillOutcome(facts({ recoveredAt, recurredAt }), NOW);
    expect(recurred.recurrence).toEqual({
      status: "recurred",
      windowEndsAt: "2026-07-08T10:00:30.000Z",
      recurredAt: recurredAt.toISOString(),
    });

    const clear = buildRecoveryDrillOutcome(
      facts({ recoveredAt, recurredAt: null }),
      new Date("2026-07-08T10:00:30.000Z"),
    );
    expect(clear.recurrence.status).toBe("clear");
  });

  it("keeps a new open chain member actionable after a failed replay", () => {
    const result = buildRecoveryDrillOutcome(facts({
      rootStatus: "replayed",
      latestDeadLetterId: "dlq-2",
      latestStatus: "open",
      attemptCount: 2,
      replayStartedAt: new Date("2026-07-01T10:01:00.000Z"),
    }), NOW);
    expect(result).toMatchObject({
      status: "awaiting_action",
      attemptCount: 2,
      latestDeadLetterId: "dlq-2",
      evidence: null,
    });
  });

  it("does not let resolving an older attempt hide a newer open chain member", () => {
    const result = buildRecoveryDrillOutcome(facts({
      rootStatus: "resolved",
      latestDeadLetterId: "dlq-2",
      latestStatus: "open",
      attemptCount: Number.NaN,
      replayStartedAt: new Date("2026-07-01T10:01:00.000Z"),
      acceptedAuditAt: new Date("2026-07-01T10:02:00.000Z"),
    }), NOW);
    expect(result).toMatchObject({
      status: "awaiting_action",
      attemptCount: 1,
      latestDeadLetterId: "dlq-2",
      completedAt: null,
      evidence: null,
    });
  });

  it("refuses to claim an outcome when the bounded replay chain is incomplete", () => {
    const result = buildRecoveryDrillOutcome(facts({
      chainCapped: true,
      rootStatus: "replayed",
      latestStatus: "replayed",
      attemptCount: 100,
      recoveredAt: new Date("2026-07-01T10:05:00.000Z"),
    }), NOW);
    expect(result).toMatchObject({
      status: "measurement_incomplete",
      chainCapped: true,
      completedAt: null,
      elapsedMs: null,
      evidence: null,
      recurrence: { status: "not_applicable" },
    });
  });
});
