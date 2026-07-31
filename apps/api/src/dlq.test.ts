import { describe, expect, it } from "vitest";

import {
  buildRecoveryQueuePage,
  decodeRecoveryQueueCursor,
  encodeRecoveryQueueCursor,
  isRecoveryQueueSort,
  parseRecoveryDrillProvenance,
  parseDayRange,
  RECOVERY_QUEUE_SORTS,
  type RecoveryQueueRow,
} from "./dlq";

describe("parseRecoveryDrillProvenance", () => {
  it("returns only the closed public projection", () => {
    expect(parseRecoveryDrillProvenance({
      workflow: { secret: "not-public" },
      drill: {
        kind: "solution_pack_drill",
        packId: "incident-triage",
        fixtureId: "worker_interrupted_during_page",
        failureMode: "worker_stalled",
        recoveryPath: "stalled_node_reaper",
        initiatedAt: "2026-07-20T12:00:00.000Z",
        thresholdMinutes: 60,
      },
    })).toEqual({
      kind: "solution_pack_drill",
      packId: "incident-triage",
      fixtureId: "worker_interrupted_during_page",
      recoveryPath: "stalled_node_reaper",
    });
  });

  it("retains runtime-backed drill provenance without exposing measured internals", () => {
    expect(parseRecoveryDrillProvenance({
      drill: {
        kind: "solution_pack_drill",
        packId: "incident-triage",
        fixtureId: "github_secret_unbound",
        failureMode: "credential_unavailable",
        recoveryPath: "runtime_failure",
        boundary: "worker_dlq",
        attempts: 1,
      },
    })).toEqual({
      kind: "solution_pack_drill",
      packId: "incident-triage",
      fixtureId: "github_secret_unbound",
      recoveryPath: "runtime_failure",
    });
  });

  it("rejects malformed, unknown, and oversized provenance", () => {
    expect(parseRecoveryDrillProvenance(null)).toBeNull();
    expect(parseRecoveryDrillProvenance({ drill: { kind: "operator_input" } })).toBeNull();
    expect(parseRecoveryDrillProvenance({
      drill: {
        kind: "solution_pack_drill",
        packId: "incident-triage",
        fixtureId: "fixture",
        recoveryPath: "future_path",
      },
    })).toBeNull();
    expect(parseRecoveryDrillProvenance({
      drill: {
        kind: "solution_pack_drill",
        packId: "x".repeat(129),
        fixtureId: "fixture",
        recoveryPath: "direct_failure",
      },
    })).toBeNull();
  });
});

describe("parseDayRange", () => {
  it("returns the [start, end) UTC bounds for a valid day", () => {
    const range = parseDayRange("2026-07-06");
    expect(range?.start.toISOString()).toBe("2026-07-06T00:00:00.000Z");
    expect(range?.end.toISOString()).toBe("2026-07-07T00:00:00.000Z");
  });

  it("returns null for malformed or missing input", () => {
    expect(parseDayRange(null)).toBeNull();
    expect(parseDayRange(undefined)).toBeNull();
    expect(parseDayRange("2026-7-6")).toBeNull();
    expect(parseDayRange("not-a-day")).toBeNull();
    expect(parseDayRange("2026-13-40")).toBeNull();
  });
});

// Minimal RecoveryQueueRow fixture — the cursor codec + page builder read only
// id / createdAt / recovery (severity + slaTargetAt), so the rest of the
// dead_letters shape is elided behind the cast.
function mockRow(
  id: string,
  createdAtIso: string,
  recovery?: { severity: string; slaTargetAtIso: string } | null,
): RecoveryQueueRow {
  return {
    id,
    createdAt: new Date(createdAtIso),
    recovery: recovery
      ? { severity: recovery.severity, slaTargetAt: new Date(recovery.slaTargetAtIso) }
      : null,
  } as unknown as RecoveryQueueRow;
}

/** base64url-encode a hand-built payload, to exercise the decoder's guards. */
function rawCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("isRecoveryQueueSort", () => {
  it("accepts every declared sort key", () => {
    for (const sort of RECOVERY_QUEUE_SORTS) {
      expect(isRecoveryQueueSort(sort)).toBe(true);
    }
  });

  it("matches the web SORT_KEYS contract", () => {
    expect([...RECOVERY_QUEUE_SORTS]).toEqual(["newest", "oldest", "severity", "sla"]);
  });

  it("rejects unknown / malformed values", () => {
    for (const bad of ["", "sideways", "createdAt", "SEVERITY", null, undefined, 3]) {
      expect(isRecoveryQueueSort(bad)).toBe(false);
    }
  });
});

