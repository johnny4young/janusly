import { describe, expect, it } from "vitest";
import {
  bucketScheduleFires,
  computeNextFires,
  isAnomalousCell,
  MAX_FIRE_ROWS,
  MAX_NEXT_FIRES,
  SCHEDULE_ANOMALY_BASELINE_MARGIN,
  SCHEDULE_ANOMALY_MIN_FAIL_RATE,
  SCHEDULE_ANOMALY_MIN_SAMPLES,
  type ScheduleFire,
  type ScheduleHeatmapCell,
} from "./schedule-history";

/** Build a heatmap cell for the pure `isAnomalousCell` unit cases. */
function cell(total: number, fail: number): ScheduleHeatmapCell {
  return { dayOfWeek: 1, hour: 9, total, success: total - fail, fail, anomaly: false };
}

/** N fires in one (day, hour) slot with the given status. */
function firesAt(iso: string, count: number, status: string): ScheduleFire[] {
  return Array.from({ length: count }, () => ({ firedAt: iso, status }));
}

describe("bucketScheduleFires", () => {
  it("buckets fires into day-of-week × hour-of-day cells (UTC)", () => {
    // 2024-01-01 is a Monday (UTC dayOfWeek = 1).
    const fires: ScheduleFire[] = [
      { firedAt: "2024-01-01T09:15:00.000Z", status: "succeeded" },
      { firedAt: "2024-01-01T09:45:00.000Z", status: "succeeded" },
      { firedAt: "2024-01-01T09:50:00.000Z", status: "failed" },
    ];
    const grid = bucketScheduleFires(fires);
    expect(grid.cells).toHaveLength(1);
    const cell = grid.cells[0];
    expect(cell.dayOfWeek).toBe(1); // Monday
    expect(cell.hour).toBe(9);
    expect(cell.total).toBe(3);
    expect(cell.success).toBe(2);
    expect(cell.fail).toBe(1);
    expect(cell.anomaly).toBe(false); // 1/3 fail rate is below the 0.5 anomaly floor
    expect(grid.timezone).toBe("UTC");
  });

  it("rolls up totals across cells and separates success / fail / other", () => {
    const fires: ScheduleFire[] = [
      { firedAt: "2024-01-01T09:00:00.000Z", status: "succeeded" },
      { firedAt: "2024-01-02T10:00:00.000Z", status: "failed" },
      { firedAt: "2024-01-03T11:00:00.000Z", status: "cancelled" }, // counts as fail
      { firedAt: "2024-01-04T12:00:00.000Z", status: "running" }, // counts only toward total
      { firedAt: "2024-01-05T13:00:00.000Z", status: null }, // unknown — total only
    ];
    const grid = bucketScheduleFires(fires);
    expect(grid.totalFires).toBe(5);
    expect(grid.totalSuccess).toBe(1);
    expect(grid.totalFail).toBe(2); // failed + cancelled
    // Five distinct (day, hour) buckets.
    expect(grid.cells).toHaveLength(5);
  });

  it("accepts Date instances as well as ISO strings", () => {
    const grid = bucketScheduleFires([
      { firedAt: new Date("2024-01-01T09:00:00.000Z"), status: "succeeded" },
    ]);
    expect(grid.cells).toHaveLength(1);
    expect(grid.cells[0].dayOfWeek).toBe(1);
    expect(grid.cells[0].hour).toBe(9);
  });

  it("returns an empty grid with zeroed totals for empty history", () => {
    const grid = bucketScheduleFires([]);
    expect(grid.cells).toEqual([]);
    expect(grid.totalFires).toBe(0);
    expect(grid.totalSuccess).toBe(0);
    expect(grid.totalFail).toBe(0);
    expect(grid.timezone).toBe("UTC");
  });

  it("drops unparseable timestamps without throwing", () => {
    const grid = bucketScheduleFires([
      { firedAt: "not-a-date", status: "succeeded" },
      { firedAt: "2024-01-01T09:00:00.000Z", status: "succeeded" },
    ]);
    expect(grid.totalFires).toBe(1);
    expect(grid.cells).toHaveLength(1);
  });

  it("orders cells row-major (day, then hour) deterministically", () => {
    const grid = bucketScheduleFires([
      { firedAt: "2024-01-02T05:00:00.000Z", status: "succeeded" }, // Tue 05
      { firedAt: "2024-01-01T23:00:00.000Z", status: "succeeded" }, // Mon 23
      { firedAt: "2024-01-01T01:00:00.000Z", status: "succeeded" }, // Mon 01
    ]);
    expect(grid.cells.map((c) => [c.dayOfWeek, c.hour])).toEqual([
      [1, 1],
      [1, 23],
      [2, 5],
    ]);
  });

  it("defensively caps the input at MAX_FIRE_ROWS", () => {
    const fires: ScheduleFire[] = Array.from({ length: MAX_FIRE_ROWS + 50 }, () => ({
      firedAt: "2024-01-01T09:00:00.000Z",
      status: "succeeded",
    }));
    const grid = bucketScheduleFires(fires);
    expect(grid.totalFires).toBe(MAX_FIRE_ROWS);
  });
});

