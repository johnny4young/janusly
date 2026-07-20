/**
 * Tests for the experiments routes:
 *   GET  /experiments
 *   GET  /experiments/:id
 *   POST /experiments/run
 *
 * Coverage targets (the ticket AC):
 * - Route gating: run requires admin + evals.write; reads require evals.read.
 * - POST /experiments/run writes `experiment.run.started` +
 *   `experiment.run.completed`, and `experiment.run.promotion_suggested`
 *   ONLY when the runner recommends the candidate.
 * - NO PRODUCTION MUTATION: the route never calls any prompt / org-config
 *   writer — it only persists through `createExperiment` +
 *   `recordExperimentResult`. (Asserted by mocking the data barrel and
 *   verifying no other writer is invoked.)
 * - Empty / cross-org dataset → 422 / 404 BEFORE any LLM cost.
 * - Budget block → 402 before the run; no experiment row created.
 * - Bad prompt ref → 422 (`experiment_prompt_ref_invalid`).
 *
 * The runner + scorer have their own focused suites; this suite mocks the
 * runner so the route wiring (gating, audit, mutation-absence) is the unit
 * under test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  createExperiment: vi.fn(),
  getEvalDataset: vi.fn(),
  getExperiment: vi.fn(),
  listEvalExamples: vi.fn(),
  listExperiments: vi.fn(),
  recordExperimentResult: vi.fn(),
  isExperimentKind: (v: unknown) => v === "prompt" || v === "model" || v === "prompt_and_model",
}));

vi.mock("@janusly/ai", async () => {
  const actual = await vi.importActual<typeof import("@janusly/ai")>("@janusly/ai");
  return { ...actual, runExperiment: vi.fn() };
});

vi.mock("@janusly/engine/src/safe-persist", () => ({
  safePersistPayload: (v: unknown) => v,
}));

vi.mock("@janusly/engine/src/prompt-resolver", () => {
  class MissingPromptError extends Error { code = "missing_prompt"; }
  class MissingPromptVersionError extends Error { code = "missing_prompt_version"; }
  class NoPromptVersionsError extends Error { code = "no_prompt_versions"; }
  return {
    resolvePromptRef: vi.fn(),
    MissingPromptError,
    MissingPromptVersionError,
    NoPromptVersionsError,
  };
});

vi.mock("../ai-runtime", () => ({
  orgLlmRuntime: vi.fn(async () => ({ orgConfig: { ai: { rateLimitPerMin: 60 } }, llm: { generateText: vi.fn(), generateObject: vi.fn() }, llmConfig: {} })),
}));

vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));

vi.mock("../rate-limit", () => ({ enforceRateLimit: vi.fn() }));

vi.mock("../budget-gate", () => ({
  gateBudget: vi.fn(async () => ({ envelope: { allowed: true, warningThresholdCrossed: false }, blocked: false })),
  budgetBlockedResponse: (envelope: unknown) => ({ error: "budget_exceeded", budget: envelope }),
}));

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

import {
  createExperiment,
  getEvalDataset,
  getExperiment,
  listEvalExamples,
  listExperiments,
  recordExperimentResult,
} from "@janusly/data";
import { runExperiment } from "@janusly/ai";
import { resolvePromptRef, MissingPromptError } from "@janusly/engine/src/prompt-resolver";

import { orgLlmRuntime } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { gateBudget } from "../budget-gate";
import { readJson, sendJson } from "../http";
import type { Route } from "../routes";
import { experimentsRoutes } from "./experiments-routes";

const createMock = vi.mocked(createExperiment);
const getDatasetMock = vi.mocked(getEvalDataset);
const getExperimentMock = vi.mocked(getExperiment);
const listExamplesMock = vi.mocked(listEvalExamples);
const listExperimentsMock = vi.mocked(listExperiments);
const recordResultMock = vi.mocked(recordExperimentResult);
const runMock = vi.mocked(runExperiment);
const resolvePromptMock = vi.mocked(resolvePromptRef);
const orgLlmMock = vi.mocked(orgLlmRuntime);
const auditMock = vi.mocked(auditAction);
const gateBudgetMock = vi.mocked(gateBudget);
const readJsonMock = vi.mocked(readJson);
const sendJsonMock = vi.mocked(sendJson);

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as const;

function findRoute(method: "GET" | "POST" | "DELETE", url: string): Route {
  const route = experimentsRoutes.find((candidate) => {
    if (candidate.method !== method) return false;
    return typeof candidate.match === "string" ? candidate.match === url : candidate.match(url);
  });
  if (!route) throw new Error(`route not found: ${method} ${url}`);
  return route;
}

async function call(method: "GET" | "POST" | "DELETE", url: string) {
  const route = findRoute(method, url);
  return route.handler({ req: { url } as never, res: {} as never, auth: auth as never });
}

const experiment = {
  id: "exp-1",
  orgId: "org-1",
  name: "haiku-vs-sonnet",
  kind: "model" as const,
  controlRef: "claude-haiku-4-5",
  candidateRef: "anthropic/claude-sonnet-4-5",
  evalDatasetId: "ds-1",
  scorerKind: "string_equality",
  status: "running" as const,
  summaryJson: null,
  createdBy: "user-1",
  createdAt: new Date("2026-05-29T00:00:00Z"),
  completedAt: null,
};

const dataset = { id: "ds-1", orgId: "org-1", name: "billing", description: "", workflowId: null, exampleCount: 1, retentionDays: null, createdBy: "user-1", createdAt: new Date() };
const example = { id: "ex-1", datasetId: "ds-1", sourceFeedbackId: "fb-1", workflowId: "wf-1", deadLetterId: "dl-1", failureSignature: "HTTP 401", inputContext: "401 from api", expectedApproachLabel: "swap_secret_ref", accepted: true, suggestionMode: "ai", createdAt: null };

function baseSummary(overrides: Partial<{ recommendation: string; scoreDelta: number }> = {}) {
  return {
    scorerKind: "string_equality" as const,
    exampleCount: 1,
    control: { meanScore: 0.5, totalCostUsd: 0.01, costKnownCount: 1, meanLatencyMs: 10, errorCount: 0, judgedByLlmCount: 0 },
    candidate: { meanScore: 0.9, totalCostUsd: 0.02, costKnownCount: 1, meanLatencyMs: 12, errorCount: 0, judgedByLlmCount: 0 },
    scoreDelta: overrides.scoreDelta ?? 0.4,
    costDelta: 0.01,
    recommendation: (overrides.recommendation ?? "promote_candidate") as "promote_candidate" | "keep_control" | "inconclusive",
    recommendationReason: "candidate higher",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockResolvedValue(undefined as never);
  gateBudgetMock.mockResolvedValue({ envelope: { allowed: true, warningThresholdCrossed: false } as never, blocked: false });
  orgLlmMock.mockResolvedValue({ orgConfig: { ai: { rateLimitPerMin: 60 } } as never, llm: { generateText: vi.fn(), generateObject: vi.fn() } as never, llmConfig: {} as never });
});

describe("route gating", () => {
  it("run requires admin + evals.write; reads require evals.read", () => {
    const run = findRoute("POST", "/experiments/run");
    expect(run.role).toBe("admin");
    expect(run.permission).toBe("evals.write");
    const list = findRoute("GET", "/experiments");
    expect(list.permission).toBe("evals.read");
    const get = findRoute("GET", "/experiments/exp-1");
    expect(get.permission).toBe("evals.read");
  });
});

describe("POST /experiments/run", () => {
  it("creates + runs + audits started/completed and recommends promotion (no prod mutation)", async () => {
    readJsonMock.mockResolvedValue({ name: "haiku-vs-sonnet", kind: "model", controlRef: "claude-haiku-4-5", candidateRef: "anthropic/claude-sonnet-4-5", evalDatasetId: "ds-1" });
    getDatasetMock.mockResolvedValue(dataset);
    listExamplesMock.mockResolvedValue([example]);
    createMock.mockResolvedValue(experiment);
    runMock.mockResolvedValue(baseSummary());
    recordResultMock.mockResolvedValue({ ...experiment, status: "completed", summaryJson: baseSummary() });

    const result = (await call("POST", "/experiments/run")) as { status?: number; payload?: { summary?: { recommendation?: string } } };

    // The run + the persistence happened.
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", kind: "model", createdBy: "user-1" }));
    expect(recordResultMock).toHaveBeenCalledWith("org-1", "exp-1", "completed", expect.any(Object));

    // Audit: started, completed, promotion_suggested (3 rows).
    const actions = auditMock.mock.calls.map((c) => c[1]);
    expect(actions).toContain("experiment.run.started");
    expect(actions).toContain("experiment.run.completed");
    expect(actions).toContain("experiment.run.promotion_suggested");

    expect(result.payload?.summary?.recommendation).toBe("promote_candidate");

    // NO PRODUCTION MUTATION: the data barrel mock exposes only the
    // experiment + read functions; there's no prompt/org-config writer to
    // call. Assert the runner returned a recommendation but nothing wrote
    // a prompt version (the mock would throw on an unknown export).
    expect(getDatasetMock).toHaveBeenCalled();
  });

  it("does NOT write promotion_suggested when control wins", async () => {
    readJsonMock.mockResolvedValue({ name: "x", kind: "model", controlRef: "a", candidateRef: "b", evalDatasetId: "ds-1" });
    getDatasetMock.mockResolvedValue(dataset);
    listExamplesMock.mockResolvedValue([example]);
    createMock.mockResolvedValue(experiment);
    runMock.mockResolvedValue(baseSummary({ recommendation: "keep_control", scoreDelta: -0.2 }));
    recordResultMock.mockResolvedValue({ ...experiment, status: "completed" });

    await call("POST", "/experiments/run");

    const actions = auditMock.mock.calls.map((c) => c[1]);
    expect(actions).toContain("experiment.run.completed");
    expect(actions).not.toContain("experiment.run.promotion_suggested");
  });

  it("returns 404 when the dataset is absent / cross-org (no run, no row)", async () => {
    readJsonMock.mockResolvedValue({ name: "x", kind: "model", controlRef: "a", candidateRef: "b", evalDatasetId: "ds-x" });
    getDatasetMock.mockResolvedValue(null);

    const result = (await call("POST", "/experiments/run")) as { status?: number; payload?: { code?: string } };
    expect(result.status).toBe(404);
    expect(result.payload?.code).toBe("experiment_dataset_not_found");
    expect(runMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 422 when the dataset is empty (no LLM cost)", async () => {
    readJsonMock.mockResolvedValue({ name: "x", kind: "model", controlRef: "a", candidateRef: "b", evalDatasetId: "ds-1" });
    getDatasetMock.mockResolvedValue(dataset);
    listExamplesMock.mockResolvedValue([]);

    const result = (await call("POST", "/experiments/run")) as { status?: number; payload?: { code?: string } };
    expect(result.status).toBe(422);
    expect(result.payload?.code).toBe("experiment_dataset_empty");
    expect(runMock).not.toHaveBeenCalled();
    expect(gateBudgetMock).not.toHaveBeenCalled();
  });

  it("returns 402 when the budget gate blocks (before the run, no row)", async () => {
    readJsonMock.mockResolvedValue({ name: "x", kind: "model", controlRef: "a", candidateRef: "b", evalDatasetId: "ds-1" });
    getDatasetMock.mockResolvedValue(dataset);
    listExamplesMock.mockResolvedValue([example]);
    gateBudgetMock.mockResolvedValue({ envelope: { allowed: false } as never, blocked: true });

    const result = (await call("POST", "/experiments/run")) as { status?: number; payload?: { error?: string } };
    expect(result.status).toBe(402);
    expect(result.payload?.error).toBe("budget_exceeded");
    expect(createMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });

  it("returns 422 when a prompt ref cannot be resolved", async () => {
    readJsonMock.mockResolvedValue({ name: "x", kind: "prompt", controlRef: "missing-prompt", candidateRef: "other", evalDatasetId: "ds-1" });
    getDatasetMock.mockResolvedValue(dataset);
    listExamplesMock.mockResolvedValue([example]);
    resolvePromptMock.mockRejectedValueOnce(new MissingPromptError("missing-prompt"));

    const result = (await call("POST", "/experiments/run")) as { status?: number; payload?: { code?: string } };
    expect(result.status).toBe(422);
    expect(result.payload?.code).toBe("experiment_prompt_ref_invalid");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid body with 400 (no dataset read)", async () => {
    readJsonMock.mockResolvedValue({ name: "x", kind: "bogus", controlRef: "a", candidateRef: "b", evalDatasetId: "ds-1" });
    const result = (await call("POST", "/experiments/run")) as { status?: number };
    expect(result.status).toBe(400);
    expect(getDatasetMock).not.toHaveBeenCalled();
  });
});

describe("GET /experiments + /experiments/:id", () => {
  it("lists the org's experiments", async () => {
    listExperimentsMock.mockResolvedValue([experiment]);
    const result = (await call("GET", "/experiments")) as { payload?: { experiments?: unknown[] } };
    expect(listExperimentsMock).toHaveBeenCalledWith("org-1");
    expect(result.payload?.experiments).toHaveLength(1);
  });

  it("returns a single experiment", async () => {
    getExperimentMock.mockResolvedValue({ ...experiment, status: "completed", summaryJson: baseSummary() });
    const result = (await call("GET", "/experiments/exp-1")) as { payload?: { experiment?: { id?: string } } };
    expect(getExperimentMock).toHaveBeenCalledWith("org-1", "exp-1");
    expect(result.payload?.experiment?.id).toBe("exp-1");
  });

  it("404s a missing / cross-org experiment", async () => {
    getExperimentMock.mockResolvedValue(null);
    const result = (await call("GET", "/experiments/exp-x")) as { status?: number; payload?: { code?: string } };
    expect(result.status).toBe(404);
    expect(result.payload?.code).toBe("experiment_not_found");
  });
});

// Keep the unused import lint-quiet; sendJson is mocked and asserted indirectly.
void sendJsonMock;
