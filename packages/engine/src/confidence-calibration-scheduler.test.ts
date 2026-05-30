/**
 * Tests for the daily confidence-calibration sweep scheduler. Mocks
 * `./queue` (no real Redis), `@janusly/data/src/confidenceCalibrationRepo`
 * (no DB — the barrel import propagates the mock), and `@janusly/db` (the
 * per-org audit insert path).
 *
 * The actual curve-fit math (sample-size threshold, monotonicity) is
 * covered in `confidence-calibration.test.ts`; here we prove the
 * scheduler's orchestration: per-org isolation, the threshold skip
 * (`fitCalibrationCurve` returning null → no upsert), tenant scope (each
 * org gets its own calibration call), and the never-throws posture.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const insertValuesMock = vi.fn();

vi.mock("./queue", () => ({
  workflowQueue: {
    upsertJobScheduler: vi.fn(),
  },
}));

vi.mock("@janusly/data/src/confidenceCalibrationRepo", () => ({
  DEFAULT_CALIBRATION_WINDOW_DAYS: 30,
  listOrgIdsWithCalibrationEnabled: vi.fn(),
  listCalibratableApproaches: vi.fn(),
  listCalibrationSamples: vi.fn(),
  upsertCalibration: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValuesMock })),
  },
  auditLogs: { id: "id" },
}));

import {
  listCalibratableApproaches,
  listCalibrationSamples,
  listOrgIdsWithCalibrationEnabled,
  upsertCalibration,
} from "@janusly/data/src/confidenceCalibrationRepo";

import {
  CONFIDENCE_CALIBRATION_JOB_ID,
  CONFIDENCE_CALIBRATION_JOB_NAME,
  DEFAULT_CONFIDENCE_CALIBRATION_CRON,
  handleConfidenceCalibrationTrigger,
  registerConfidenceCalibrationScheduler,
  runOrgCalibration,
} from "./confidence-calibration-scheduler";
import { workflowQueue } from "./queue";

const upsertJobSchedulerMock = vi.mocked(workflowQueue.upsertJobScheduler);
const listOrgsMock = vi.mocked(listOrgIdsWithCalibrationEnabled);
const listApproachesMock = vi.mocked(listCalibratableApproaches);
const listSamplesMock = vi.mocked(listCalibrationSamples);
const upsertMock = vi.mocked(upsertCalibration);

/** Build N samples for a given accept rate so the fit clears the threshold. */
function bucketedSamples(): Array<{ rawConfidence: number; accepted: boolean }> {
  const out: Array<{ rawConfidence: number; accepted: boolean }> = [];
  // 20 in a low bucket (20% accept), 20 in a high bucket (80% accept) →
  // positive slope, clears MIN_CALIBRATION_SAMPLES.
  for (let i = 0; i < 20; i += 1) out.push({ rawConfidence: 20, accepted: i < 4 });
  for (let i = 0; i < 20; i += 1) out.push({ rawConfidence: 80, accepted: i < 16 });
  return out;
}

beforeEach(() => {
  upsertJobSchedulerMock.mockReset();
  upsertJobSchedulerMock.mockResolvedValue(undefined as never);
  listOrgsMock.mockReset();
  listApproachesMock.mockReset();
  listSamplesMock.mockReset();
  upsertMock.mockReset().mockResolvedValue(undefined);
  insertValuesMock.mockReset().mockResolvedValue(undefined);
});

