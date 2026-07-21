import { describe, expect, it } from "vitest";

import type { RecoveryValidationReport } from "@janusly/data";
import {
  buildRecoveryValidationFilename,
  buildRecoveryValidationMarkdown,
} from "./recovery-validation-report";

const report: RecoveryValidationReport = {
  generatedAt: "2026-07-21T12:00:00.000Z",
  windowDays: 30,
  sampleLimit: 100,
  sampleCapped: false,
  totals: {
    drills: 2,
    completed: 2,
    recovered: 1,
    acceptedLoss: 1,
    awaitingAction: 0,
    replayInProgress: 0,
    measurementIncomplete: 0,
    missingEvidence: 0,
    completionRatePercent: 100,
    recoveryRatePercent: 50,
  },
  resolution: {
    operator: 1,
    automated: 1,
    unknown: 0,
    operatorInterventionRatePercent: 50,
  },
  timing: {
    medianElapsedMs: 60_000,
    p90ElapsedMs: 60_000,
    averageElapsedMs: 60_000,
    p95ElapsedMs: 60_000,
    sampleSize: 1,
  },
  byFailureMode: [{
    key: "worker_stalled",
    total: 2,
    completed: 2,
    recovered: 1,
    acceptedLoss: 1,
    recoveryRatePercent: 50,
  }],
  byRecoveryPath: [{
    key: "stalled_node_reaper",
    total: 2,
    completed: 2,
    recovered: 1,
    acceptedLoss: 1,
    recoveryRatePercent: 50,
  }],
  samples: [{
    runId: "run|1",
    runCreatedAt: "2026-07-21T10:00:00.000Z",
    packId: "incident-triage",
    fixtureId: "worker-interruption",
    failureMode: "worker_stalled",
    recoveryPath: "stalled_node_reaper",
    resolutionMode: "automated",
    outcome: {
      status: "recovered",
      startedAt: "2026-07-21T10:00:00.000Z",
      completedAt: "2026-07-21T10:01:00.000Z",
      elapsedMs: 60_000,
      evidence: "terminal_impact",
      attemptCount: 1,
      latestDeadLetterId: "dlq-1",
      chainCapped: false,
      recurrence: { status: "monitoring", windowEndsAt: "2026-07-28T10:01:00.000Z", recurredAt: null },
    },
  }],
};

describe("recovery validation report downloads", () => {
  it("builds a stable bounded filename", () => {
    expect(buildRecoveryValidationFilename({
      orgId: "org:private-beta",
      windowDays: 30,
      exportedAt: new Date("2026-07-21T12:00:00.000Z"),
      format: "markdown",
    })).toEqual({
      asciiFilename: "janusly-recovery-validation-org-priv-2026-07-21-30d.md",
      utf8Filename: "janusly-recovery-validation-org-priv-2026-07-21-30d.md",
    });
  });

  it("states denominators and external acceptance limits in Markdown", () => {
    const markdown = buildRecoveryValidationMarkdown({ orgId: "org-1", report });

    expect(markdown).toContain("Recovery rate among completed outcomes**: 1/2 (50.0%)");
    expect(markdown).toContain("Operator intervention among known actors**: 50.0%");
    expect(markdown).toContain("recovered outcomes; n=1");
    expect(markdown).toContain("accepted loss is not recovery-time evidence");
    expect(markdown).toContain("does not measure external partner count or setup time");
    expect(markdown).toContain("run\\|1");
    expect(markdown).toContain("Recovery requires an immutable terminal impact event");
  });
});
