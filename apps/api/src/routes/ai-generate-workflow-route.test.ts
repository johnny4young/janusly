/**
 * Route-level dispatch tests for `POST /ai/generate-workflow` (camino A).
 *
 * Asserts the `org_configs.ai.generationMode` branch: free_json calls
 * `llm.generateText` + parses server-side; constrained calls
 * `llm.generateObject`; and the audit row carries `generationMode` +
 * `generationAttempts` on both AI-mode and fallback. The free-JSON parser
 * runs for real against a stub `generateText` (its own edge cases live in
 * `apps/api/src/ai-generate-freejson.test.ts`); `sanitizeAiWorkflow` and
 * `promoteNoopPlaceholders` are stubbed passthroughs since the unit under
 * test is the route wiring, not those gates. Mirrors the mock harness in
 * `experiments-routes.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data", () => ({
  summarizePastFeedback: vi.fn(),
  listExposedMcpToolsForAi: vi.fn(async () => []),
  listCalibrations: vi.fn(async () => []),
}));

vi.mock("@janusly/ai", async () => {
  const actual = await vi.importActual<typeof import("@janusly/ai")>("@janusly/ai");
  return {
    ...actual,
    promoteNoopPlaceholders: vi.fn(async ({ workflow }: { workflow: unknown }) => ({
      workflow,
      promotionAttempts: 0,
      promotionsSucceeded: 0,
      promotionsByFamily: {},
    })),
  };
});

const FALLBACK_WF = { id: "fallback", name: "Fallback", nodes: [{ id: "f1", type: "noop", config: {} }], edges: [] };

vi.mock("../ai-runtime", () => ({
  orgLlmRuntime: vi.fn(),
  sanitizeAiWorkflow: vi.fn((w: unknown) => w),
  fallbackWorkflowForPrompt: vi.fn(() => FALLBACK_WF),
  aiStatus: vi.fn(),
  fallbackExplainWorkflow: vi.fn(),
}));

vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));
vi.mock("../rate-limit", () => ({ enforceRateLimit: vi.fn() }));
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
import { readJson, sendJson } from "../http";
import type { Route } from "../routes";
import { aiRoutes } from "./ai-routes";

const orgLlmMock = vi.mocked(orgLlmRuntime);
const auditMock = vi.mocked(auditAction);
const readJsonMock = vi.mocked(readJson);
const sendJsonMock = vi.mocked(sendJson);

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as const;

const VALID_WORKFLOW = {
  id: "wf-gen",
  name: "Generated",
  nodes: [{ id: "n1", type: "http", config: { url: "https://example.com" } }],
  edges: [],
};
const VALID_JSON = JSON.stringify(VALID_WORKFLOW);

function makeLlm(opts: { text?: string[]; object?: unknown }) {
  const textQueue = [...(opts.text ?? [])];
  return {
    generateText: vi.fn(async () => ({
      text: textQueue.shift() ?? "",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      latencyMs: 5,
      usage: {},
    })),
    generateObject: vi.fn(async () => ({
      object: opts.object,
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      latencyMs: 5,
      usage: {},
    })),
  };
}

function setRuntime(generationMode: string, llm: ReturnType<typeof makeLlm>) {
  orgLlmMock.mockResolvedValue({
    orgConfig: { ai: { generationMode, promptMaxChars: 4000, rateLimitPerMin: 60 } } as never,
    llm: llm as never,
    llmConfig: {} as never,
  });
}

function findRoute(method: "GET" | "POST" | "DELETE", url: string): Route {
  const route = aiRoutes.find((c) => c.method === method && (typeof c.match === "string" ? c.match === url : c.match(url)));
  if (!route) throw new Error(`route not found: ${method} ${url}`);
  return route;
}

async function callGenerate(): Promise<{ payload: any; status: number }> {
  const route = findRoute("POST", "/ai/generate-workflow");
  return route.handler({ req: { url: "/ai/generate-workflow" } as never, res: {} as never, auth: auth as never }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockResolvedValue(undefined as never);
  readJsonMock.mockResolvedValue({ prompt: "make a flow" } as never);
});

describe("POST /ai/generate-workflow — generationMode dispatch", () => {
  it("free_json: parses generateText output and audits generationMode=free_json", async () => {
    const llm = makeLlm({ text: [VALID_JSON] });
    setRuntime("free_json", llm);

    const res = await callGenerate();

    expect(llm.generateText).toHaveBeenCalledTimes(1);
    expect(llm.generateObject).not.toHaveBeenCalled();
    expect(res.payload.mode).toBe("ai");
    expect(res.payload.model).toBe("claude-haiku-4-5-20251001");
    expect(res.payload.nodes[0].type).toBe("http");

    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("ai");
    expect(meta.generationMode).toBe("free_json");
    expect(meta.generationAttempts).toBe(1);
  });

  it("free_json: retries then falls back when parsing never succeeds", async () => {
    const llm = makeLlm({ text: ["garbage", "still garbage"] });
    setRuntime("free_json", llm);

    const res = await callGenerate();

    expect(llm.generateText).toHaveBeenCalledTimes(2); // FREE_JSON_MAX_ATTEMPTS
    expect(res.payload.mode).toBe("fallback");
    expect(typeof res.payload.aiError).toBe("string");

    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
    expect(meta.generationMode).toBe("free_json");
  });

  it("constrained: uses generateObject and audits generationMode=constrained", async () => {
    const llm = makeLlm({ object: VALID_WORKFLOW });
    setRuntime("constrained", llm);

    const res = await callGenerate();

    expect(llm.generateObject).toHaveBeenCalledTimes(1);
    expect(llm.generateText).not.toHaveBeenCalled();
    expect(res.payload.mode).toBe("ai");

    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("ai");
    expect(meta.generationMode).toBe("constrained");
    expect(meta.generationAttempts).toBe(1);
  });
});
