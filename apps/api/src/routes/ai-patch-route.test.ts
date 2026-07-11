/**
 * Route-level dispatch tests for `POST /ai/patch-workflow`.
 *
 * Locks down (1) the route's `role: "editor"` gate, (2) the AI-mode happy
 * path — a config-only suggestion is merged onto the failing node, validated,
 * and returned as `mode: "ai"` with an `ai.workflow.patch_suggested` audit —
 * and (3) the AI-fallback contract. NOTE: like /ai/suggest-improvement the
 * route calls `suggestWorkflowPatch` WITHOUT a route-level try/catch — the
 * helper owns the try/catch and RETURNS `{ mode: "fallback", aiError, ... }`
 * on any LLM failure. So the fallback test drives that documented envelope;
 * it still audits `mode: "fallback"` (the AGENTS.md AI-mutation invariant —
 * patch audits both paths). The Drizzle reads, DLQ lookup, evidence/feedback
 * enrichment, and memory recall are stubbed; the unit under test is the route
 * wiring + the config-patch merge.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({ runsRows: [] as unknown[], eventRows: [] as unknown[] }));

vi.mock("drizzle-orm", () => ({ eq: vi.fn(), desc: vi.fn(), and: vi.fn(), asc: vi.fn() }));

vi.mock("@janusly/db", () => {
  const chain = (rows: unknown[]) => {
    const b: Record<string, unknown> = {};
    b.from = () => b;
    b.where = () => b;
    b.orderBy = () => b;
    b.limit = () => b;
    b.then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return b;
  };
  return {
    db: {
      select: (_cols?: unknown) => ({
        from: (tbl: { __table?: string }) => chain(tbl?.__table === "runs" ? dbState.runsRows : dbState.eventRows),
      }),
    },
    runs: { __table: "runs" },
    runEvents: { __table: "runEvents" },
    runNodes: { __table: "runNodes" },
    workflowVersions: { __table: "workflowVersions" },
  };
});

vi.mock("@janusly/ai", async () => {
  const actual = await vi.importActual<typeof import("@janusly/ai")>("@janusly/ai");
  return { ...actual, suggestWorkflowPatch: vi.fn() };
});

vi.mock("@janusly/data", () => ({
  summarizePastFeedback: vi.fn(async () => []),
  findLatestOutcomeBySignature: vi.fn(async () => null),
  listCalibrations: vi.fn(async () => []),
  queryRecoveryFeedbackHealth: vi.fn(async () => ({ windowDays: 30, approaches: [] })),
}));

vi.mock("../dlq", () => ({ getDeadLetter: vi.fn() }));
vi.mock("../ai-evidence", () => ({ assembleRecoveryEvidence: vi.fn(async () => []) }));
vi.mock("../ai-patch-feedback", () => ({ composeFeedbackHint: vi.fn(() => "") }));
vi.mock("../ai-recovery-memory", () => ({
  composeRecoveryMemoryHint: vi.fn(async () => ({ snippets: "", hitCount: 0, recallOk: true, entries: [] })),
}));

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
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      ({ payload: params === undefined ? { error: message, code } : { error: message, code, params }, status })),
    readJson: vi.fn(),
  };
});

import { suggestWorkflowPatch } from "@janusly/ai";
import { findLatestOutcomeBySignature, queryRecoveryFeedbackHealth } from "@janusly/data";
import { orgLlmRuntime } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { getDeadLetter } from "../dlq";
import { readJson, } from "../http";
import type { Route } from "../routes";
import { aiPatchRoutes } from "./ai-patch-route";

const orgLlmMock = vi.mocked(orgLlmRuntime);
const auditMock = vi.mocked(auditAction);
const readJsonMock = vi.mocked(readJson);
const getDlqMock = vi.mocked(getDeadLetter);
const patchMock = vi.mocked(suggestWorkflowPatch);
const feedbackHealthMock = vi.mocked(queryRecoveryFeedbackHealth);
const priorOutcomeMock = vi.mocked(findLatestOutcomeBySignature);

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as const;

const WORKFLOW = {
  id: "wf-patch",
  name: "Patched",
  nodes: [{ id: "n1", type: "http", config: { url: "https://old.example.com" } }],
  edges: [],
};
const NODE = { id: "n1", type: "http", config: { url: "https://old.example.com" } };

function setRuntime(calibration = false) {
  orgLlmMock.mockResolvedValue({
    orgConfig: { ai: { promptMaxChars: 4000, rateLimitPerMin: 60, surfaceModels: {}, confidenceCalibrationEnabled: calibration } } as never,
    llm: {} as never,
    llmConfig: {} as never,
  });
}

function setDlq() {
  getDlqMock.mockResolvedValue({
    id: "dlq-1",
    runId: "r1",
    nodeId: "n1",
    nodeJson: NODE,
    workflowJson: WORKFLOW,
    errorJson: { message: "http 500" },
  } as never);
  dbState.runsRows = [{ id: "r1", orgId: "org-1", workflowVersionId: "v1" }];
  dbState.eventRows = [];
}

function findRoute(): Route {
  const route = aiPatchRoutes.find((c) => c.method === "POST" && c.match === "/ai/patch-workflow");
  if (!route) throw new Error("route not found");
  return route;
}

async function callPatch(): Promise<{ payload: any; status: number }> {
  return findRoute().handler({ req: { url: "/ai/patch-workflow", headers: {} } as never, res: {} as never, auth: auth as never }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  auditMock.mockResolvedValue(undefined as never);
  readJsonMock.mockResolvedValue({ deadLetterId: "dlq-1" } as never);
  setRuntime();
  setDlq();
});

describe("POST /ai/patch-workflow — auth gate", () => {
  it("requires the editor role", () => {
    expect(findRoute().role).toBe("editor");
  });
});

describe("POST /ai/patch-workflow — AI mode", () => {
  it("merges a config suggestion, returns mode:ai, and audits mode:ai", async () => {
    patchMock.mockResolvedValue({
      mode: "ai",
      suggestions: [{
        patchedConfig: { url: "https://new.example.com" },
        rationale: "point at the new endpoint",
        approachLabel: "config",
        confidence: 72,
      }],
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
    } as never);

    const res = await callPatch();

    expect(res.payload.mode).toBe("ai");
    expect(res.payload.suggestions).toHaveLength(1);
    expect(res.payload.suggestions[0].confidence).toBe(72);
    // The merged workflow carries the patched url on the failing node.
    expect(res.payload.suggestedWorkflow.nodes[0].config.url).toBe("https://new.example.com");
    expect(res.payload.evidence).toEqual([]);
    expect(res.payload.feedbackHealth).toEqual({ windowDays: 30, approaches: [] });
    expect(res.payload.recoveryPassport).toEqual({
      failureSignature: "HTTP 500 on http node",
      priorSameSignatureOutcome: null,
    });
    expect(res.payload.suggestions[0].safety).toEqual({
      writeSide: false,
      approvalRequired: false,
      approvalPresent: true,
    });
    expect(priorOutcomeMock).toHaveBeenCalledWith("org-1", "HTTP 500 on http node", "dlq-1");
    expect(feedbackHealthMock).toHaveBeenCalledWith("org-1", "wf-patch");

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]?.[1]).toBe("ai.workflow.patch_suggested");
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("ai");
    expect(meta.patchStyle).toBe("config_only");
    expect(meta.suggestionsCount).toBe(1);
  });

  it("surfaces the latest same-signature healing outcome without exposing its patch", async () => {
    priorOutcomeMock.mockResolvedValueOnce({
      status: "validation_failed",
      approachLabel: "add_retry",
      declineReason: "validation_failed",
      updatedAt: new Date("2026-07-10T12:00:00.000Z"),
    } as never);
    patchMock.mockResolvedValue({
      mode: "ai",
      suggestions: [{
        patchedConfig: { retry: { maxAttempts: 3 } },
        rationale: "retry transient failures",
        approachLabel: "add_retry",
        confidence: 70,
      }],
    } as never);

    const res = await callPatch();

    expect(res.payload.recoveryPassport.priorSameSignatureOutcome).toEqual({
      status: "validation_failed",
      approachLabel: "add_retry",
      declineReason: "validation_failed",
      occurredAt: "2026-07-10T12:00:00.000Z",
    });
  });

  it("projects write-side and upstream approval posture for the selected patch", async () => {
    const writeNode = { id: "n1", type: "http", config: { url: "https://old.example.com", method: "POST" } };
    getDlqMock.mockResolvedValue({
      id: "dlq-1",
      runId: "r1",
      nodeId: "n1",
      nodeJson: writeNode,
      workflowJson: {
        id: "wf-patch",
        name: "Patched",
        nodes: [{ id: "approve", type: "approval", config: { message: "Approve" } }, writeNode],
        edges: [{ from: "approve", to: "n1" }],
      },
      errorJson: { message: "http 500" },
    } as never);
    patchMock.mockResolvedValue({
      mode: "ai",
      suggestions: [{
        patchedConfig: { retry: { maxAttempts: 3 } },
        rationale: "retry transient failure",
        approachLabel: "add_retry",
        confidence: 75,
      }],
    } as never);

    const res = await callPatch();

    expect(res.payload.suggestions[0].safety).toEqual({
      writeSide: true,
      approvalRequired: true,
      approvalPresent: true,
    });
  });
});

describe("POST /ai/patch-workflow — fallback contract", () => {
  it("passes through the helper's mode:fallback envelope and still audits", async () => {
    patchMock.mockResolvedValue({
      mode: "fallback",
      suggestions: [{
        patchedConfig: {},
        rationale: "LLM unavailable",
        approachLabel: "other",
        confidence: 0,
      }],
      aiError: "rate_limited",
    } as never);

    const res = await callPatch();

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.aiError).toBe("rate_limited");
    // Fallback leaves the original workflow unchanged.
    expect(res.payload.suggestedWorkflow.nodes[0].config.url).toBe("https://old.example.com");
    expect(res.payload.recoveryPassport.failureSignature).toBe("HTTP 500 on http node");
    expect(res.payload.suggestions[0].safety.writeSide).toBe(false);

    expect(auditMock).toHaveBeenCalledTimes(1);
    const meta = (auditMock.mock.calls[0]?.[2]?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.mode).toBe("fallback");
    expect(meta.aiError).toBe("rate_limited");
  });

  it("returns 400 when deadLetterId is missing (before any LLM call)", async () => {
    readJsonMock.mockResolvedValue({} as never);

    const res = await callPatch();

    expect(res.status).toBe(400);
    expect(patchMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the DLQ entry is not found", async () => {
    getDlqMock.mockResolvedValue(null as never);

    const res = await callPatch();

    expect(res.status).toBe(404);
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("degrades only the feedback-health side channel when its read fails", async () => {
    feedbackHealthMock.mockRejectedValueOnce(new Error("database unavailable"));
    patchMock.mockResolvedValue({
      mode: "fallback",
      suggestions: [{
        patchedConfig: {},
        rationale: "LLM unavailable",
        approachLabel: "other",
        confidence: 0,
      }],
      aiError: "rate_limited",
    } as never);

    const res = await callPatch();

    expect(res.payload.mode).toBe("fallback");
    expect(res.payload.feedbackHealth).toBeUndefined();
    expect(auditMock).toHaveBeenCalledTimes(1);
  });
});
