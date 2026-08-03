import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  dbUpdate,
  dbSet,
  dbWhere,
  dbReturning,
  invalidateRecoveryMetricsCache,
  publishCacheInvalidation,
} = vi.hoisted(() => ({
  dbUpdate: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
  dbReturning: vi.fn(),
  invalidateRecoveryMetricsCache: vi.fn(),
  publishCacheInvalidation: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: { update: dbUpdate },
  deadLetters: { id: "id", orgId: "org_id" },
  recoveryItems: {},
  workflows: {},
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  count: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gt: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  ilike: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  lt: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock("@janusly/data", () => ({ escapeLikePattern: vi.fn() }));
vi.mock("./metrics-cache", () => ({ invalidateRecoveryMetricsCache }));
vi.mock("./cache-invalidation-bus", () => ({ publishCacheInvalidation }));

import { markDeadLetterReplayed, markDeadLetterResolved } from "./dlq";

beforeEach(() => {
  dbReturning.mockReset().mockResolvedValue([{ id: "dl-1" }]);
  dbWhere.mockReturnValue({ returning: dbReturning });
  dbSet.mockReturnValue({ where: dbWhere });
  dbUpdate.mockReturnValue({ set: dbSet });
  invalidateRecoveryMetricsCache.mockReset();
  publishCacheInvalidation.mockReset();
});

describe("dead-letter cache invalidation", () => {
  it.each([
    ["replayed", markDeadLetterReplayed],
    ["resolved", markDeadLetterResolved],
  ] as const)("invalidates local and remote recovery metrics after a %s mutation", async (_status, mark) => {
    await mark("org-1", "dl-1");

    expect(invalidateRecoveryMetricsCache).toHaveBeenCalledWith("org-1");
    expect(publishCacheInvalidation).toHaveBeenCalledWith({ kind: "recovery-metrics", orgId: "org-1" });
  });

  it("does not invalidate metrics when an exact replay receipt loses its conditional update", async () => {
    dbReturning.mockResolvedValueOnce([]);

    await expect(
      markDeadLetterReplayed("org-1", "dl-1", "receipt-1"),
    ).resolves.toBe(false);

    expect(invalidateRecoveryMetricsCache).not.toHaveBeenCalled();
    expect(publishCacheInvalidation).not.toHaveBeenCalled();
  });
});