describe("registerConfidenceCalibrationScheduler", () => {
  it("registers the daily default cron when env is empty", async () => {
    await expect(registerConfidenceCalibrationScheduler({})).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      CONFIDENCE_CALIBRATION_JOB_ID,
      { pattern: DEFAULT_CONFIDENCE_CALIBRATION_CRON },
      { name: CONFIDENCE_CALIBRATION_JOB_NAME, data: {} },
    );
  });

  it("honours a valid custom cron from env", async () => {
    await registerConfidenceCalibrationScheduler({ JANUSLY_CONFIDENCE_CALIBRATION_CRON: "0 4 * * *" });
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      CONFIDENCE_CALIBRATION_JOB_ID,
      { pattern: "0 4 * * *" },
      expect.anything(),
    );
  });

  it("falls back to the default on an invalid cron (never throws)", async () => {
    await expect(
      registerConfidenceCalibrationScheduler({ JANUSLY_CONFIDENCE_CALIBRATION_CRON: "not a cron" }),
    ).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      CONFIDENCE_CALIBRATION_JOB_ID,
      { pattern: DEFAULT_CONFIDENCE_CALIBRATION_CRON },
      expect.anything(),
    );
  });

  it("returns false (never throws) when upsertJobScheduler rejects", async () => {
    upsertJobSchedulerMock.mockRejectedValueOnce(new Error("redis down"));
    await expect(registerConfidenceCalibrationScheduler({})).resolves.toBe(false);
  });
});

describe("runOrgCalibration — fit + threshold skip", () => {
  it("upserts a curve for an approach with enough samples", async () => {
    listApproachesMock.mockResolvedValue(["add_retry"]);
    listSamplesMock.mockResolvedValue(bucketedSamples());

    const result = await runOrgCalibration("org-1");
    expect(result.fitted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const arg = upsertMock.mock.calls[0]![0];
    expect(arg.orgId).toBe("org-1");
    expect(arg.approachLabel).toBe("add_retry");
    expect(arg.curveSlope).toBeGreaterThan(0);
    expect(arg.sampleSize).toBe(40);
  });

  it("skips (no upsert) when below the sample threshold", async () => {
    listApproachesMock.mockResolvedValue(["fix_url"]);
    // Only 5 samples — fitCalibrationCurve returns null.
    listSamplesMock.mockResolvedValue([
      { rawConfidence: 20, accepted: true },
      { rawConfidence: 80, accepted: false },
      { rawConfidence: 50, accepted: true },
      { rawConfidence: 30, accepted: false },
      { rawConfidence: 70, accepted: true },
    ]);

    const result = await runOrgCalibration("org-1");
    expect(result.fitted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("isolates a per-approach failure so the rest of the org still processes", async () => {
    listApproachesMock.mockResolvedValue(["add_retry", "fix_url"]);
    // First approach: listSamples throws; second: valid samples.
    listSamplesMock
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce(bucketedSamples());

    const result = await runOrgCalibration("org-1");
    expect(result.skipped).toBe(1);
    expect(result.fitted).toBe(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("writes no audit row when there are zero approaches", async () => {
    listApproachesMock.mockResolvedValue([]);
    const result = await runOrgCalibration("org-empty");
    expect(result).toEqual({ fitted: 0, skipped: 0 });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });
});

describe("handleConfidenceCalibrationTrigger — orchestration + tenant scope", () => {
  it("processes each opted-in org independently (tenant scope)", async () => {
    listOrgsMock.mockResolvedValue(["org-a", "org-b"]);
    listApproachesMock.mockResolvedValue(["add_retry"]);
    listSamplesMock.mockResolvedValue(bucketedSamples());

    await handleConfidenceCalibrationTrigger();

    // One sample read + one upsert per org, each scoped to that org.
    expect(listApproachesMock).toHaveBeenCalledWith("org-a", 30);
    expect(listApproachesMock).toHaveBeenCalledWith("org-b", 30);
    const upsertOrgs = upsertMock.mock.calls.map((c) => c[0]!.orgId).sort();
    expect(upsertOrgs).toEqual(["org-a", "org-b"]);
  });

  it("degrades to a warn (never throws) when listing orgs fails", async () => {
    listOrgsMock.mockRejectedValue(new Error("db down"));
    await expect(handleConfidenceCalibrationTrigger()).resolves.toBeUndefined();
    expect(listApproachesMock).not.toHaveBeenCalled();
  });

  it("does nothing when no org has calibratable feedback", async () => {
    listOrgsMock.mockResolvedValue([]);
    await handleConfidenceCalibrationTrigger();
    expect(listApproachesMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
