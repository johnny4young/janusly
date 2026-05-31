/**
 * Pure-unit tests for the onboarding repo's branch logic.
 *
 * `@janusly/db` + `drizzle-orm` are mocked so no DB is hit. These cover the
 * two pieces of JS logic a mocked builder CAN prove: the monotonic
 * high-water guard (never write when the target step doesn't advance) and the
 * milestone-signal mapping (row presence → booleans, including the
 * recovery-applied OR). The CAS WHERE-clause correctness (idempotent create,
 * skip/resume/complete preconditions) is a SQL predicate exercised against
 * real Postgres in the live smoke.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const selectMock = vi.fn();
const updateMock = vi.fn();
const updateSetMock = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));

vi.mock("@janusly/db", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    insert: vi.fn(),
  },
  onboardingProgress: { orgId: "org", userId: "user", step: "step", status: "status" },
  credentials: { id: "id", orgId: "org" },
  auditLogs: { id: "id", orgId: "org", action: "action" },
  runs: { id: "id", orgId: "org", status: "status" },
  deadLetters: { id: "id", orgId: "org", status: "status" },
  recoveryItems: { id: "id", orgId: "org", status: "status" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  gte: (a: unknown, b: unknown) => ({ gte: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  sql: (...a: unknown[]) => ({ sql: a }),
}));

import {
  advanceOnboardingHighWater,
  resolveOnboardingMilestones,
  restartOnboarding,
} from "./onboardingProgressRepo";

/**
 * Unified awaitable query-builder stub. Supports both shapes the repo uses:
 * `select().from().where()` awaited directly (getOnboardingProgress) AND
 * `select().from().where().limit(1)` (the milestone EXISTS reads).
 */
function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
  };
  return chain;
}

afterEach(() => {
  vi.clearAllMocks();
  updateMock.mockReset();
});

describe("advanceOnboardingHighWater", () => {
  it("does NOT write when the target step is at or behind the current high-water", async () => {
    selectMock.mockReturnValueOnce(makeChain([{ step: "failure_injected" }]));
    await advanceOnboardingHighWater("org-1", "user-1", "credential_configured");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("writes when the target step is ahead of the current high-water", async () => {
    updateMock.mockReturnValue({ set: updateSetMock });
    selectMock.mockReturnValueOnce(makeChain([{ step: "org_created" }]));
    await advanceOnboardingHighWater("org-1", "user-1", "pack_installed");
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the row does not exist", async () => {
    selectMock.mockReturnValueOnce(makeChain([]));
    await advanceOnboardingHighWater("org-1", "user-1", "recovery_applied");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("resolveOnboardingMilestones", () => {
  it("maps row presence to milestone booleans (recoveryApplied is the DLQ-or-recovery-item OR)", async () => {
    // Array order: credentials, audit(pack), runs, deadLetters(any), deadLetters(recovered), recoveryItems.
    selectMock
      .mockReturnValueOnce(makeChain([{ id: "c" }])) // credential present
      .mockReturnValueOnce(makeChain([])) // no pack-import audit
      .mockReturnValueOnce(makeChain([{ id: "r" }])) // a succeeded run
      .mockReturnValueOnce(makeChain([{ id: "d" }])) // a dead letter
      .mockReturnValueOnce(makeChain([])) // no replayed/resolved DLQ
      .mockReturnValueOnce(makeChain([{ id: "ri" }])); // a resolved recovery item

    const signals = await resolveOnboardingMilestones("org-1");

    expect(signals).toEqual({
      credentialConfigured: true,
      packInstalled: false,
      firstRunSucceeded: true,
      failureInjected: true,
      recoveryApplied: true, // false (DLQ) || true (recovery item)
    });
  });

  it("returns all-false for a brand-new org", async () => {
    for (let i = 0; i < 6; i += 1) selectMock.mockReturnValueOnce(makeChain([]));
    const signals = await resolveOnboardingMilestones("org-1");
    expect(signals).toEqual({
      credentialConfigured: false,
      packInstalled: false,
      firstRunSucceeded: false,
      failureInjected: false,
      recoveryApplied: false,
    });
  });

  it("accepts a restart-epoch `since` window without breaking the mapping", async () => {
    for (let i = 0; i < 6; i += 1) selectMock.mockReturnValueOnce(makeChain([]));
    const signals = await resolveOnboardingMilestones("org-1", new Date("2026-03-01T00:00:00Z"));
    expect(signals.credentialConfigured).toBe(false);
  });
});

describe("restartOnboarding", () => {
  it("unconditionally resets the row and stamps restarted_at", async () => {
    const setSpy = vi.fn(() => ({
      where: () => ({ returning: () => Promise.resolve([{ id: "ob-1", status: "active", step: "org_created" }]) }),
    }));
    updateMock.mockReturnValue({ set: setSpy });
    const result = await restartOnboarding("org-1", "user-1");
    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        step: "org_created",
        skippedAt: null,
        completedAt: null,
        restartedAt: expect.any(Date),
      }),
    );
    expect(result).toEqual({ id: "ob-1", status: "active", step: "org_created" });
  });
});
