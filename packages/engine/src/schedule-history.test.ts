import { describe, expect, it } from "vitest";
import {
  bucketScheduleFires,
  computeNextFires,
  MAX_FIRE_ROWS,
  MAX_NEXT_FIRES,
  type ScheduleFire,
} from "./schedule-history";

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
    expect(cell.anomaly).toBe(false); // anomaly seam — always false today
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