// Distinct (day, hour) slots used across the anomaly cases.
const MON_02 = "2024-01-01T02:00:00.000Z"; // dayOfWeek 1, hour 2
const TUE_09 = "2024-01-02T09:00:00.000Z";
const WED_09 = "2024-01-03T09:00:00.000Z";
const THU_09 = "2024-01-04T09:00:00.000Z";

describe("bucketScheduleFires — anomaly detection", () => {
  it("flags no cell for a healthy (all-success) schedule", () => {
    const grid = bucketScheduleFires([...firesAt(MON_02, 4, "succeeded"), ...firesAt(TUE_09, 3, "succeeded")]);
    expect(grid.cells.every((c) => !c.anomaly)).toBe(true);
  });

  it("flags only the slot whose failure rate diverges sharply above the baseline", () => {
    // Mon 02 fails 4/4 (rate 1.0); three other slots all succeed → baseline
    // 4/13 ≈ 0.31, so only the bad slot clears the 0.5 floor AND the
    // baseline+0.25 margin.
    const grid = bucketScheduleFires([
      ...firesAt(MON_02, 4, "failed"),
      ...firesAt(TUE_09, 3, "succeeded"),
      ...firesAt(WED_09, 3, "succeeded"),
      ...firesAt(THU_09, 3, "succeeded"),
    ]);
    const anomalies = grid.cells.filter((c) => c.anomaly);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].dayOfWeek).toBe(1);
    expect(anomalies[0].hour).toBe(2);
  });

  it("flags no cell for a uniformly-failing schedule (no slot stands out)", () => {
    // Every slot fails → baseline ≈ 1.0, so no cell can exceed baseline+0.25.
    const grid = bucketScheduleFires([
      ...firesAt(MON_02, 3, "failed"),
      ...firesAt(TUE_09, 3, "failed"),
      ...firesAt(WED_09, 3, "failed"),
    ]);
    expect(grid.totalFail).toBe(9);
    expect(grid.cells.every((c) => !c.anomaly)).toBe(true);
  });

  it("does not flag a bad slot with too few samples to trust", () => {
    // Mon 02 fails 2/2 (rate 1.0) but only 2 fires — below the min-samples gate.
    const grid = bucketScheduleFires([...firesAt(MON_02, 2, "failed"), ...firesAt(TUE_09, 5, "succeeded")]);
    const bad = grid.cells.find((c) => c.dayOfWeek === 1 && c.hour === 2);
    expect(bad?.fail).toBe(2);
    expect(bad?.anomaly).toBe(false);
    expect(grid.cells.every((c) => !c.anomaly)).toBe(true);
  });
});

