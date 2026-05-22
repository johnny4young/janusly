/**
 * Pure-unit tests for the rate-limiter degradation tracker.
 *
 * Mocks ``@janusly/db`` so no real DB is touched. Asserts the
 * snapshot shape, dedup behavior, recovery path, and the contract
 * that the tracker NEVER throws — limiter fail-open depends on that.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  insertValuesMock: vi.fn(),
  selectFromMock: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: hoisted.insertValuesMock })),
    select: vi.fn(() => ({ from: hoisted.selectFromMock })),
  },
  auditLogs: {
    id: "id_col",
    orgId: "org_id_col",
    action: "action_col",
    metadata: "metadata_col",
    createdAt: "created_at_col",
  },
}));

import {
  _resetRateLimiterDegradationForTests,
  getRateLimiterAdminHealth,
  getRateLimiterPublicHealth,
  recordRateLimiterError,
  recordRateLimiterRecovery,
} from "./rate-limit-degradation";

const insertValuesMock = hoisted.insertValuesMock;
const selectFromMock = hoisted.selectFromMock;

function stubNoExistingAudit() {
  // db.select().from(auditLogs).where(...).limit(1) — chain returns [].
  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn(() => ({ limit }));
  selectFromMock.mockReturnValue({ where });
  return { where, limit };
}

beforeEach(() => {
  _resetRateLimiterDegradationForTests();
  insertValuesMock.mockReset().mockResolvedValue(undefined);
  selectFromMock.mockReset();
});

describe("recordRateLimiterError", () => {
  it("increments the counter and writes a rate_limit.degraded audit row on first error", async () => {
    stubNoExistingAudit();
    await recordRateLimiterError("ai", "org-1", new Error("ECONNREFUSED"));

    const snapshot = getRateLimiterAdminHealth();
    expect(snapshot.healthy).toBe(false);
    expect(snapshot.degradedBuckets).toHaveLength(1);
    expect(snapshot.degradedBuckets[0]).toMatchObject({
      bucket: "ai",
      errorCount: 1,
      lastError: "ECONNREFUSED",
      lastObservedKey: "org-1",
    });
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "system",
        action: "rate_limit.degraded",
        targetType: "rate_limit_bucket",
        targetId: "ai",
        metadata: expect.objectContaining({ bucket: "ai", lastError: "ECONNREFUSED" }),
      }),
    );
  });

  it("dedupes audit rows within the same (bucket, day) tuple", async () => {
    stubNoExistingAudit();
    await recordRateLimiterError("ai", "org-1", new Error("ECONNREFUSED"));
    await recordRateLimiterError("ai", "org-2", new Error("ECONNREFUSED"));
    await recordRateLimiterError("ai", "org-3", new Error("READONLY"));

    // The audit row is written ONCE; the counter still climbs.
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const snapshot = getRateLimiterAdminHealth();
    expect(snapshot.degradedBuckets[0]).toMatchObject({
      bucket: "ai",
      errorCount: 3,
      lastObservedKey: "org-3",
      lastError: "READONLY",
    });
  });

  it("tracks distinct buckets independently", async () => {
    stubNoExistingAudit();
    await recordRateLimiterError("ai", "org-1", new Error("oops"));
    await recordRateLimiterError("email.send", "org-1", new Error("oops"));

    const snapshot = getRateLimiterPublicHealth();
    expect(snapshot.degradedBuckets.map((b) => b.bucket).sort()).toEqual([
      "ai",
      "email.send",
    ]);
    expect(insertValuesMock).toHaveBeenCalledTimes(2);
  });

  it("skips the insert when a prior process replica already wrote today's row", async () => {
    const limit = vi.fn().mockResolvedValue([{ id: "existing-audit-id" }]);
    const where = vi.fn(() => ({ limit }));
    selectFromMock.mockReturnValue({ where });

    await recordRateLimiterError("ai", "org-1", new Error("oops"));
    expect(insertValuesMock).not.toHaveBeenCalled();
    // In-memory state still tracks the error.
    expect(getRateLimiterAdminHealth().degradedBuckets[0]).toMatchObject({
      bucket: "ai",
      errorCount: 1,
    });
  });

  it("never throws even if the audit write fails", async () => {
    selectFromMock.mockImplementation(() => {
      throw new Error("postgres down");
    });
    // Should not throw — the limiter's fail-open invariant depends on this.
    await expect(recordRateLimiterError("ai", "org-1", "boom")).resolves.toBeUndefined();
    // In-memory state still updates so /health stays accurate.
    expect(getRateLimiterAdminHealth().degradedBuckets[0]?.bucket).toBe("ai");
  });
});

describe("recordRateLimiterRecovery", () => {
  it("clears the in-memory state and writes a one-shot recovered audit", async () => {
    stubNoExistingAudit();
    await recordRateLimiterError("ai", "org-1", new Error("oops"));
    insertValuesMock.mockClear();

    await recordRateLimiterRecovery("ai");

    expect(getRateLimiterPublicHealth().healthy).toBe(true);
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "system",
        action: "rate_limit.recovered",
        targetId: "ai",
        metadata: expect.objectContaining({ bucket: "ai", errorCount: 1 }),
      }),
    );
  });

  it("is a no-op on a healthy bucket (no audit, no map mutation)", async () => {
    await recordRateLimiterRecovery("ai");
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(getRateLimiterPublicHealth().healthy).toBe(true);
  });

  it("never throws if the audit write fails", async () => {
    stubNoExistingAudit();
    await recordRateLimiterError("ai", "org-1", "oops");
    insertValuesMock.mockReset();
    insertValuesMock.mockRejectedValueOnce(new Error("postgres down"));

    await expect(recordRateLimiterRecovery("ai")).resolves.toBeUndefined();
    // The in-memory state still clears even when the audit write fails.
    expect(getRateLimiterPublicHealth().healthy).toBe(true);
  });
});

describe("snapshot shape", () => {
  it("public health truncates Redis error strings + lastObservedKey", async () => {
    stubNoExistingAudit();
    await recordRateLimiterError("ai", "org-secret-123", new Error("connection to internal-redis.cluster.local:6379 refused"));
    const publicSnap = getRateLimiterPublicHealth();
    const adminSnap = getRateLimiterAdminHealth();

    // Public surface MUST NOT carry the error text or the key.
    expect("lastError" in publicSnap.degradedBuckets[0]!).toBe(false);
    expect("lastObservedKey" in publicSnap.degradedBuckets[0]!).toBe(false);

    // Admin surface DOES carry them for incident triage.
    expect(adminSnap.degradedBuckets[0]?.lastError).toContain("internal-redis.cluster.local");
    expect(adminSnap.degradedBuckets[0]?.lastObservedKey).toBe("org-secret-123");
  });

  it("public health collapses tenant-chosen MCP aliases and tool names", async () => {
    stubNoExistingAudit();
    await recordRateLimiterError(
      "mcp_client.secret-notion.pages.delete",
      "org-1",
      new Error("connection refused"),
    );

    const publicSnap = getRateLimiterPublicHealth();
    const adminSnap = getRateLimiterAdminHealth();

    expect(publicSnap.degradedBuckets[0]?.bucket).toBe("mcp_client");
    expect(JSON.stringify(publicSnap)).not.toContain("secret-notion");
    expect(JSON.stringify(publicSnap)).not.toContain("pages.delete");
    expect(adminSnap.degradedBuckets[0]?.bucket).toBe("mcp_client.secret-notion.pages.delete");
  });

  it("scrubs known secret shapes from the captured error message", async () => {
    // ioredis can surface adjacent secret material in error
    // chains (a forwarded ``Bearer …`` token from a sidecar, an
    // OpenAI key leaked into a misconfigured logger, etc.). The
    // tracker writes ``lastError`` into ``audit_logs.metadata``
    // directly — without going through ``safePersistPayload`` —
    // so we scrub up-front against the closed catalogue.
    stubNoExistingAudit();
    await recordRateLimiterError(
      "ai",
      "org-1",
      new Error("upstream rejected Bearer abcdef1234567890abcdef1234 — connection refused"),
    );
    const adminSnap = getRateLimiterAdminHealth();
    expect(adminSnap.degradedBuckets[0]?.lastError).not.toContain("Bearer abcdef");
    expect(adminSnap.degradedBuckets[0]?.lastError).toContain("[redacted]");
  });
});
