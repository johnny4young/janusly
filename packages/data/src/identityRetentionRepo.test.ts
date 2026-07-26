import { beforeEach, describe, expect, it, vi } from "vitest";

const dbExecute = vi.fn();

vi.mock("@janusly/db", () => ({
  db: { execute: (...args: unknown[]) => dbExecute(...args) },
  authSessions: { id: "id", expiresAt: "expires_at", revokedAt: "revoked_at" },
  ssoStateNonces: { id: "id", expiresAt: "expires_at" },
}));

import { pruneIdentityState } from "./identityRetentionRepo";

function rows(count: number): Array<{ id: string }> {
  return Array.from({ length: count }, (_, index) => ({ id: String(index) }));
}

beforeEach(() => dbExecute.mockReset());

describe("pruneIdentityState", () => {
  it("purges browser sessions and expired one-time nonces", async () => {
    dbExecute.mockResolvedValueOnce(rows(3)).mockResolvedValueOnce(rows(2));
    const result = await pruneIdentityState({
      sessionOlderThan: new Date("2026-07-01T00:00:00.000Z"),
      nonceExpiredBefore: new Date("2026-07-22T00:00:00.000Z"),
    });
    expect(result).toMatchObject({
      sessionsDeleted: 3,
      noncesDeleted: 2,
      sessionCutoffAt: "2026-07-01T00:00:00.000Z",
      nonceCutoffAt: "2026-07-22T00:00:00.000Z",
      cappedByMaxBatches: false,
    });
    expect(dbExecute).toHaveBeenCalledTimes(2);
  });

  it("bounds each table independently and reports a capped sweep", async () => {
    dbExecute
      .mockResolvedValueOnce(rows(2))
      .mockResolvedValueOnce(rows(2))
      .mockResolvedValueOnce(rows(1));
    const result = await pruneIdentityState({
      sessionOlderThan: new Date("2026-07-01T00:00:00.000Z"),
      batchSize: 2,
      maxBatches: 2,
    });
    expect(result.sessionsDeleted).toBe(4);
    expect(result.noncesDeleted).toBe(1);
    expect(result.cappedByMaxBatches).toBe(true);
    expect(dbExecute).toHaveBeenCalledTimes(3);
  });
});