describe("recovery-queue cursor codec", () => {
  const createdAt = "2026-06-01T10:00:00.000Z";

  it("round-trips createdAt + id with a null key for newest / oldest", () => {
    for (const sort of ["newest", "oldest"] as const) {
      const cursor = decodeRecoveryQueueCursor(
        encodeRecoveryQueueCursor(sort, mockRow("dl-1", createdAt)),
        sort,
      );
      expect(cursor).not.toBeNull();
      expect(cursor?.id).toBe("dl-1");
      expect(cursor?.createdAt.toISOString()).toBe(createdAt);
      expect(cursor?.key).toBeNull();
    }
  });

  it("carries the severity text as the key for the severity sort", () => {
    const row = mockRow("dl-2", createdAt, { severity: "p1", slaTargetAtIso: createdAt });
    const cursor = decodeRecoveryQueueCursor(encodeRecoveryQueueCursor("severity", row), "severity");
    expect(cursor?.key).toBe("p1");
    expect(cursor?.id).toBe("dl-2");
  });

  it("carries the slaTargetAt ISO as the key for the sla sort", () => {
    const sla = "2026-06-02T12:00:00.000Z";
    const row = mockRow("dl-3", createdAt, { severity: "p2", slaTargetAtIso: sla });
    const cursor = decodeRecoveryQueueCursor(encodeRecoveryQueueCursor("sla", row), "sla");
    expect(cursor?.key).toBe(sla);
    // The key must parse to a real date so the keyset never compares to NaN.
    expect(Number.isNaN(new Date(cursor!.key!).getTime())).toBe(false);
  });

  it("emits a null key for a row with no recovery item (the NULLS-LAST tail)", () => {
    for (const sort of ["severity", "sla"] as const) {
      const cursor = decodeRecoveryQueueCursor(
        encodeRecoveryQueueCursor(sort, mockRow("dl-4", createdAt, null)),
        sort,
      );
      expect(cursor?.key).toBeNull();
    }
  });

  it("returns null for a missing / malformed / non-JSON cursor", () => {
    expect(decodeRecoveryQueueCursor(null, "newest")).toBeNull();
    expect(decodeRecoveryQueueCursor("", "newest")).toBeNull();
    expect(decodeRecoveryQueueCursor("!!!not base64!!!", "newest")).toBeNull();
    expect(decodeRecoveryQueueCursor(rawCursor({ s: "newest" }), "newest")).toBeNull(); // missing c/i
    expect(decodeRecoveryQueueCursor(rawCursor({ s: "newest", c: "nope", i: "x" }), "newest")).toBeNull();
  });

  it("returns null when the cursor's sort differs from the requested sort", () => {
    const encoded = encodeRecoveryQueueCursor("severity", mockRow("dl-5", createdAt, { severity: "p1", slaTargetAtIso: createdAt }));
    expect(decodeRecoveryQueueCursor(encoded, "newest")).toBeNull();
    expect(decodeRecoveryQueueCursor(encoded, "severity")).not.toBeNull();
  });

  it("rejects a corrupt sla key so the keyset never sees an Invalid Date", () => {
    expect(decodeRecoveryQueueCursor(rawCursor({ s: "sla", c: createdAt, i: "x", k: "not-a-date" }), "sla")).toBeNull();
    // The same corrupt key under severity is a valid (text) key — only sla parses it as a date.
    expect(decodeRecoveryQueueCursor(rawCursor({ s: "severity", c: createdAt, i: "x", k: "not-a-date" }), "severity")?.key).toBe("not-a-date");
  });
});

describe("buildRecoveryQueuePage", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      mockRow(`dl-${i}`, new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString()),
    );

  it("trims an over-fetched set to pageSize, flags hasMore, and mints a cursor", () => {
    const page = buildRecoveryQueuePage(rows(4), 3, "newest");
    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(3);
    expect(page.items.map((r) => r.id)).toEqual(["dl-0", "dl-1", "dl-2"]);
    expect(page.nextCursor).not.toBeNull();
    // The cursor names the LAST returned row, not the dropped over-fetch row.
    expect(decodeRecoveryQueueCursor(page.nextCursor, "newest")?.id).toBe("dl-2");
  });

  it("reports no more + a null cursor when the set fits in one page", () => {
    const page = buildRecoveryQueuePage(rows(3), 3, "newest");
    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it("returns a null cursor for an empty result", () => {
    const page = buildRecoveryQueuePage([], 50, "severity");
    expect(page).toEqual({ items: [], hasMore: false, nextCursor: null });
  });
});
