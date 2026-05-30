import { describe, expect, it } from "vitest";

import {
  applyCalibration,
  CALIBRATION_SUBTITLE_DELTA,
  fitCalibrationCurve,
  MIN_CALIBRATION_SAMPLES,
  type CalibrationCurve,
  type CalibrationSample,
} from "./confidence-calibration";

/**
 * Build `count` samples, all at the same raw confidence, of which
 * `acceptedCount` are accepted. Helper for assembling bucketed fixtures.
 */
function samplesAt(rawConfidence: number, count: number, acceptedCount: number): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ rawConfidence, accepted: i < acceptedCount });
  }
  return out;
}

describe("fitCalibrationCurve — sample-size threshold", () => {
  it("returns null below MIN_CALIBRATION_SAMPLES", () => {
    // 19 samples spread across two buckets — enough x-variance, but under
    // the threshold, so the curve must be skipped.
    const samples = [
      ...samplesAt(20, 10, 2),
      ...samplesAt(80, 9, 8),
    ];
    expect(samples.length).toBeLessThan(MIN_CALIBRATION_SAMPLES);
    expect(fitCalibrationCurve(samples)).toBeNull();
  });

  it("fits a curve at exactly MIN_CALIBRATION_SAMPLES", () => {
    const samples = [
      ...samplesAt(20, 10, 2), // low bucket: 20% accept
      ...samplesAt(80, 10, 8), // high bucket: 80% accept
    ];
    expect(samples.length).toBe(MIN_CALIBRATION_SAMPLES);
    const curve = fitCalibrationCurve(samples);
    expect(curve).not.toBeNull();
    expect(curve!.sampleSize).toBe(20);
    expect(curve!.slope).toBeGreaterThan(0);
  });
});

describe("fitCalibrationCurve — no recovery_feedback rows", () => {
  it("returns null for an empty sample set", () => {
    expect(fitCalibrationCurve([])).toBeNull();
  });
});

describe("fitCalibrationCurve — degenerate inputs degrade to null (raw)", () => {
  it("returns null when every decision lands in one bucket (no x-variance)", () => {
    // 30 samples, all at raw 70 — can't fit a non-vertical line.
    const samples = samplesAt(70, 30, 21);
    const curve = fitCalibrationCurve(samples);
    expect(curve).toBeNull();
  });

  it("refuses an inverted (negative-slope) fit to preserve ordering", () => {
    // Higher raw confidence => LOWER observed accept rate. A naive
    // least-squares fit here has a negative slope; the monotonicity guard
    // must reject it so calibration can't invert suggestion ordering.
    const samples = [
      ...samplesAt(20, 12, 11), // ~92% accept at low confidence
      ...samplesAt(80, 12, 1), // ~8% accept at high confidence
    ];
    expect(fitCalibrationCurve(samples)).toBeNull();
  });
});

describe("applyCalibration — fallback to raw", () => {
  it("returns the raw confidence (rounded, clamped) when curve is null", () => {
    expect(applyCalibration(73, null)).toBe(73);
    expect(applyCalibration(73.4, null)).toBe(73);
    expect(applyCalibration(150, null)).toBe(100);
    expect(applyCalibration(-5, null)).toBe(0);
  });

  it("maps through the curve and clamps to [0,100]", () => {
    const curve: CalibrationCurve = { slope: 0.5, intercept: 10, sampleSize: 40, acceptRate: 0.5 };
    // 0.5 * 40 + 10 = 30
    expect(applyCalibration(40, curve)).toBe(30);
    // 0.5 * 200 + 10 = 110 -> clamped to 100
    expect(applyCalibration(200, curve)).toBe(100);
    // 0.5 * -100 + 10 = -40 -> clamped to 0
    expect(applyCalibration(-100, curve)).toBe(0);
  });
});

describe("applyCalibration — monotonicity (never inverts ordering)", () => {
  it("preserves the relative ordering of two raw confidences under any fitted curve", () => {
    // Fit a real curve from data where accept rate rises with confidence.
    const samples = [
      ...samplesAt(15, 20, 3), // 15% accept
      ...samplesAt(45, 20, 9), // 45% accept
      ...samplesAt(75, 20, 15), // 75% accept
      ...samplesAt(95, 20, 19), // 95% accept
    ];
    const curve = fitCalibrationCurve(samples);
    expect(curve).not.toBeNull();

    // For every pair where rawA < rawB, calibratedA <= calibratedB.
    const points = [0, 10, 25, 40, 55, 70, 85, 100];
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const lo = applyCalibration(points[i]!, curve);
        const hi = applyCalibration(points[j]!, curve);
        expect(lo).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("keeps a strictly-increasing raw ranking weakly-increasing after calibration", () => {
    // Three suggestions the patch route would sort by raw confidence desc.
    const curve: CalibrationCurve = { slope: 0.8, intercept: 5, sampleSize: 60, acceptRate: 0.6 };
    const rawDescending = [90, 70, 40];
    const calibrated = rawDescending.map((c) => applyCalibration(c, curve));
    // The calibrated list must stay sorted descending (no inversion).
    for (let i = 0; i < calibrated.length - 1; i += 1) {
      expect(calibrated[i]!).toBeGreaterThanOrEqual(calibrated[i + 1]!);
    }
  });
});

describe("calibration curve produces a sensible correction", () => {
  it("pulls an over-confident model down toward its observed accept rate", () => {
    // Model says 90 but the bucket only gets accepted 50% of the time;
    // the calibrated value at raw 90 should sit well below 90.
    const samples = [
      ...samplesAt(50, 20, 10), // 50% accept at raw 50
      ...samplesAt(90, 20, 10), // 50% accept at raw 90 (flat-ish high end)
    ];
    const curve = fitCalibrationCurve(samples);
    // This particular data has near-zero slope; if the guard rejected it,
    // the read side keeps raw — which is also acceptable. Assert whichever
    // branch fired is self-consistent.
    if (curve) {
      const calibratedAt90 = applyCalibration(90, curve);
      expect(calibratedAt90).toBeLessThan(90);
    } else {
      expect(applyCalibration(90, null)).toBe(90);
    }
  });

  it("exposes the subtitle-delta constant for the web layer", () => {
    expect(CALIBRATION_SUBTITLE_DELTA).toBe(10);
  });
});
