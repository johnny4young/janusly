/**
 * Contract tests for read-only recovery learning-health endpoints.
 *
 * The data layer is mocked so these tests pin route registration, role gates,
 * tenant-scoped delegation, and the public envelope without needing a server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  commitMemory: vi.fn(),
  DEFAULT_CALIBRATION_WINDOW_DAYS: 30,
  isMemoryAllowed: vi.fn(),
  getOrgConfigSnapshot: vi.fn(),
  listCalibrations: vi.fn(),
  queryRecoveryFeedbackHealth: vi.fn(),
  recordRecoveryFeedback: vi.fn(),
  queryRecoveryMetricsSignals: vi.fn(),
  queryRecoveryHeatmap: vi.fn(),
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
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      ({ payload: params === undefined ? { error: message, code } : { error: message, code, params }, status })),
  };
});

import {
  getOrgConfigSnapshot,
  listCalibrations,
  queryRecoveryFeedbackHealth,
} from "@janusly/data";
import { getDeadLetter } from "../dlq";
import type { Route } from "../routes";
import { recoveryRoutes } from "./recovery-routes";

const auth = { orgId: "org-health", userId: "user-health", mode: "dev-headers", source: "dev" } as const;

function findGetRoute(path: string): Route {
  const route = recoveryRoutes.find((candidate) =>
    candidate.method === "GET"
      && (typeof candidate.match === "string" ? candidate.match === path : candidate.match(path)));
  if (!route) throw new Error(`route not found: ${path}`);
  return route;
}

async function call(path: string) {
  const route = findGetRoute(path);
  return route.handler({ req: { url: path } as never, res: {} as never, auth: auth as never }) as Promise<{
    payload: Record<string, unknown>;
    status: number;
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOrgConfigSnapshot).mockResolvedValue({ ai: { confidenceCalibrationEnabled: true } } as never);
  vi.mocked(listCalibrations).mockResolvedValue([]);
  vi.mocked(queryRecoveryFeedbackHealth).mockResolvedValue({ windowDays: 30, approaches: [] });
  vi.mocked(getDeadLetter).mockResolvedValue({ workflowJson: { id: "workflow-health" } } as never);
});

describe("GET /recovery/calibration-status", () => {
  it("is viewer-readable and returns the enabled flag plus every stored curve", async () => {
    vi.mocked(listCalibrations).mockResolvedValue([{
      approachLabel: "add_retry",
      acceptRate: 0.8,
      sampleSize: 25,
      curveSlope: 0.9,
      curveIntercept: 4,
      lastComputedAt: new Date("2026-07-10T00:00:00.000Z"),
    }]);

    const route = findGetRoute("/recovery/calibration-status");
    expect(route.role).toBe("viewer");

    const result = await call("/recovery/calibration-status");

    expect(getOrgConfigSnapshot).toHaveBeenCalledWith("org-health");
    expect(listCalibrations).toHaveBeenCalledWith("org-health");
    expect(result).toEqual({
      status: 200,
      payload: expect.objectContaining({
        enabled: true,
        windowDays: 30,
        minimumSampleSize: 20,
        calibrations: [expect.objectContaining({ approachLabel: "add_retry", sampleSize: 25 })],
      }),
    });
  });

  it("reports an opt-out without hiding the read-only status envelope", async () => {
    vi.mocked(getOrgConfigSnapshot).mockResolvedValue({ ai: { confidenceCalibrationEnabled: false } } as never);

    const result = await call("/recovery/calibration-status");

    expect(result.payload).toMatchObject({ enabled: false, calibrations: [] });
  });
});

describe("GET /recovery/feedback-health", () => {
  it("resolves the saved workflow from an org-scoped DLQ row before querying feedback health", async () => {
    vi.mocked(queryRecoveryFeedbackHealth).mockResolvedValue({
      windowDays: 30,
      approaches: [{
        approachLabel: "add_retry",
        feedbackLastSeen: new Date("2026-07-09T00:00:00.000Z"),
        acceptedFixLastSeen: new Date("2026-06-01T00:00:00.000Z"),
        acceptedFixAgeDays: 39,
        state: "stale",
      }],
    });

    const route = findGetRoute("/recovery/feedback-health?deadLetterId=dlq-health");
    expect(route.role).toBe("viewer");
    const result = await call("/recovery/feedback-health?deadLetterId=dlq-health");

    expect(getDeadLetter).toHaveBeenCalledWith("org-health", "dlq-health");
    expect(queryRecoveryFeedbackHealth).toHaveBeenCalledWith("org-health", "workflow-health");
    expect(result).toEqual({
      status: 200,
      payload: expect.objectContaining({
        windowDays: 30,
        approaches: [expect.objectContaining({ approachLabel: "add_retry", state: "stale" })],
      }),
    });
  });

  it("rejects a missing DLQ id before any data lookup", async () => {
    const result = await call("/recovery/feedback-health");

    expect(result).toEqual({
      status: 400,
      payload: { error: "deadLetterId is required", code: "dlq_field_required", params: { field: "deadLetterId" } },
    });
    expect(getDeadLetter).not.toHaveBeenCalled();
    expect(queryRecoveryFeedbackHealth).not.toHaveBeenCalled();
  });

  it("keeps anonymous workflow feedback unavailable", async () => {
    vi.mocked(getDeadLetter).mockResolvedValue({ workflowJson: { name: "Ad-hoc" } } as never);

    const result = await call("/recovery/feedback-health?deadLetterId=dlq-ad-hoc");

    expect(result).toEqual({
      status: 422,
      payload: { error: "Feedback is only recorded for saved workflows", code: "recovery_feedback_saved_only" },
    });
    expect(queryRecoveryFeedbackHealth).not.toHaveBeenCalled();
  });
});
