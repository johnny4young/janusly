/**
 * Route-level dispatch tests for `POST /ai/review-workflow`.
 *
 * Locks down (1) the route is auth-only (no elevated role — the review
 * surface is read-shaped), (2) the AI-mode happy path merges the LLM
 * findings with the deterministic fallback and audits `mode: "ai"`, and
 * (3) the AI-fallback contract: when `llm.generateObject` throws the route
 * degrades to `{ mode: "fallback", aiError, review }` and STILL writes an
 * `ai.workflow.reviewed` audit row (the AGENTS.md AI-mutation invariant —
 * review audits both paths). The deterministic fallback + merge helpers are
 * stubbed passthroughs; the unit under test is the route wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/engine/src/workflow-review-fallback", () => ({
  buildReviewFallback: vi.fn(() => ({ status: "pass", issues: [] })),
  mergeReviewFindings: vi.fn((ai: unknown) => ai),
  sanitizeAiReview: vi.fn((ai: unknown) => ai),
}));

vi.mock("../ai-runtime", () => ({
  orgLlmRuntime: vi.fn(),
  resolveSurfaceModel: (
    surfaceModels: Record<string, string>,
    surface: string,
    requestOverride?: string,
  ) => requestOverride ?? surfaceModels?.[surface] ?? undefined,
}));

vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));
vi.mock("../rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("../locale", () => ({ localeFromRequest: vi.fn(() => "en") }));
vi.mock("../budget-gate", () => ({
  gateBudget: vi.fn(async () => ({ envelope: { allowed: true, warningThresholdCrossed: false }, blocked: false })),
  budgetBlockedResponse: (envelope: unknown) => ({ error: "budget_exceeded", budget: envelope }),
  attachBudgetEnvelope: (r: unknown) => r,
}));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
    readJson: vi.fn(),
  };
});

import { orgLlmRuntime } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { readJson, } from "../http";
import { buildReviewFallback } from "@janusly/engine/src/workflow-review-fallback";
import type { Route } from "../routes";
import { aiReviewRoutes } from "./ai-review-route";

const orgLlmMock = vi.mocked(orgLlmRuntime);
const auditMock = vi.mocked(auditAction);
const readJsonMock = vi.mocked(readJson);
const buildFallbackMock = vi.mocked(buildReviewFallback);

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as const;

const VALID_WORKFLOW = {
  id: "wf-review",
  name: "Reviewed",
  nodes: [{ id: "n1", type: "http", config: { url: "https://example.com" } }],
  edges: [],
};

function makeLlm(opts: { object?: unknown; throws?: boolean }) {
  return {
    generateObject: vi.fn(async () => {
      if (opts.throws) throw new Error("boom-review");
      return { object: opts.object, model: "claude-haiku-4-5-20251001", provider: "anthropic", latencyMs: 5, usage: {} };
    }),
  };
}

function setRuntime(llm: ReturnType<typeof makeLlm> | null) {
  orgLlmMock.mockResolvedValue({
    orgConfig: { ai: { promptMaxChars: 4000, rateLimitPerMin: 60, surfaceModels: {} } } as never,
    llm: llm as never,
    llmConfig: {} as never,
  });
}

function findRoute(): Route {
  const route = aiReviewRoutes.find((c) => c.method === "POST" && c.match === "/ai/review-workflow");
  if (!route) throw new Error("route not found");
  return route;
}

async function callReview(): Promise<{ payload: any; status: number }> {
  return findRoute().handler({ req: { url: "/ai/review-workflow", headers: {} } as never, res: {} as never, auth: auth as never }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockResolvedValue(undefined as never);
  buildFallbackMock.mockReturnValue({ status: "pass", issues: [] } as never);
  readJsonMock.mockResolvedValue({ workflow: VALID_WORKFLOW } as never);
});

describe("POST /ai/review-workflow — auth gate", () => {
  it("uses ai.write without imposing an elevated role rank", () => {
    const route = findRoute();
    expect(route.role).toBeUndefined();
    expect(route.permission).toBe("ai.write");
  });
});

describe("POST /ai/review-workflow — AI mode", () => {
  it("returns mode:ai with the merged review and audits mode:ai", async () => {
    const review = { status: "warn", issues: [{ code: "x", severity: "warn", message: "m" }] };
    setRuntime(makeLlm({ object: review }));

    const res = await callReview();

    expect(res.payload.mode).toBe("ai");
    expect(res.payload.model).toBe("claude-haiku-4-5-20251001");
    expect(res.payload.review).toEqual(review);

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]?.[1]).toBe("ai.workflow.reviewed");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("ai");
  });
});

describe("POST /ai/review-workflow — fallback contract", () => {
  it("degrades to mode:fallback with aiError when generateObject throws, still audits", async () => {
    setRuntime(makeLlm({ throws: true }));

    const res = await callReview();

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBe("boom-review");
    expect(res.payload.review).toEqual({ status: "pass", issues: [] });

    expect(auditMock).toHaveBeenCalledTimes(1);
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
    expect(meta.error).toBe("boom-review");
  });

  it("degrades to mode:fallback (no aiError) when no LLM is configured, still audits", async () => {
    setRuntime(null);

    const res = await callReview();

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBeUndefined();
    expect(res.payload.review).toEqual({ status: "pass", issues: [] });

    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
    expect(meta.reason).toBe("no_llm_configured");
  });

  it("audits an invalid-workflow-shape fallback before any LLM call", async () => {
    readJsonMock.mockResolvedValue({ workflow: { id: "bad" } } as never);
    setRuntime(makeLlm({ object: {} }));

    const res = await callReview();

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBe("Workflow shape invalid");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.reason).toBe("invalid_workflow_shape");
  });
});
