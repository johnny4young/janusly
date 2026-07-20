/**
 * Pure-unit tests for the consent-revocation bulk-purge scheduler.
 *
 * Mocks `./queue` (so no real Redis / BullMQ instance is needed) and
 * `@janusly/data/src/orgConfigRepo` + `@janusly/data/src/memoryEntriesRepo`
 * (so no DB is hit). Asserts:
 *   - default delay when env is empty
 *   - env override via JANUSLY_MEMORY_PURGE_DELAY_MS
 *   - malformed env warn-logs + falls back to default
 *   - schedule removes any existing job FIRST, then adds (rapid
 *     revoke-grant-revoke convergence)
 *   - schedule never throws when workflowQueue.add rejects (Redis down)
 *   - cancel returns true on found+removed, false on not-found
 *   - handler purges when memory.enabled === false at fire time
 *   - handler SKIPS the purge when memory.enabled === true at fire
 *     time (defense-in-depth on failed cancellation)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./queue", () => ({
  workflowQueue: {
    add: vi.fn(),
    getJob: vi.fn(),
  },
}));

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: vi.fn(),
}));

vi.mock("@janusly/data/src/memoryEntriesRepo", () => ({
  purgeMemoryForOrg: vi.fn(),
}));

import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";
import { purgeMemoryForOrg } from "@janusly/data/src/memoryEntriesRepo";

import {
  buildMemoryPurgeJobId,
  cancelPendingMemoryPurge,
  DEFAULT_MEMORY_PURGE_DELAY_MS,
  getMemoryPurgeStatus,
  handleMemoryBulkPurgeTrigger,
  MEMORY_BULK_PURGE_JOB_NAME,
  MEMORY_PURGE_QUEUE_TIMEOUT_MS,
  schedulePendingMemoryPurge,
} from "./memory-purge-scheduler";
import { workflowQueue } from "./queue";

const addMock = vi.mocked(workflowQueue.add);
const getJobMock = vi.mocked(workflowQueue.getJob);
const getOrgConfigSnapshotMock = vi.mocked(getOrgConfigSnapshot);
const purgeMemoryForOrgMock = vi.mocked(purgeMemoryForOrg);

function memorySnapshot(memoryEnabled: boolean) {
  // The org-config snapshot has many branches; tests only consume
  // `.memory.enabled`, so the cast is intentional.
  return { memory: { enabled: memoryEnabled } } as never;
}

beforeEach(() => {
  addMock.mockReset();
  addMock.mockResolvedValue(undefined as never);
  getJobMock.mockReset();
  getJobMock.mockResolvedValue(null as never);
  getOrgConfigSnapshotMock.mockReset();
  purgeMemoryForOrgMock.mockReset();
  purgeMemoryForOrgMock.mockResolvedValue({ entriesPurged: 0, kindsAffected: [] });
});

describe("buildMemoryPurgeJobId", () => {
  it("builds a bounded deterministic custom id without BullMQ-reserved colons", () => {
    const first = buildMemoryPurgeJobId("provider:org/with unsafe characters");
    expect(first).toBe(buildMemoryPurgeJobId("provider:org/with unsafe characters"));
    expect(first).not.toContain(":");
    expect(first).toMatch(/^memory-purge-[a-f0-9]{64}$/);
    expect(first).not.toBe(buildMemoryPurgeJobId("another-org"));
  });
});

describe("schedulePendingMemoryPurge", () => {
  it("schedules with the default 7-day delay when env is empty", async () => {
    await expect(
      schedulePendingMemoryPurge({ orgId: "org-1", env: {} }),
    ).resolves.toBe(true);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      MEMORY_BULK_PURGE_JOB_NAME,
      { orgId: "org-1" },
      expect.objectContaining({
        delay: DEFAULT_MEMORY_PURGE_DELAY_MS,
        jobId: buildMemoryPurgeJobId("org-1"),
        attempts: 1,
      }),
    );
  });

  it("respects the env override when JANUSLY_MEMORY_PURGE_DELAY_MS is set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        schedulePendingMemoryPurge({
          orgId: "org-1",
          env: { JANUSLY_MEMORY_PURGE_DELAY_MS: "5000" },
        }),
      ).resolves.toBe(true);
      expect(addMock).toHaveBeenCalledWith(
        MEMORY_BULK_PURGE_JOB_NAME,
        { orgId: "org-1" },
        expect.objectContaining({ delay: 5000 }),
      );
      // Non-default delays surface a warn log so operators see the
      // configured value.
      const nonDefaultLog = warn.mock.calls.find((call) =>
        String(call[0]).includes("non-default delay"),
      );
      expect(nonDefaultLog).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("warn-logs and falls back to the default when env carries a malformed delay", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        schedulePendingMemoryPurge({
          orgId: "org-1",
          env: { JANUSLY_MEMORY_PURGE_DELAY_MS: "not-a-number" },
        }),
      ).resolves.toBe(true);
      const invalidLog = warn.mock.calls.find((call) =>
        String(call[0]).includes("JANUSLY_MEMORY_PURGE_DELAY_MS invalid"),
      );
      expect(invalidLog).toBeDefined();
      expect(addMock).toHaveBeenCalledWith(
        MEMORY_BULK_PURGE_JOB_NAME,
        { orgId: "org-1" },
        expect.objectContaining({ delay: DEFAULT_MEMORY_PURGE_DELAY_MS }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("removes a pre-existing job FIRST before adding the new one (rapid revoke-grant-revoke)", async () => {
    const removeMock = vi.fn().mockResolvedValue(undefined);
    // Simulate an existing job with the same deterministic id.
    getJobMock.mockResolvedValueOnce({ remove: removeMock } as never);

    await expect(
      schedulePendingMemoryPurge({ orgId: "org-1", env: {} }),
    ).resolves.toBe(true);

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledTimes(1);
    // Ordering: remove fires before add.
    const removeOrder = removeMock.mock.invocationCallOrder[0]!;
    const addOrder = addMock.mock.invocationCallOrder[0]!;
    expect(removeOrder).toBeLessThan(addOrder);
  });

  it("never throws when workflowQueue.add rejects (Redis down, returns false)", async () => {
    addMock.mockRejectedValueOnce(new Error("redis down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        schedulePendingMemoryPurge({ orgId: "org-1", env: {} }),
      ).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns false when workflowQueue.add never settles (bounded Redis outage)", async () => {
    vi.useFakeTimers();
    addMock.mockReturnValueOnce(new Promise(() => {}) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = schedulePendingMemoryPurge({ orgId: "org-1", env: {} });
      await vi.advanceTimersByTimeAsync(MEMORY_PURGE_QUEUE_TIMEOUT_MS);
      await expect(pending).resolves.toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("cancelPendingMemoryPurge", () => {
  it("returns true when the job exists and gets removed", async () => {
    const removeMock = vi.fn().mockResolvedValue(undefined);
    getJobMock.mockResolvedValueOnce({ remove: removeMock } as never);

    await expect(
      cancelPendingMemoryPurge({ orgId: "org-1" }),
    ).resolves.toBe(true);
    expect(getJobMock).toHaveBeenCalledWith(buildMemoryPurgeJobId("org-1"));
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it("returns false when no pending job exists for the org", async () => {
    getJobMock.mockResolvedValueOnce(null as never);

    await expect(
      cancelPendingMemoryPurge({ orgId: "org-1" }),
    ).resolves.toBe(false);
  });

  it("returns false when workflowQueue.getJob never settles (bounded Redis outage)", async () => {
    vi.useFakeTimers();
    getJobMock.mockReturnValueOnce(new Promise(() => {}) as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pending = cancelPendingMemoryPurge({ orgId: "org-1" });
      await vi.advanceTimersByTimeAsync(MEMORY_PURGE_QUEUE_TIMEOUT_MS);
      await expect(pending).resolves.toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("getMemoryPurgeStatus", () => {
  it("returns the scheduled timestamp for a delayed purge", async () => {
    getJobMock.mockResolvedValueOnce({
      timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      delay: 5_000,
      getState: vi.fn().mockResolvedValue("delayed"),
    } as never);

    await expect(getMemoryPurgeStatus({ orgId: "org-1" })).resolves.toEqual({
      status: "scheduled",
      scheduledFor: "2026-01-01T00:00:05.000Z",
    });
  });

  it("distinguishes an active purge from completed and absent jobs", async () => {
    getJobMock
      .mockResolvedValueOnce({
        timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        delay: 5_000,
        getState: vi.fn().mockResolvedValue("active"),
      } as never)
      .mockResolvedValueOnce({
        timestamp: Date.now(),
        delay: 0,
        getState: vi.fn().mockResolvedValue("completed"),
      } as never)
      .mockResolvedValueOnce(null as never);

    await expect(getMemoryPurgeStatus({ orgId: "org-1" })).resolves.toMatchObject({ status: "running" });
    await expect(getMemoryPurgeStatus({ orgId: "org-1" })).resolves.toEqual({ status: "none", scheduledFor: null });
    await expect(getMemoryPurgeStatus({ orgId: "org-1" })).resolves.toEqual({ status: "none", scheduledFor: null });
  });

  it("degrades to unknown when Redis state cannot be read", async () => {
    getJobMock.mockRejectedValueOnce(new Error("redis down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(getMemoryPurgeStatus({ orgId: "org-1" })).resolves.toEqual({
        status: "unknown",
        scheduledFor: null,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("handleMemoryBulkPurgeTrigger", () => {
  it("calls purgeMemoryForOrg when memory.enabled === false at fire time", async () => {
    getOrgConfigSnapshotMock.mockResolvedValueOnce(memorySnapshot(false));
    purgeMemoryForOrgMock.mockResolvedValueOnce({
      entriesPurged: 42,
      kindsAffected: ["recovery_rationale"],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await handleMemoryBulkPurgeTrigger({ orgId: "org-revoked" });
      expect(purgeMemoryForOrgMock).toHaveBeenCalledWith("org-revoked");
      expect(logSpy.mock.calls[0]?.[0]).toMatch(/purged 42 entries/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("SKIPS the purge when memory.enabled === true at fire time (consent re-granted, defense-in-depth)", async () => {
    getOrgConfigSnapshotMock.mockResolvedValueOnce(memorySnapshot(true));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await handleMemoryBulkPurgeTrigger({ orgId: "org-re-granted" });
      expect(purgeMemoryForOrgMock).not.toHaveBeenCalled();
      expect(logSpy.mock.calls[0]?.[0]).toMatch(/skipped — consent re-granted/);
    } finally {
      logSpy.mockRestore();
    }
  });
});