describe("isAnomalousCell", () => {
  it("exposes the documented tuning constants", () => {
    expect(SCHEDULE_ANOMALY_MIN_SAMPLES).toBe(3);
    expect(SCHEDULE_ANOMALY_MIN_FAIL_RATE).toBe(0.5);
    expect(SCHEDULE_ANOMALY_BASELINE_MARGIN).toBe(0.25);
  });

  it("returns false below the min-samples gate regardless of failure rate", () => {
    expect(isAnomalousCell(cell(2, 2), 0)).toBe(false);
  });

  it("returns true when the cell clears both the fail-rate floor and the baseline margin", () => {
    // 3/4 = 0.75 ≥ 0.5 floor AND ≥ 0.1 + 0.25 margin.
    expect(isAnomalousCell(cell(4, 3), 0.1)).toBe(true);
  });

  it("returns false when the fail rate is below the 0.5 floor", () => {
    // 4/10 = 0.4 < 0.5, even with a zero baseline.
    expect(isAnomalousCell(cell(10, 4), 0)).toBe(false);
  });

  it("returns false when the fail rate does not exceed the baseline by the margin", () => {
    // 6/10 = 0.6 clears the floor but not 0.5 + 0.25 = 0.75.
    expect(isAnomalousCell(cell(10, 6), 0.5)).toBe(false);
  });

  it("treats both thresholds as inclusive at the boundary", () => {
    // 2/4 = 0.5 == floor AND == 0.25 + 0.25 baseline margin.
    expect(isAnomalousCell(cell(4, 2), 0.25)).toBe(true);
  });
});

describe("computeNextFires", () => {
  it("returns the requested number of future ISO timestamps for a daily cron", () => {
    const fires = computeNextFires("0 9 * * *", 5);
    expect(fires).toHaveLength(5);
    for (const iso of fires) {
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
    // Strictly increasing.
    const times = fires.map((iso) => new Date(iso).getTime());
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
    }
  });

  it("clamps the count to [0, MAX_NEXT_FIRES]", () => {
    expect(computeNextFires("0 9 * * *", 0)).toEqual([]);
    expect(computeNextFires("0 9 * * *", -3)).toEqual([]);
    expect(computeNextFires("* * * * *", MAX_NEXT_FIRES + 100)).toHaveLength(MAX_NEXT_FIRES);
  });

  it("degrades to an empty array on a malformed cron expression (never throws)", () => {
    expect(computeNextFires("not a cron", 5)).toEqual([]);
    expect(computeNextFires("", 5)).toEqual([]);
    expect(computeNextFires("   ", 5)).toEqual([]);
    // 6-field / nonsense — cron-parser may accept some extended forms, but
    // a clearly invalid field set must not throw.
    expect(() => computeNextFires("99 99 99 99 99", 5)).not.toThrow();
  });

  it("is DST-safe: a daily 02:30 cron advances by ~24h across a spring-forward boundary", () => {
    // cron-parser resolves wall-clock fields against the host TZ. Regardless
    // of the runner's zone, consecutive daily fires must stay monotonic and
    // never collapse to a duplicate instant or run backwards across the DST
    // transition window — the property that makes cron-parser "DST-safe".
    const fires = computeNextFires("30 2 * * *", MAX_NEXT_FIRES);
    expect(fires.length).toBe(MAX_NEXT_FIRES);
    const times = fires.map((iso) => new Date(iso).getTime());
    for (let i = 1; i < times.length; i += 1) {
      const deltaHours = (times[i] - times[i - 1]) / (1000 * 60 * 60);
      // A daily cron's gap is 24h on normal days, 23h or 25h across a DST
      // transition (depending on direction). It must always be positive and
      // within that band — never 0 (duplicate) or negative (backwards).
      expect(deltaHours).toBeGreaterThan(22);
      expect(deltaHours).toBeLessThan(26);
    }
  });
});
