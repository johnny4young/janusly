/**
 * Route-level tests for GET/POST /onboarding.
 *
 * Mocks the data repo (the derive-on-read reads + CAS writes), `aiStatus`,
 * and `auditAction`; uses the REAL `errorEnvelope`. Covers the route's
 * compose logic: per-milestone `done` derivation, `currentStep` = first
 * undone, out-of-order independence, the completed short-circuit, the
 * exactly-once completion audit (CAS-gated), the AI-unavailable flag +
 * non-deadlock walk, skip/resume audits, the invalid-action 400, and that
 * every read/write is scoped to `(auth.orgId, auth.userId)`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  const sendJson = vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status }));
  return {
    ...actual,
    sendJson,
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      sendJson(_res, params === undefined ? { error: message, code } : { error: message, code, params }, status)),
    readJson: vi.fn(),
  };
});

vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  ensureOnboardingRow: vi.fn(),
  getOnboardingProgress: vi.fn(),
  advanceOnboardingHighWater: vi.fn(),
  completeOnboardingCas: vi.fn(),
  setOnboardingStatus: vi.fn(),
  restartOnboarding: vi.fn(),
  resolveOnboardingMilestones: vi.fn(),
  isOnboardingEnabled: vi.fn(),
}));

vi.mock("../ai-runtime", () => ({ aiStatus: vi.fn() }));
vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));

import { onboardingRoutes } from "./onboarding-routes";
import { readJson } from "../http";
import {
  ensureOnboardingRow,
  getOnboardingProgress,
  advanceOnboardingHighWater,
  completeOnboardingCas,
  setOnboardingStatus,
  restartOnboarding,
  resolveOnboardingMilestones,
  isOnboardingEnabled,
} from "@janusly/data";
import { aiStatus } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import type { Route } from "../routes";

const readJsonMock = vi.mocked(readJson);
const ensureRowMock = vi.mocked(ensureOnboardingRow);
const getProgressMock = vi.mocked(getOnboardingProgress);
const advanceMock = vi.mocked(advanceOnboardingHighWater);
const completeCasMock = vi.mocked(completeOnboardingCas);
const setStatusMock = vi.mocked(setOnboardingStatus);
const restartMock = vi.mocked(restartOnboarding);
const resolveMilestonesMock = vi.mocked(resolveOnboardingMilestones);
const enabledMock = vi.mocked(isOnboardingEnabled);
const aiStatusMock = vi.mocked(aiStatus);
const auditActionMock = vi.mocked(auditAction);

const AUTH = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" };

const NO_SIGNALS = {
  credentialConfigured: false,
  packInstalled: false,
  firstRunSucceeded: false,
  failureInjected: false,
  recoveryApplied: false,
};
const ALL_SIGNALS = {
  credentialConfigured: true,
  packInstalled: true,
  firstRunSucceeded: true,
  failureInjected: true,
  recoveryApplied: true,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "ob-1",
    orgId: "org-1",
    userId: "user-1",
    step: "org_created",
    status: "active",
    skippedAt: null,
    completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

type Payload = { payload: Record<string, unknown>; status: number };
type Milestone = { step: string; done: boolean; order: number; target: string };

function findRoute(method: string, path: string): Route {
  const route = onboardingRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

async function callRoute(method: string, path: string, body?: unknown): Promise<Payload> {
  const route = findRoute(method, path);
  if (body !== undefined) readJsonMock.mockResolvedValueOnce(body);
  return route.handler({ req: { url: path } as never, res: {} as never, auth: AUTH as never }) as Promise<Payload>;
}

function milestone(payload: Record<string, unknown>, step: string): Milestone {
  const found = (payload.milestones as Milestone[]).find((m) => m.step === step);
  if (!found) throw new Error(`milestone not found: ${step}`);
  return found;
}

beforeEach(() => {
  ensureRowMock.mockResolvedValue(row() as never);
  getProgressMock.mockResolvedValue(row() as never);
  advanceMock.mockResolvedValue(undefined);
  completeCasMock.mockResolvedValue(null as never);
  setStatusMock.mockResolvedValue(row({ status: "skipped" }) as never);
  restartMock.mockResolvedValue(row({ status: "active", step: "org_created", restartedAt: new Date() }) as never);
  resolveMilestonesMock.mockResolvedValue({ ...NO_SIGNALS });
  enabledMock.mockResolvedValue(true);
  aiStatusMock.mockResolvedValue({ enabled: true, provider: "anthropic", model: "x", timeoutMs: 1, maxRetries: 1 } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("route gate declarations", () => {
  it("GET /onboarding is viewer + onboarding.read", () => {
    const route = findRoute("GET", "/onboarding");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("onboarding.read");
  });
  it("POST /onboarding is viewer + onboarding.write", () => {
    const route = findRoute("POST", "/onboarding");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("onboarding.write");
  });
});

describe("GET /onboarding — derivation", () => {
  it("org_created is always done; first undone is credential_configured", async () => {
    const { payload } = await callRoute("GET", "/onboarding");
    expect((payload.milestones as Milestone[]).length).toBe(7);
    expect(milestone(payload, "org_created").done).toBe(true);
    expect(milestone(payload, "credential_configured").done).toBe(false);
    expect(payload.currentStep).toBe("credential_configured");
    expect(payload.completed).toBe(false);
    expect(payload.aiAvailable).toBe(true);
    expect(payload.status).toBe("active");
  });

  it("scopes the row + derivation to (auth.orgId, auth.userId)", async () => {
    await callRoute("GET", "/onboarding");
    expect(ensureRowMock).toHaveBeenCalledWith("org-1", "user-1");
    expect(resolveMilestonesMock).toHaveBeenCalledWith("org-1", undefined);
  });

  it("advances currentStep as earlier milestones complete", async () => {
    resolveMilestonesMock.mockResolvedValue({ ...NO_SIGNALS, credentialConfigured: true, packInstalled: true });
    const { payload } = await callRoute("GET", "/onboarding");
    expect(milestone(payload, "credential_configured").done).toBe(true);
    expect(milestone(payload, "pack_installed").done).toBe(true);
    expect(payload.currentStep).toBe("first_run_succeeded");
  });

  it("treats milestones independently — failure_injected can be done before first_run_succeeded", async () => {
    resolveMilestonesMock.mockResolvedValue({
      ...NO_SIGNALS,
      credentialConfigured: true,
      packInstalled: true,
      failureInjected: true,
    });
    const { payload } = await callRoute("GET", "/onboarding");
    expect(milestone(payload, "failure_injected").done).toBe(true);
    expect(milestone(payload, "first_run_succeeded").done).toBe(false);
    expect(payload.currentStep).toBe("first_run_succeeded");
  });
});

describe("GET /onboarding — completion", () => {
  it("auto-completes via CAS and audits onboarding.completed exactly once", async () => {
    resolveMilestonesMock.mockResolvedValue({ ...ALL_SIGNALS });
    completeCasMock.mockResolvedValue(row({ status: "completed", step: "completed", completedAt: new Date() }) as never);
    const { payload } = await callRoute("GET", "/onboarding");
    expect(completeCasMock).toHaveBeenCalledWith("org-1", "user-1");
    expect(auditActionMock).toHaveBeenCalledTimes(1);
    expect(auditActionMock.mock.calls[0]![1]).toBe("onboarding.completed");
    expect(payload.completed).toBe(true);
    expect(payload.currentStep).toBe(null);
    expect(payload.status).toBe("completed");
  });

  it("does NOT audit when a concurrent read already completed (CAS returns null)", async () => {
    resolveMilestonesMock.mockResolvedValue({ ...ALL_SIGNALS });
    completeCasMock.mockResolvedValue(null as never);
    getProgressMock.mockResolvedValue(row({ status: "completed", completedAt: new Date() }) as never);
    const { payload } = await callRoute("GET", "/onboarding");
    expect(auditActionMock).not.toHaveBeenCalled();
    expect(payload.completed).toBe(true);
  });

  it("short-circuits a completed row without deriving milestones", async () => {
    ensureRowMock.mockResolvedValue(row({ status: "completed", step: "completed", completedAt: new Date() }) as never);
    const { payload } = await callRoute("GET", "/onboarding");
    expect(resolveMilestonesMock).not.toHaveBeenCalled();
    expect(payload.completed).toBe(true);
    expect(payload.currentStep).toBe(null);
    expect((payload.milestones as Milestone[]).every((m) => m.done)).toBe(true);
  });
});

describe("GET /onboarding — AI unavailable never deadlocks", () => {
  it("surfaces aiAvailable:false yet still walks all milestones to completed", async () => {
    aiStatusMock.mockResolvedValue({ enabled: false, provider: "anthropic", model: "x", timeoutMs: 1, maxRetries: 1 } as never);
    resolveMilestonesMock.mockResolvedValue({ ...ALL_SIGNALS });
    completeCasMock.mockResolvedValue(row({ status: "completed", step: "completed", completedAt: new Date() }) as never);
    const { payload } = await callRoute("GET", "/onboarding");
    expect(payload.aiAvailable).toBe(false);
    expect(payload.completed).toBe(true);
    expect(payload.status).toBe("completed");
  });
});

describe("GET /onboarding — tenant toggle", () => {
  it("returns a hidden state and skips all derivation when disabled", async () => {
    enabledMock.mockResolvedValue(false);
    const { payload } = await callRoute("GET", "/onboarding");
    expect(payload.enabled).toBe(false);
    expect(payload.currentStep).toBe(null);
    expect(ensureRowMock).not.toHaveBeenCalled();
    expect(resolveMilestonesMock).not.toHaveBeenCalled();
  });

  it("reports enabled:true on the normal derived path", async () => {
    const { payload } = await callRoute("GET", "/onboarding");
    expect(payload.enabled).toBe(true);
  });

  it("windows derivation to the restart epoch (passes row.restartedAt as `since`)", async () => {
    const epoch = new Date("2026-03-01T00:00:00Z");
    ensureRowMock.mockResolvedValue(row({ restartedAt: epoch }) as never);
    await callRoute("GET", "/onboarding");
    expect(resolveMilestonesMock).toHaveBeenCalledWith("org-1", epoch);
  });
});

describe("POST /onboarding — restart", () => {
  it("calls restartOnboarding and audits onboarding.restarted", async () => {
    await callRoute("POST", "/onboarding", { action: "restart" });
    expect(restartMock).toHaveBeenCalledWith("org-1", "user-1");
    expect(auditActionMock).toHaveBeenCalledWith(AUTH, "onboarding.restarted", expect.anything());
  });

  it("re-shows the banner even when onboarding was previously completed", async () => {
    // After restart: status=active + epoch set; windowed derivation finds no
    // post-restart activity, so the first step is undone and the banner shows.
    const epoch = new Date("2026-03-01T00:00:00Z");
    ensureRowMock.mockResolvedValue(row({ status: "active", step: "org_created", restartedAt: epoch }) as never);
    resolveMilestonesMock.mockResolvedValue({ ...NO_SIGNALS });
    const { payload } = await callRoute("GET", "/onboarding");
    expect(payload.status).toBe("active");
    expect(payload.currentStep).toBe("credential_configured");
    expect(payload.completed).toBe(false);
  });
});

describe("POST /onboarding — skip / resume", () => {
  it("skip sets status=skipped and audits onboarding.skipped", async () => {
    setStatusMock.mockResolvedValue(row({ status: "skipped", skippedAt: new Date() }) as never);
    ensureRowMock.mockResolvedValue(row({ status: "skipped", skippedAt: new Date() }) as never);
    const { payload } = await callRoute("POST", "/onboarding", { action: "skip" });
    expect(setStatusMock).toHaveBeenCalledWith("org-1", "user-1", "skipped");
    expect(auditActionMock).toHaveBeenCalledWith(AUTH, "onboarding.skipped", expect.anything());
    expect(payload.status).toBe("skipped");
  });

  it("resume sets status=active and audits onboarding.resumed", async () => {
    setStatusMock.mockResolvedValue(row({ status: "active" }) as never);
    await callRoute("POST", "/onboarding", { action: "resume" });
    expect(setStatusMock).toHaveBeenCalledWith("org-1", "user-1", "active");
    expect(auditActionMock).toHaveBeenCalledWith(AUTH, "onboarding.resumed", expect.anything());
  });

  it("does NOT audit when the transition was a no-op (CAS returns null)", async () => {
    setStatusMock.mockResolvedValue(null as never);
    await callRoute("POST", "/onboarding", { action: "skip" });
    expect(auditActionMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown action with 400 onboarding_invalid_action", async () => {
    const { payload, status } = await callRoute("POST", "/onboarding", { action: "frobnicate" });
    expect(status).toBe(400);
    expect(payload.code).toBe("onboarding_invalid_action");
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it("rejects a missing action with 400", async () => {
    const { status } = await callRoute("POST", "/onboarding", {});
    expect(status).toBe(400);
  });
});
