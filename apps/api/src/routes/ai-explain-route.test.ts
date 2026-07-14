/**
 * Route-level dispatch tests for the two "explain" surfaces:
 * `POST /ai/explain-workflow` and `POST /ai/explain-run`.
 *
 * Locks down (1) both routes are auth-only (no elevated role), (2) the
 * AI-mode happy paths return the model narration and audit `mode: "ai"`, and
 * (3) the AI-fallback contract: explain-workflow degrades to
 * `{ mode: "fallback", aiError, explanation }` when the LLM is missing or
 * throws (and audits its fallback per the AGENTS.md AI-mutation invariant);
 * explain-run surfaces the `explainRun` helper's returned `mode` (the helper
 * owns the try/catch) and audits it. The Drizzle reads + evidence assembly
 * are stubbed; the unit under test is the route wiring.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  runsRows: [] as unknown[],
  versionRows: [] as unknown[],
  eventRows: [] as unknown[],
  nodeRows: [] as unknown[],
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn(), desc: vi.fn(), and: vi.fn(), asc: vi.fn() }));

vi.mock("@janusly/db", () => {
  const chain = (rows: unknown[]) => {
    const b: Record<string, unknown> = {};
    b.from = () => b;
    b.where = () => b;
    b.orderBy = () => b;
    b.limit = () => b;
    // oxlint-disable-next-line unicorn/no-thenable -- Drizzle query builders are intentionally thenable.
    b.then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return b;
  };
  const rowsFor = (t?: string) =>
    t === "runs" ? dbState.runsRows
    : t === "workflowVersions" ? dbState.versionRows
    : t === "runNodes" ? dbState.nodeRows
    : dbState.eventRows;
  return {
    db: { select: (_cols?: unknown) => ({ from: (tbl: { __table?: string }) => chain(rowsFor(tbl?.__table)) }) },
    runs: { __table: "runs" },
    runEvents: { __table: "runEvents" },
    runNodes: { __table: "runNodes" },
    workflowVersions: { __table: "workflowVersions" },
  };
});

vi.mock("@janusly/ai", async () => {
  const actual = await vi.importActual<typeof import("@janusly/ai")>("@janusly/ai");
  return { ...actual, explainRun: vi.fn() };
});

vi.mock("../ai-evidence", () => ({ assembleExplainRunEvidence: vi.fn(async () => []) }));

vi.mock("../ai-runtime", () => ({
  orgLlmRuntime: vi.fn(),
  fallbackExplainWorkflow: vi.fn(() => "deterministic explanation"),
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
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      ({ payload: params === undefined ? { error: message, code } : { error: message, code, params }, status })),
    readJson: vi.fn(),
  };
});

import { explainRun } from "@janusly/ai";
import { orgLlmRuntime } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { readJson, } from "../http";
import type { Route } from "../routes";
import { aiExplainRoutes } from "./ai-explain-route";

const orgLlmMock = vi.mocked(orgLlmRuntime);
const auditMock = vi.mocked(auditAction);
const readJsonMock = vi.mocked(readJson);
const explainRunMock = vi.mocked(explainRun);

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as const;

const WORKFLOW = { id: "wf-x", name: "X", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };

function makeLlm(opts: { text?: string; throws?: boolean }) {
  return {
    generateText: vi.fn(async () => {
      if (opts.throws) throw new Error("boom-explain");
      return { text: opts.text ?? "narration", model: "claude-haiku-4-5-20251001", provider: "anthropic", latencyMs: 5, usage: {} };
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

function findRoute(url: string): Route {
  const route = aiExplainRoutes.find((c) => c.method === "POST" && c.match === url);
  if (!route) throw new Error(`route not found: ${url}`);
  return route;
}

async function call(url: string): Promise<{ payload: any; status: number }> {
  return findRoute(url).handler({ req: { url, headers: {} } as never, res: {} as never, auth: auth as never }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockResolvedValue(undefined as never);
});

describe("explain routes — auth gate", () => {
  it("explain-workflow + explain-run are auth-only (no elevated role)", () => {
    expect(findRoute("/ai/explain-workflow").role).toBeUndefined();
    expect(findRoute("/ai/explain-run").role).toBeUndefined();
  });
});

describe("POST /ai/explain-workflow", () => {
  it("returns mode:ai with the narration and audits mode:ai", async () => {
    readJsonMock.mockResolvedValue({ workflow: WORKFLOW } as never);
    setRuntime(makeLlm({ text: "here is the flow" }));

    const res = await call("/ai/explain-workflow");

    expect(res.payload.mode).toBe("ai");
    expect(res.payload.explanation).toBe("here is the flow");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(auditMock.mock.calls[0]?.[1]).toBe("ai.workflow.explained");
    expect(meta.mode).toBe("ai");
  });

  it("degrades to mode:fallback with the deterministic explanation when the LLM throws, still audits", async () => {
    readJsonMock.mockResolvedValue({ workflow: WORKFLOW } as never);
    setRuntime(makeLlm({ throws: true }));

    const res = await call("/ai/explain-workflow");

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBe("boom-explain");
    expect(res.payload.explanation).toBe("deterministic explanation");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
  });

  it("degrades to mode:fallback when no LLM is configured, still audits", async () => {
    readJsonMock.mockResolvedValue({ workflow: WORKFLOW } as never);
    setRuntime(null);

    const res = await call("/ai/explain-workflow");

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBe("AI provider not configured");
    expect(res.payload.explanation).toBe("deterministic explanation");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
  });
});

describe("POST /ai/explain-run", () => {
  beforeEach(() => {
    readJsonMock.mockResolvedValue({ runId: "r1" } as never);
    setRuntime(makeLlm({ text: "n/a" }));
    dbState.runsRows = [{ id: "r1", orgId: "org-1", workflowVersionId: "v1" }];
    dbState.versionRows = [{ workflowId: "wf-x" }];
    dbState.eventRows = [];
    dbState.nodeRows = [];
  });

  it("returns the helper's mode:ai narration + evidence and audits mode:ai", async () => {
    explainRunMock.mockResolvedValue({
      answer: "the run failed at node n1",
      mode: "ai",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    } as never);

    const res = await call("/ai/explain-run");

    expect(res.payload.mode).toBe("ai");
    expect(res.payload.answer).toBe("the run failed at node n1");
    expect(res.payload.evidence).toEqual([]);
    expect(auditMock.mock.calls[0]?.[1]).toBe("ai.run.explained");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("ai");
  });

  it("surfaces the helper's mode:fallback envelope and audits it", async () => {
    explainRunMock.mockResolvedValue({
      answer: "deterministic run summary",
      mode: "fallback",
      aiError: "quota_exceeded",
    } as never);

    const res = await call("/ai/explain-run");

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBe("quota_exceeded");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
    expect(meta.aiError).toBe("quota_exceeded");
  });

  it("returns 400 when runId is missing", async () => {
    readJsonMock.mockResolvedValue({} as never);

    const res = await call("/ai/explain-run");

    expect(res.status).toBe(400);
    expect(explainRunMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the run is not found / cross-tenant", async () => {
    dbState.runsRows = [];

    const res = await call("/ai/explain-run");

    expect(res.status).toBe(404);
    expect(explainRunMock).not.toHaveBeenCalled();
  });
});
