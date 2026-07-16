/**
 * Route-level dispatch tests for `POST /ai/generate-workflow`.
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
  // Real (pure) implementation — the route's per-surface model precedence is
  // under test, so a passthrough mock would defeat the assertions.
  resolveSurfaceModel: (
    surfaceModels: Record<string, string>,
    surface: string,
    requestOverride?: string,
  ) => requestOverride ?? surfaceModels?.[surface] ?? undefined,
}));

vi.mock("../ai-generation-memory", () => ({
  composeGenerationExemplars: vi.fn(async () => ({ block: "", ids: [], count: 0 })),
  recordGenerationExemplar: vi.fn(async () => {}),
}));
vi.mock("../ai-operator-guidance", () => ({
  loadOperatorGuidance: vi.fn(async () => ""),
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

import { composeGenerationExemplars, recordGenerationExemplar } from "../ai-generation-memory";
import { loadOperatorGuidance } from "../ai-operator-guidance";
import { orgLlmRuntime } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { gateBudget } from "../budget-gate";
import { readJson } from "../http";
import type { Route } from "../routes";
import { aiRoutes } from "./ai-routes";
import { promoteNoopPlaceholders } from "@janusly/ai";
import { listExposedMcpToolsForAi } from "@janusly/data";

const orgLlmMock = vi.mocked(orgLlmRuntime);
const promoteMock = vi.mocked(promoteNoopPlaceholders);
const exposedMcpMock = vi.mocked(listExposedMcpToolsForAi);
const exemplarsMock = vi.mocked(composeGenerationExemplars);
const recordExemplarMock = vi.mocked(recordGenerationExemplar);
const operatorGuidanceMock = vi.mocked(loadOperatorGuidance);
const auditMock = vi.mocked(auditAction);
const gateBudgetMock = vi.mocked(gateBudget);
const readJsonMock = vi.mocked(readJson);

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

function setRuntime(
  generationMode: string,
  llm: ReturnType<typeof makeLlm>,
  generationCandidates = 1,
  surfaceModels: Record<string, string> = {},
) {
  orgLlmMock.mockResolvedValue({
    orgConfig: { ai: { generationMode, generationCandidates, promptMaxChars: 4000, rateLimitPerMin: 60, surfaceModels, operatorGuidance: "Prefer approval gates." } } as never,
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
  gateBudgetMock.mockResolvedValue({
    envelope: { allowed: true, warningThresholdCrossed: false },
    blocked: false,
  } as never);
  // Default: memory off → no exemplars (each test that wants few-shot opts in).
  exemplarsMock.mockResolvedValue({ block: "", ids: [], count: 0 });
  recordExemplarMock.mockResolvedValue(undefined);
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
    // sanitizeAiWorkflow is a passthrough mock here, so the draft validates
    // on the first try and the self-repair loop never fires.
    expect(meta.repairAttempts).toBe(0);
    // Default generationCandidates = 1 → single-shot, candidateCount 1.
    expect(meta.candidateCount).toBe(1);
    expect(res.payload.candidateCount).toBe(1);
    // Memory off (default mock) → no exemplars logged.
    expect(meta.exemplarCount).toBe(0);
  });

  it("free_json: threads recalled few-shot exemplars into the prompt + audit, writes one back", async () => {
    exemplarsMock.mockResolvedValue({ block: "Similar prior workflows...\n- Request: a -> Shape: b", ids: ["ex1", "ex2"], count: 2 });
    const llm = makeLlm({ text: [VALID_JSON] });
    setRuntime("free_json", llm);

    const res = await callGenerate();

    expect(res.payload.mode).toBe("ai");
    expect(exemplarsMock).toHaveBeenCalledWith("org-1", "make a flow");
    // Write side fired exactly once on success.
    expect(recordExemplarMock).toHaveBeenCalledTimes(1);

    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.exemplarCount).toBe(2);
    expect(meta.exemplarIds).toEqual(["ex1", "ex2"]);
  });

  it("free_json: Best-of-N samples N candidates and reports candidateCount", async () => {
    const llm = makeLlm({ text: [VALID_JSON, VALID_JSON, VALID_JSON] });
    setRuntime("free_json", llm, 3);

    const res = await callGenerate();

    // One generateText per candidate (sanitize is a passthrough mock, so all
    // three "validate"; the winner is selected by readiness and re-promoted).
    expect(llm.generateText).toHaveBeenCalledTimes(3);
    expect(res.payload.mode).toBe("ai");
    expect(res.payload.candidateCount).toBe(3);

    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.candidateCount).toBe(3);
    expect(meta.validCandidates).toBe(3);
  });

  it("free_json: Best-of-N fallback reports sampled candidates", async () => {
    const llm = makeLlm({ text: ["garbage", "still garbage", "also garbage", "retry garbage", "final garbage"] });
    setRuntime("free_json", llm, 3);

    const res = await callGenerate();

    // Three Best-of-N samples parse to zero candidates, then the single-shot
    // retry path spends its two parse attempts before falling back.
    expect(llm.generateText).toHaveBeenCalledTimes(5);
    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.candidateCount).toBe(3);

    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
    expect(meta.candidateCount).toBe(3);
    expect(meta.validCandidates).toBe(0);
  });

  it("free_json: reports and audits a budget-driven Best-of-N backoff", async () => {
    gateBudgetMock.mockResolvedValueOnce({
      envelope: { allowed: true, warningThresholdCrossed: true },
      blocked: false,
    } as never);
    const llm = makeLlm({ text: [VALID_JSON] });
    setRuntime("free_json", llm, 4);

    const res = await callGenerate();

    expect(llm.generateText).toHaveBeenCalledTimes(1);
    expect(res.payload).toMatchObject({
      mode: "ai",
      candidateCount: 1,
      bonBackoff: { from: 4, to: 1 },
    });
    expect(auditMock).toHaveBeenNthCalledWith(
      1,
      auth,
      "ai.generation.candidates_backoff",
      {
        targetType: "ai",
        metadata: { from: 4, to: 1, reason: "budget_warning_threshold" },
      },
    );
    const generatedAudit = auditMock.mock.calls.find((call) => call[1] === "ai.workflow.generated");
    expect(generatedAudit?.[2]?.metadata).toMatchObject({
      candidateCount: 1,
      bonBackoff: { from: 4, to: 1 },
    });
  });

  it("free_json: retries then falls back when parsing never succeeds", async () => {
    const llm = makeLlm({ text: ["garbage", "still garbage"] });
    setRuntime("free_json", llm);

    const res = await callGenerate();

    expect(llm.generateText).toHaveBeenCalledTimes(2); // FREE_JSON_MAX_ATTEMPTS
    expect(res.payload.mode).toBe("fallback");
    expect(typeof res.payload.aiError).toBe("string");
    expect(res.payload.candidateCount).toBe(1);

    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
    expect(meta.generationMode).toBe("free_json");
    expect(meta.candidateCount).toBe(1);
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

describe("POST /ai/generate-workflow — system-prompt caching + per-surface model", () => {
  // The mock fns are declared with no args, so `mock.calls[i]` types as an
  // empty tuple under `tsc`; cast to read the captured option object (mirrors
  // the pattern in `ai-generate-freejson.test.ts`).
  const firstCall = (fn: unknown) =>
    (fn as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;

  it("free_json: opts the generation system prompt into Anthropic caching", async () => {
    const llm = makeLlm({ text: [VALID_JSON] });
    setRuntime("free_json", llm);

    await callGenerate();

    expect(firstCall(llm.generateText).cacheSystemPrompt).toBe(true);
  });

  it("constrained: opts the generation system prompt into Anthropic caching", async () => {
    const llm = makeLlm({ object: VALID_WORKFLOW });
    setRuntime("constrained", llm);

    await callGenerate();

    expect(firstCall(llm.generateObject).cacheSystemPrompt).toBe(true);
  });

  it("threads organization guidance into every generation mode's system prompt", async () => {
    operatorGuidanceMock.mockResolvedValueOnce("Organization guidance:\n| Prefer approval gates.");
    const llm = makeLlm({ text: [VALID_JSON] });
    setRuntime("free_json", llm);

    await callGenerate();

    expect(operatorGuidanceMock).toHaveBeenCalledWith({
      orgId: "org-1",
      orgGuidance: "Prefer approval gates.",
    });
    expect(firstCall(llm.generateText).system).toContain("Organization guidance:\n| Prefer approval gates.");
  });

  it("threads the per-surface model as the modelHint when no request override", async () => {
    const llm = makeLlm({ text: [VALID_JSON] });
    setRuntime("free_json", llm, 1, { "generate-workflow": "claude-sonnet-4-5" });

    await callGenerate();

    expect(firstCall(llm.generateText).modelHint).toBe("claude-sonnet-4-5");
  });

  it("lets the per-request body.model override the per-surface model", async () => {
    readJsonMock.mockResolvedValue({ prompt: "make a flow", model: "anthropic/claude-opus-4" } as never);
    const llm = makeLlm({ text: [VALID_JSON] });
    setRuntime("free_json", llm, 1, { "generate-workflow": "claude-sonnet-4-5" });

    await callGenerate();

    expect(firstCall(llm.generateText).modelHint).toBe("anthropic/claude-opus-4");
  });
});

describe("POST /ai/generate-workflow — MCP tool promotion wiring", () => {
  it("threads the org's exposed MCP tools into the Pass-2 promoter", async () => {
    const llm = makeLlm({ text: [VALID_JSON] });
    setRuntime("free_json", llm);
    const tools = [{ connectionAlias: "notion", toolName: "pages.update", description: "Update a Notion page" }];
    exposedMcpMock.mockResolvedValueOnce(tools as never);

    await callGenerate();

    // The route fetches the exposed-tool list once (for the system prompt)
    // and hands the SAME list to the deterministic mcp_tool promotion family.
    expect(promoteMock).toHaveBeenCalledTimes(1);
    expect(promoteMock.mock.calls[0]![0].availableMcpTools).toEqual(tools);
  });

  it("passes the empty exposed-tool list through when no connection opts into exposeToAi", async () => {
    const llm = makeLlm({ text: [VALID_JSON] });
    setRuntime("free_json", llm);
    // Default mock already resolves []; assert the route forwards it verbatim.

    await callGenerate();

    expect(promoteMock).toHaveBeenCalledTimes(1);
    expect(promoteMock.mock.calls[0]![0].availableMcpTools).toEqual([]);
  });
});
