/**
 * Route-level dispatch tests for `POST /ai/suggest-improvement`.
 *
 * Locks down (1) the route's `role: "editor"` gate, (2) the AI-mode happy
 * path validates each suggestion's `patchedWorkflowJson` and audits
 * `mode: "ai"`, and (3) the AI-fallback contract. NOTE: the route calls
 * `suggestWorkflowImprovement` WITHOUT a route-level try/catch — the helper
 * owns the try/catch and RETURNS `{ mode: "fallback", aiError, ... }` on any
 * LLM failure (per `packages/ai/src/suggest-improvement.ts`). So the
 * fallback test drives the documented fallback by having the mocked helper
 * return that envelope, plus the route's own "no suggestion survived
 * validation" degrade. Both fallback shapes still audit
 * `ai.workflow.improvement_suggested` (the AGENTS.md AI-mutation invariant).
 * The evidence + past-feedback reads are stubbed; the unit under test is the
 * route wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/ai", async () => {
  const actual = await vi.importActual<typeof import("@janusly/ai")>("@janusly/ai");
  return { ...actual, suggestWorkflowImprovement: vi.fn() };
});

vi.mock("@janusly/data", () => ({ summarizePastFeedback: vi.fn(async () => []) }));

vi.mock("../ai-evidence", () => ({ assembleSuggestImprovementEvidence: vi.fn(async () => []) }));

vi.mock("../ai-runtime", () => ({
  orgLlmRuntime: vi.fn(),
  sanitizeAiWorkflow: vi.fn((w: unknown) => w),
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

import { suggestWorkflowImprovement } from "@janusly/ai";
import { orgLlmRuntime } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { readJson, sendJson } from "../http";
import type { Route } from "../routes";
import { aiImproveRoutes } from "./ai-improve-route";

const orgLlmMock = vi.mocked(orgLlmRuntime);
const auditMock = vi.mocked(auditAction);
const readJsonMock = vi.mocked(readJson);
const suggestMock = vi.mocked(suggestWorkflowImprovement);

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as const;

const VALID_WORKFLOW = {
  id: "wf-improve",
  name: "Improved",
  nodes: [{ id: "n1", type: "http", config: { url: "https://example.com" } }],
  edges: [],
};

function setRuntime() {
  orgLlmMock.mockResolvedValue({
    orgConfig: { ai: { promptMaxChars: 4000, rateLimitPerMin: 60, surfaceModels: {} } } as never,
    llm: {} as never,
    llmConfig: {} as never,
  });
}

function findRoute(): Route {
  const route = aiImproveRoutes.find((c) => c.method === "POST" && c.match === "/ai/suggest-improvement");
  if (!route) throw new Error("route not found");
  return route;
}

async function callImprove(): Promise<{ payload: any; status: number }> {
  return findRoute().handler({ req: { url: "/ai/suggest-improvement", headers: {} } as never, res: {} as never, auth: auth as never }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockResolvedValue(undefined as never);
  readJsonMock.mockResolvedValue({ workflow: VALID_WORKFLOW } as never);
  setRuntime();
});

describe("POST /ai/suggest-improvement — auth gate", () => {
  it("requires the editor role", () => {
    expect(findRoute().role).toBe("editor");
  });
});

describe("POST /ai/suggest-improvement — AI mode", () => {
  it("validates each suggestion and returns mode:ai + audits mode:ai", async () => {
    suggestMock.mockResolvedValue({
      mode: "ai",
      suggestions: [{
        patchedWorkflowJson: JSON.stringify(VALID_WORKFLOW),
        rationale: "add retries",
        approachLabel: "resilience",
        confidence: 80,
      }],
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    } as never);

    const res = await callImprove();

    expect(res.payload.mode).toBe("ai");
    expect(res.payload.suggestions).toHaveLength(1);
    expect(res.payload.suggestions[0].confidence).toBe(80);
    expect(res.payload.model).toBe("claude-haiku-4-5-20251001");
    expect(res.payload.evidence).toEqual([]);

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]?.[1]).toBe("ai.workflow.improvement_suggested");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("ai");
    expect(meta.suggestionsCount).toBe(1);
  });

  it("degrades to fallback when no AI suggestion survives validation", async () => {
    suggestMock.mockResolvedValue({
      mode: "ai",
      suggestions: [{
        patchedWorkflowJson: "{not valid json",
        rationale: "bad",
        approachLabel: "other",
        confidence: 50,
      }],
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    } as never);

    const res = await callImprove();

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBe("no_valid_suggestions");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
  });
});

describe("POST /ai/suggest-improvement — fallback contract", () => {
  it("passes through the helper's mode:fallback envelope and still audits", async () => {
    suggestMock.mockResolvedValue({
      mode: "fallback",
      suggestions: [{
        patchedWorkflowJson: JSON.stringify(VALID_WORKFLOW),
        rationale: "LLM unavailable",
        approachLabel: "other",
        confidence: 0,
      }],
      aiError: "quota_exceeded",
    } as never);

    const res = await callImprove();

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBe("quota_exceeded");
    expect(res.payload.suggestions).toHaveLength(1);

    expect(auditMock).toHaveBeenCalledTimes(1);
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
    expect(meta.aiError).toBe("quota_exceeded");
  });

  it("audits an invalid-workflow-shape fallback before the helper is called", async () => {
    readJsonMock.mockResolvedValue({ workflow: { id: "bad" } } as never);

    const res = await callImprove();

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBe("Workflow shape invalid");
    expect(suggestMock).not.toHaveBeenCalled();
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.reason).toBe("invalid_workflow_shape");
  });
});
