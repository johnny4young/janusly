/**
 * Cache behavior for `listOrgConfig` — the process-local TTL cache that keeps
 * `getOrgConfigSnapshot` off Postgres on the authenticated hot paths.
 *
 * The DB layer is mocked to a select→from→where→limit chain whose terminal
 * `limit()` resolves the tenant rows; `selectMock` counts how many times a
 * query is actually issued, which is how the cache hit/miss assertions work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { selectMock, rowsRef } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  rowsRef: { rows: [] as unknown[] },
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: () => {
      selectMock();
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(rowsRef.rows),
          }),
        }),
      };
    },
  },
  orgConfigs: { orgId: "org_id", key: "key", id: "id" },
}));

import { invalidateOrgConfigCache, listOrgConfig } from "./orgConfigRepo";

const priorTtl = process.env.JANUSLY_ORG_CONFIG_CACHE_TTL_MS;

beforeEach(() => {
  invalidateOrgConfigCache();
  selectMock.mockClear();
  rowsRef.rows = [];
  delete process.env.JANUSLY_ORG_CONFIG_CACHE_TTL_MS;
});

afterEach(() => {
  vi.useRealTimers();
  if (priorTtl === undefined) delete process.env.JANUSLY_ORG_CONFIG_CACHE_TTL_MS;
  else process.env.JANUSLY_ORG_CONFIG_CACHE_TTL_MS = priorTtl;
});

describe("listOrgConfig cache", () => {
  it("serves the second call within the TTL without touching the DB", async () => {
    await listOrgConfig("org-a");
    expect(selectMock).toHaveBeenCalledTimes(1);
    await listOrgConfig("org-a");
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("re-queries after an explicit invalidation", async () => {
    await listOrgConfig("org-b");
    invalidateOrgConfigCache("org-b");
    await listOrgConfig("org-b");
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("re-queries after the TTL expires", async () => {
    vi.useFakeTimers();
    await listOrgConfig("org-ttl");
    expect(selectMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await listOrgConfig("org-ttl");
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache entirely when TTL is 0", async () => {
    process.env.JANUSLY_ORG_CONFIG_CACHE_TTL_MS = "0";
    await listOrgConfig("org-c");
    await listOrgConfig("org-c");
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache when a caller passes a custom env (test isolation)", async () => {
    const customEnv = { ...process.env } as NodeJS.ProcessEnv;
    await listOrgConfig("org-d", customEnv);
    await listOrgConfig("org-d", customEnv);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest org once the cache cap is exceeded", async () => {
    // Fill past the 1000-org cap; the first org inserted is evicted FIFO, so a
    // re-read of it misses and re-queries.
    for (let i = 0; i < 1001; i++) await listOrgConfig(`cap-org-${i}`);
    selectMock.mockClear();
    await listOrgConfig("cap-org-0");
    expect(selectMock).toHaveBeenCalledTimes(1);
  });
});
