/** Route-contract coverage for evidence-gated Recovery Playbooks. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dataMocks = vi.hoisted(() => ({
  activate: vi.fn(),
  createDraft: vi.fn(),
  findMatch: vi.fn(),
  recordApplied: vi.fn(),
  recordValidation: vi.fn(),
  resolveOutcome: vi.fn(),
  resolvePromotion: vi.fn(),
  retire: vi.fn(),
}));

vi.mock("@janusly/data", () => ({
  activateRecoveryPlaybook: dataMocks.activate,
  createRecoveryPlaybookDraft: dataMocks.createDraft,
  findMatchingActiveRecoveryPlaybook: dataMocks.findMatch,
  RECOVERY_PLAYBOOK_INSTRUCTIONS_MAX_CHARS: 4000,
  RECOVERY_PLAYBOOK_TITLE_MAX_CHARS: 120,
  recordRecoveryPlaybookApplied: dataMocks.recordApplied,
  recordRecoveryPlaybookValidationOutcome: dataMocks.recordValidation,
  resolveRecoveryPlaybookOutcomeFacts: dataMocks.resolveOutcome,
  resolveRecoveryPlaybookPromotionEvidence: dataMocks.resolvePromotion,
  retireRecoveryPlaybook: dataMocks.retire,
}));

vi.mock("../dlq", () => ({ getDeadLetter: vi.fn() }));
vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));
vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readJson: vi.fn(),
    sendError: vi.fn((_res: unknown, code: string, error: string, status = 400) => ({ payload: { error, code }, status })),
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  };
});

import { auditAction } from "../audit-helper";
import { getDeadLetter } from "../dlq";
import { readJson } from "../http";
import type { Route } from "../routes";
import { recoveryPlaybooksRoutes } from "./recovery-playbooks-routes";

const readJsonMock = vi.mocked(readJson);
const getDeadLetterMock = vi.mocked(getDeadLetter);
const auditActionMock = vi.mocked(auditAction);

const auth = { orgId: "org-a", userId: "operator", mode: "dev-headers", source: "dev" } as const;
const workflow = {
  id: "wf-a",
  name: "Billing recovery",
  dslVersion: "1.0",
  nodes: [{ id: "fetch", type: "http", config: { url: "https://example.com", method: "GET", timeoutMs: 5000 } }],
  edges: [],
};
const failedWorkflow = {
  ...workflow,
  nodes: [{ id: "fetch", type: "http", config: { url: "https://example.com", method: "GET", timeoutMs: 1000 } }],
};
const deadLetter = {
  id: "dlq-a",
  orgId: "org-a",
  runId: "run-a",
  nodeId: "fetch",
  attempt: 1,
  workflowJson: failedWorkflow,
  nodeJson: failedWorkflow.nodes[0],
  errorJson: { message: "request timed out" },
  status: "replayed",
  replayedAt: new Date("2026-07-11T10:05:00Z"),
  createdAt: new Date("2026-07-11T10:00:00Z"),
};
const playbook = {
  id: "pb-a",
  orgId: "org-a",
  workflowId: "wf-a",
  signature: "HTTP timeout on http node",
  version: 1,
  status: "active",
  title: "Recover billing",
  instructionsMarkdown: "Apply the bounded timeout change.",
  evidenceRequirementsJson: {},
  sourceWorkflowVersionId: "wv-a",
  approachLabel: "raise_timeout",
  successfulUses: 2,
  regressions: 0,
  lastValidatedAt: new Date("2026-07-11T10:02:00Z"),
  lastValidationRunId: "validation-source",
  lastAppliedValidationRunId: null,
  activatedAt: new Date("2026-07-11T10:06:00Z"),
  retiredAt: null,
  createdBy: "operator",
  updatedBy: "operator",
  createdAt: new Date("2026-07-11T10:05:00Z"),
  updatedAt: new Date("2026-07-11T10:06:00Z"),
} as const;

function route(method: Route["method"], url: string): Route {
  const found = recoveryPlaybooksRoutes.find((candidate) => candidate.method === method && (
    typeof candidate.match === "string" ? candidate.match === url : candidate.match(url)
  ));
  if (!found) throw new Error(`route not found: ${method} ${url}`);
  return found;
}

async function call(method: Route["method"], url: string) {
  return route(method, url).handler({ req: { url } as never, res: {} as never, auth: auth as never });
}

beforeEach(() => {
  vi.clearAllMocks();
  getDeadLetterMock.mockResolvedValue(deadLetter as never);
  auditActionMock.mockResolvedValue(undefined);
  dataMocks.findMatch.mockResolvedValue({ ...playbook, sourceWorkflow: workflow });
  dataMocks.createDraft.mockResolvedValue({ playbook: { ...playbook, status: "draft" }, created: true });
  dataMocks.recordValidation.mockResolvedValue({ playbook, recorded: true });
  dataMocks.recordApplied.mockResolvedValue({ playbook: { ...playbook, successfulUses: 3 }, recorded: true });
});

describe("Recovery Playbook route declarations", () => {
  it("requires recovery.read for matching and editor + recovery.write for every mutation", () => {
    expect(route("GET", "/recovery/playbooks/match?deadLetterId=dlq-a")).toMatchObject({ role: "viewer", permission: "recovery.read" });
    expect(route("POST", "/recovery/playbooks")).toMatchObject({ role: "editor", permission: "recovery.write" });
    expect(route("POST", "/recovery/playbooks/pb-a/use")).toMatchObject({ role: "editor", permission: "recovery.write" });
  });

  it("rejects malformed encoded playbook ids without throwing", async () => {
    const result = await call("POST", "/recovery/playbooks/%E0%A4%A/use");
    expect(result).toMatchObject({ status: 404, payload: { code: "recovery_playbook_not_found" } });
  });
});

describe("GET /recovery/playbooks/match", () => {
  it("derives the org-scoped exact match without returning the executable source DAG", async () => {
    const result = await call("GET", "/recovery/playbooks/match?deadLetterId=dlq-a");
    expect(getDeadLetterMock).toHaveBeenCalledWith("org-a", "dlq-a");
    expect(dataMocks.findMatch).toHaveBeenCalledWith("org-a", "wf-a", expect.any(String));
    expect(result).toMatchObject({ payload: { playbook: { id: "pb-a", status: "active" } }, status: 200 });
    expect(JSON.stringify(result)).not.toContain("https://example.com");
  });
});

describe("POST /recovery/playbooks", () => {
  const body = {
    deadLetterId: "dlq-a",
    validationRunId: "validation-a",
    sourceWorkflowVersionId: "wv-a",
    title: "Recover billing",
    instructionsMarkdown: "Apply the proven timeout change.",
  };

  it("rejects promotion when the server cannot find non-empty patch evidence", async () => {
    readJsonMock.mockResolvedValueOnce(body);
    dataMocks.resolvePromotion.mockResolvedValue({
      deadLetter,
      validationRun: { id: "validation-a", status: "succeeded", replayMode: "validation", parentRunId: "run-a", inputJson: { workflow: failedWorkflow }, createdAt: new Date("2026-07-11T10:01:00Z") },
      sourceVersion: { id: "wv-a", workflowId: "wf-a", dagJson: failedWorkflow, createdAt: new Date("2026-07-11T10:02:00Z") },
      acceptedFeedback: { id: "feedback-a", workflowId: "wf-a", approachLabel: "raise_timeout", suggestionMode: "ai", createdAt: new Date("2026-07-11T10:06:00Z") },
    });

    const result = await call("POST", "/recovery/playbooks");
    expect(result).toMatchObject({ status: 422, payload: { code: "recovery_playbook_evidence_required" } });
    expect(dataMocks.createDraft).not.toHaveBeenCalled();
  });

  it("creates a draft from the exact applied sandbox snapshot and server-owned evidence", async () => {
    readJsonMock.mockResolvedValueOnce(body);
    dataMocks.resolvePromotion.mockResolvedValue({
      deadLetter,
      validationRun: { id: "validation-a", status: "succeeded", replayMode: "validation", parentRunId: "run-a", inputJson: { workflow }, createdAt: new Date("2026-07-11T10:01:00Z") },
      sourceVersion: { id: "wv-a", workflowId: "wf-a", dagJson: workflow, createdAt: new Date("2026-07-11T10:02:00Z") },
      acceptedFeedback: { id: "feedback-a", workflowId: "wf-a", approachLabel: "raise_timeout", suggestionMode: "ai", createdAt: new Date("2026-07-11T10:06:00Z") },
    });

    const result = await call("POST", "/recovery/playbooks");
    expect(dataMocks.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-a",
      workflowId: "wf-a",
      sourceWorkflowVersionId: "wv-a",
      validationRunId: "validation-a",
      approachLabel: "raise_timeout",
      evidenceRequirementsJson: expect.objectContaining({
        requiredOnEveryUse: ["sandbox_validation", "explicit_production_apply"],
        sourceEvidence: expect.objectContaining({ patchChangeCount: 1 }),
      }),
    }));
    expect(result).toMatchObject({ status: 201, payload: { playbook: { status: "draft" }, created: true } });
    expect(auditActionMock).toHaveBeenCalledWith(auth, "recovery.playbook.created", expect.objectContaining({ targetId: "pb-a" }));
  });

  it("rejects a replay that predates the validated and saved recovery", async () => {
    readJsonMock.mockResolvedValueOnce(body);
    dataMocks.resolvePromotion.mockResolvedValue({
      deadLetter: { ...deadLetter, replayedAt: new Date("2026-07-11T10:00:30Z") },
      validationRun: { id: "validation-a", status: "succeeded", replayMode: "validation", parentRunId: "run-a", inputJson: { workflow }, createdAt: new Date("2026-07-11T10:01:00Z") },
      sourceVersion: { id: "wv-a", workflowId: "wf-a", dagJson: workflow, createdAt: new Date("2026-07-11T10:02:00Z") },
      acceptedFeedback: { id: "feedback-a", workflowId: "wf-a", approachLabel: "raise_timeout", suggestionMode: "ai", createdAt: new Date("2026-07-11T10:06:00Z") },
    });

    const result = await call("POST", "/recovery/playbooks");
    expect(result).toMatchObject({ status: 422, payload: { code: "recovery_playbook_apply_required" } });
    expect(dataMocks.createDraft).not.toHaveBeenCalled();
  });
});

describe("explicit use and outcome", () => {
  it("returns the immutable source as a playbook suggestion and audits explicit use", async () => {
    readJsonMock.mockResolvedValueOnce({ deadLetterId: "dlq-a" });
    const result = await call("POST", "/recovery/playbooks/pb-a/use");
    expect(result).toMatchObject({
      status: 200,
      payload: { suggestion: { mode: "playbook", playbook: { id: "pb-a" }, suggestedWorkflow: workflow } },
    });
    expect(auditActionMock).toHaveBeenCalledWith(auth, "recovery.playbook.used", expect.any(Object));
  });

  it("retires a playbook on a verified failed validation and records the outcome once", async () => {
    readJsonMock.mockResolvedValueOnce({ deadLetterId: "dlq-a", validationRunId: "validation-failed", phase: "validation" });
    dataMocks.resolveOutcome.mockResolvedValue({
      playbook,
      deadLetter,
      validationRun: {
        id: "validation-failed",
        status: "failed",
        replayMode: "validation",
        parentRunId: "run-a",
        inputJson: { workflow, recoveryPlaybookId: "pb-a" },
      },
    });
    dataMocks.recordValidation.mockResolvedValue({ playbook: { ...playbook, status: "retired", regressions: 1 }, recorded: true });

    const result = await call("POST", "/recovery/playbooks/pb-a/outcome");
    expect(dataMocks.recordValidation).toHaveBeenCalledWith(expect.objectContaining({ succeeded: false, validationRunId: "validation-failed" }));
    expect(dataMocks.recordApplied).not.toHaveBeenCalled();
    expect(result).toMatchObject({ payload: { playbook: { status: "retired", regressions: 1 } }, status: 200 });
    expect(auditActionMock).toHaveBeenCalledWith(auth, "recovery.playbook.regressed", expect.any(Object));
  });

  it("rejects enqueue-only apply evidence even after a passed sandbox", async () => {
    readJsonMock.mockResolvedValueOnce({ deadLetterId: "dlq-a", validationRunId: "validation-ok", phase: "applied" });
    dataMocks.resolveOutcome.mockResolvedValue({
      playbook,
      deadLetter,
      validationRun: {
        id: "validation-ok",
        status: "succeeded",
        replayMode: "validation",
        parentRunId: "run-a",
        inputJson: { workflow, recoveryPlaybookId: "pb-a" },
      },
    });

    const result = await call("POST", "/recovery/playbooks/pb-a/outcome");
    expect(dataMocks.recordValidation).toHaveBeenCalledWith(expect.objectContaining({ succeeded: true }));
    expect(dataMocks.recordApplied).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 422, payload: { code: "recovery_playbook_apply_required" } });
  });

  it("confirms an automatically attributed use only after terminal impact exists", async () => {
    readJsonMock.mockResolvedValueOnce({ deadLetterId: "dlq-a", validationRunId: "validation-ok", phase: "applied" });
    dataMocks.resolveOutcome.mockResolvedValue({
      playbook,
      deadLetter,
      validationRun: {
        id: "validation-ok",
        status: "succeeded",
        replayMode: "validation",
        parentRunId: "run-a",
        inputJson: { workflow, recoveryPlaybookId: "pb-a" },
      },
      impactEvent: {
        deadLetterId: "dlq-a",
        orgId: "org-a",
        runId: "run-a",
        nodeId: "fetch",
        userId: "operator",
        recoveredAt: new Date("2026-07-11T10:07:00Z"),
        downtimeEndedMs: 420_000,
      },
    });
    dataMocks.recordApplied.mockResolvedValue({
      playbook: { ...playbook, successfulUses: 3 },
      recorded: false,
    });

    const result = await call("POST", "/recovery/playbooks/pb-a/outcome");
    expect(dataMocks.recordApplied).toHaveBeenCalledWith(expect.objectContaining({ validationRunId: "validation-ok" }));
    expect(result).toMatchObject({ payload: { playbook: { successfulUses: 3 }, recorded: false }, status: 200 });
    expect(auditActionMock).not.toHaveBeenCalledWith(auth, "recovery.playbook.applied", expect.any(Object));
  });
});
