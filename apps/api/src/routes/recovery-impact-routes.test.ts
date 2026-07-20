/**
 * Contract tests for the additive Recovery impact reads. The data layer is
 * mocked so this suite pins AuthContext scoping, window clamping, viewer
 * registration, and the stable envelopes without a live server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  commitMemory: vi.fn(),
  DEFAULT_CALIBRATION_WINDOW_DAYS: 30,
  isMemoryAllowed: vi.fn(),
  getOrgConfigSnapshot: vi.fn(),
  listCalibrations: vi.fn(),
  queryOperatorRecoveryCount: vi.fn(),
  queryRecoveryFeedbackHealth: vi.fn(),
  queryRecoveryHeatmap: vi.fn(),
  queryRecoveryLedger: vi.fn(),
  queryRecoveryMetricsSignals: vi.fn(),
  recordRecoveryFeedback: vi.fn(),
}));
vi.mock("@janusly/engine/src/confidence-calibration", () => ({ MIN_CALIBRATION_SAMPLES: 20 }));
vi.mock("@janusly/engine/src/recovery-metrics", () => ({ composeRecoveryMetrics: vi.fn() }));
vi.mock("../dlq", () => ({ getDeadLetter: vi.fn() }));
vi.mock("../rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));
vi.mock("../metrics-cache", () => ({ getCachedRecoveryMetrics: vi.fn(), setCachedRecoveryMetrics: vi.fn() }));
vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  };
});

import { queryOperatorRecoveryCount, queryRecoveryLedger } from "@janusly/data";
import type { Route } from "../routes";
import { recoveryRoutes } from "./recovery-routes";

const auth = { orgId: "org-impact", userId: "user-impact", mode: "dev-headers", source: "dev" } as const;

function findGetRoute(path: string): Route {
  const route = recoveryRoutes.find((candidate) =>
    candidate.method === "GET"
      && (typeof candidate.match === "string" ? candidate.match === path : candidate.match(path)));
  if (!route) throw new Error(`route not found: ${path}`);
  return route;
}

async function call(path: string) {
  return findGetRoute(path).handler({
    req: { url: path } as never,
    res: {} as never,
    auth: auth as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(queryRecoveryLedger).mockResolvedValue({
    totalRecovered: 8,
    downtimeEndedMs: 9_000_000,
    sinceIso: "2026-01-02T03:04:05.000Z",
  });
  vi.mocked(queryOperatorRecoveryCount).mockResolvedValue(3);
});

describe("GET /recovery/ledger", () => {
  it("is viewer-readable and delegates only the authenticated tenant", async () => {
    const route = findGetRoute("/recovery/ledger");
    expect(route.role).toBe("viewer");
    expect(route.contract?.path).toBe("/recovery/ledger");

    await expect(call("/recovery/ledger")).resolves.toEqual({
      status: 200,
      payload: {
        totalRecovered: 8,
        downtimeEndedMs: 9_000_000,
        sinceIso: "2026-01-02T03:04:05.000Z",
      },
    });
    expect(queryRecoveryLedger).toHaveBeenCalledWith("org-impact");
  });
});

describe("GET /recovery/my-wins", () => {
  it("derives org and user from AuthContext and defaults to 30 days", async () => {
    const route = findGetRoute("/recovery/my-wins");
    expect(route.role).toBe("viewer");
    expect(route.contract?.path).toBe("/recovery/my-wins");

    const before = Date.now();
    await expect(call("/recovery/my-wins")).resolves.toEqual({
      status: 200,
      payload: { recovered: 3, windowDays: 30 },
    });
    const [orgId, userId, since] = vi.mocked(queryOperatorRecoveryCount).mock.calls[0] ?? [];
    expect(orgId).toBe("org-impact");
    expect(userId).toBe("user-impact");
    expect(since).toBeInstanceOf(Date);
    expect((since as Date).getTime()).toBeGreaterThanOrEqual(before - 30 * 24 * 60 * 60 * 1000 - 50);
  });

  it.each([
    ["?days=0", 1],
    ["?days=365", 90],
    ["?days=7", 7],
    ["?days=1e2", 90],
    ["?days=0x10", 16],
    ["?days=1.5", 30],
  ])("clamps %s to a safe rolling window", async (query, expectedDays) => {
    const result = await call(`/recovery/my-wins${query}`) as { payload: { windowDays: number } };
    expect(result.payload.windowDays).toBe(expectedDays);
  });
});
