import { describe, expect, it } from "vitest";

import type { RecoveryDrillOutcome } from "./recoveryDrillOutcomeRepo";
import {
  buildRecoveryValidationReport,
  type RecoveryValidationResolutionMode,
  type RecoveryValidationSample,
} from "./recoveryValidationRepo";

const GENERATED_AT = new Date("2026-07-21T12:00:00.000Z");

function outcome(
  status: RecoveryDrillOutcome["status"],
  elapsedMs: number | null,
): RecoveryDrillOutcome {
  const completed = status === "recovered" || status === "accepted_loss";
  return {
    status,
    startedAt: "2026-07-21T10:00:00.000Z",
    completedAt: completed ? "2026-07-21T10:01:00.000Z" : null,
    elapsedMs,
    evidence: status === "recovered"
      ? "terminal_impact"
      : status === "accepted_loss"
        ? "explicit_resolution"
        : null,
    attemptCount: 1,
    latestDeadLetterId: `dlq-${status}`,
    chainCapped: status === "measurement_incomplete",
    recurrence: {
      status: status === "recovered" ? "monitoring" : "not_applicable",
      windowEndsAt: status === "recovered" ? "2026-07-28T10:01:00.000Z" : null,
      recurredAt: null,
    },
  };
}

function sample(args: {
  id: string;
  status?: RecoveryDrillOutcome["status"];
  elapsedMs?: number | null;
  resolutionMode?: RecoveryValidationResolutionMode;
  failureMode?: string;
  recoveryPath?: string;
}): RecoveryValidationSample {
  return {
    runId: `run-${args.id}`,
    runCreatedAt: `2026-07-21T10:00:${args.id.padStart(2, "0")}.000Z`,
    packId: "incident-triage",
    fixtureId: `fixture-${args.id}`,
    failureMode: args.failureMode ?? "upstream_unavailable",
    recoveryPath: args.recoveryPath ?? "direct_failure",
    resolutionMode: args.resolutionMode ?? "unknown",
    outcome: args.status ? outcome(args.status, args.elapsedMs ?? null) : null,
  };
}

describe("buildRecoveryValidationReport", () => {
  it("keeps completion, recovery, intervention, and timing denominators explicit", () => {
    const report = buildRecoveryValidationReport({
      generatedAt: GENERATED_AT,
      windowDays: 30,
      samples: [
        sample({ id: "1", status: "recovered", elapsedMs: 60_000, resolutionMode: "automated" }),
        sample({ id: "2", status: "recovered", elapsedMs: 120_000, resolutionMode: "operator" }),
        sample({ id: "3", status: "accepted_loss", elapsedMs: 180_000, resolutionMode: "operator" }),
        sample({ id: "4", status: "awaiting_action" }),
        sample({ id: "5", status: "replay_in_progress" }),
        sample({ id: "6", status: "measurement_incomplete" }),
        sample({ id: "7" }),
      ],
    });

    expect(report).toMatchObject({
      generatedAt: GENERATED_AT.toISOString(),
      windowDays: 30,
      sampleLimit: 100,
      sampleCapped: false,
      totals: {
        drills: 7,
        completed: 3,
        recovered: 2,
        acceptedLoss: 1,
        awaitingAction: 1,
        replayInProgress: 1,
        measurementIncomplete: 1,
        missingEvidence: 1,
        completionRatePercent: 42.9,
        recoveryRatePercent: 66.7,
      },
      resolution: {
        operator: 2,
        automated: 1,
        unknown: 0,
        operatorInterventionRatePercent: 66.7,
      },
      timing: {
        medianElapsedMs: 90_000,
        p90ElapsedMs: 120_000,
        averageElapsedMs: 90_000,
        p95ElapsedMs: 120_000,
        sampleSize: 2,
      },
    });
  });

  it("never treats accepted loss as recovery-time evidence", () => {
    const report = buildRecoveryValidationReport({
      generatedAt: GENERATED_AT,
      windowDays: 30,
      samples: [
        sample({ id: "1", status: "accepted_loss", elapsedMs: 15_000, resolutionMode: "operator" }),
      ],
    });

    expect(report.totals.completed).toBe(1);
    expect(report.totals.recoveryRatePercent).toBe(0);
    expect(report.timing).toEqual({
      medianElapsedMs: null,
      p90ElapsedMs: null,
      averageElapsedMs: null,
      p95ElapsedMs: null,
      sampleSize: 0,
    });
  });

  it("returns null rates instead of inventing zero-percent evidence", () => {
    const report = buildRecoveryValidationReport({
      generatedAt: GENERATED_AT,
      windowDays: 0,
      samples: [sample({ id: "1", status: "awaiting_action" })],
    });

    expect(report.windowDays).toBe(1);
    expect(report.totals.completionRatePercent).toBe(0);
    expect(report.totals.recoveryRatePercent).toBeNull();
    expect(report.resolution.operatorInterventionRatePercent).toBeNull();
    expect(report.timing).toEqual({
      medianElapsedMs: null,
      p90ElapsedMs: null,
      averageElapsedMs: null,
      p95ElapsedMs: null,
      sampleSize: 0,
    });
  });

  it("groups failure modes and recovery paths without conflating pending drills", () => {
    const report = buildRecoveryValidationReport({
      generatedAt: GENERATED_AT,
      windowDays: 30,
      samples: [
        sample({ id: "1", status: "recovered", failureMode: "worker_stalled", recoveryPath: "stalled_node_reaper" }),
        sample({ id: "2", status: "accepted_loss", failureMode: "worker_stalled", recoveryPath: "stalled_node_reaper" }),
        sample({ id: "3", status: "awaiting_action", failureMode: "credential_expired" }),
      ],
    });

    expect(report.byFailureMode).toEqual([
      {
        key: "worker_stalled",
        total: 2,
        completed: 2,
        recovered: 1,
        acceptedLoss: 1,
        recoveryRatePercent: 50,
      },
      {
        key: "credential_expired",
        total: 1,
        completed: 0,
        recovered: 0,
        acceptedLoss: 0,
        recoveryRatePercent: null,
      },
    ]);
    expect(report.byRecoveryPath[0]).toMatchObject({
      key: "stalled_node_reaper",
      total: 2,
      completed: 2,
      recoveryRatePercent: 50,
    });
  });

  it("caps output samples even when an upstream caller passes more than the contract limit", () => {
    const samples = Array.from({ length: 101 }, (_, index) => sample({
      id: String(index),
      status: "recovered",
      elapsedMs: index * 1_000,
      resolutionMode: "automated",
    }));
    const report = buildRecoveryValidationReport({
      generatedAt: GENERATED_AT,
      windowDays: 180,
      samples,
    });

    expect(report.windowDays).toBe(90);
    expect(report.sampleCapped).toBe(true);
    expect(report.samples).toHaveLength(100);
    expect(report.totals.drills).toBe(100);
  });
});
