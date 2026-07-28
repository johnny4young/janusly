import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data", () => ({
  listRecoveryCases: vi.fn(),
  queryOperatorRecoveryCount: vi.fn(),
  queryRecoveryHeatmap: vi.fn(),
  queryRecoveryLedger: vi.fn(),
  queryRecoveryValidation: vi.fn(),
}));
vi.mock("../dlq", () => ({
  countDeadLettersByStatus: vi.fn(),
  queryRecoveryQueuePage: vi.fn(),
}));
vi.mock("../permissions", () => ({
  requirePermission: vi.fn(),
}));
vi.mock("../recovery-read-models", () => ({
  queryFailureClustersReadModel: vi.fn(),
  queryRecoveryMetricsReadModel: vi.fn(),
}));
vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    sendJson: vi.fn((
      _res: unknown,
      payload: unknown,
      status = 200,
    ) => ({ payload, status })),
  };
});

import {
  listRecoveryCases,
  queryOperatorRecoveryCount,
  queryRecoveryHeatmap,
  queryRecoveryLedger,
  queryRecoveryValidation,
} from "@janusly/data";

import {
  countDeadLettersByStatus,
  queryRecoveryQueuePage,
} from "../dlq";
import { requirePermission } from "../permissions";
import {
  queryFailureClustersReadModel,
  queryRecoveryMetricsReadModel,
} from "../recovery-read-models";
import type { Route } from "../routes";
import { recoveryHomeRoutes } from "./recovery-home-routes";

const auth = {
  orgId: "org-home",
  userId: "user-home",
  mode: "dev-headers",
  source: "dev",
} as const;

function routeFor(path: string): Route {
  const route = recoveryHomeRoutes.find((candidate) =>
    candidate.method === "GET" &&
    (typeof candidate.match === "string"
      ? candidate.match === path
      : candidate.match(path)));
  if (!route) throw new Error(`route not found: ${path}`);
  return route;
}

async function call(path: string) {
  return routeFor(path).handler({
    req: { url: path } as never,
    res: {} as never,
    auth: auth as never,
  }) as Promise<{
    payload: {
      scope: "full" | "impact";
      sections: Record<string, {
        status: "ok" | "unavailable";
        value?: unknown;
      }>;
    };
    status: number;
  }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({
    name: "viewer",
    inheritsFrom: "viewer",
  });
  vi.mocked(queryRecoveryMetricsReadModel)
    .mockResolvedValue({ terminalRuns: 3 } as never);
  vi.mocked(queryFailureClustersReadModel)
    .mockResolvedValue({ clusters: [], totalSamples: 0, windowDays: 30 });
  vi.mocked(queryRecoveryHeatmap).mockResolvedValue([]);
  vi.mocked(queryRecoveryValidation)
    .mockResolvedValue({ totals: { drills: 0 } } as never);
  vi.mocked(listRecoveryCases).mockResolvedValue([]);
  vi.mocked(queryRecoveryLedger).mockResolvedValue({
    totalRecovered: 2,
    downtimeEndedMs: 10_000,
    sinceIso: "2026-01-01T00:00:00.000Z",
  });
  vi.mocked(queryOperatorRecoveryCount).mockResolvedValue(1);
  vi.mocked(countDeadLettersByStatus).mockResolvedValue({
    total: 1,
    open: 1,
    replayed: 0,
    resolved: 0,
  });
  vi.mocked(queryRecoveryQueuePage).mockResolvedValue({
    items: [{ id: "dlq-oldest" }],
    nextCursor: null,
    hasMore: false,
  } as never);
});

describe("GET /recovery/home", () => {
  it("coalesces the full tenant snapshot while retaining section boundaries", async () => {
    const route = routeFor("/recovery/home");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("recovery.read");

    const result = await call("/recovery/home");

    expect(result.status).toBe(200);
    expect(result.payload.scope).toBe("full");
    expect(result.payload.sections).toMatchObject({
      metrics: { status: "ok", value: { terminalRuns: 3 } },
      clusters: { status: "ok" },
      heatmap: { status: "ok", value: { days: [], windowDays: 90 } },
      validation: { status: "ok" },
      cases: { status: "ok", value: { cases: [] } },
      ledger: { status: "ok" },
      wins: { status: "ok", value: { recovered: 1, windowDays: 30 } },
      queue: {
        status: "ok",
        value: {
          counts: { open: 1 },
          oldestOpen: { id: "dlq-oldest" },
        },
      },
    });
    expect(queryRecoveryMetricsReadModel).toHaveBeenCalledWith(
      "org-home",
      30,
    );
    expect(queryRecoveryHeatmap).toHaveBeenCalledWith("org-home", 90);
    expect(listRecoveryCases).toHaveBeenCalledWith("org-home", {
      openOnly: true,
      limit: 50,
    });
    expect(queryRecoveryQueuePage).toHaveBeenCalledWith(
      "org-home",
      { status: "open", sort: "oldest" },
      1,
    );
    expect(requirePermission).toHaveBeenCalledTimes(2);
    expect(requirePermission).toHaveBeenCalledWith(
      "org-home",
      "user-home",
      "dlq.read",
      "dev-headers",
    );
    expect(requirePermission).toHaveBeenCalledWith(
      "org-home",
      "user-home",
      "reports.read",
      "dev-headers",
    );
  });

  it("keeps healthy sections available when one projection or permission fails", async () => {
    vi.mocked(queryRecoveryValidation)
      .mockRejectedValueOnce(new Error("validation unavailable"));
    vi.mocked(requirePermission).mockImplementation(
      async (_orgId, _userId, permission) => {
        if (permission === "dlq.read") {
          throw Object.assign(new Error("forbidden"), {
            statusCode: 403,
          });
        }
        return { name: "viewer", inheritsFrom: "viewer" };
      },
    );

    const result = await call("/recovery/home");

    expect(result.payload.sections.metrics.status).toBe("ok");
    expect(result.payload.sections.cases.status).toBe("ok");
    expect(result.payload.sections.validation.status)
      .toBe("unavailable");
    expect(result.payload.sections.clusters.status)
      .toBe("unavailable");
    expect(result.payload.sections.queue.status)
      .toBe("unavailable");
  });

  it("limits convergence polls to the three lightweight impact projections", async () => {
    const result = await call("/recovery/home?scope=impact");

    expect(result.payload.scope).toBe("impact");
    expect(Object.keys(result.payload.sections).sort())
      .toEqual(["ledger", "queue", "wins"]);
    expect(queryRecoveryLedger).toHaveBeenCalledWith("org-home");
    expect(queryOperatorRecoveryCount).toHaveBeenCalledWith(
      "org-home",
      "user-home",
      expect.any(Date),
    );
    expect(queryRecoveryMetricsReadModel).not.toHaveBeenCalled();
    expect(queryFailureClustersReadModel).not.toHaveBeenCalled();
    expect(queryRecoveryHeatmap).not.toHaveBeenCalled();
    expect(queryRecoveryValidation).not.toHaveBeenCalled();
    expect(listRecoveryCases).not.toHaveBeenCalled();
    expect(requirePermission).toHaveBeenCalledTimes(1);
  });
});
