/**
 * Route tests for POST /runs/redrive — the production continuation of a
 * failed run on the latest (or an explicit) saved workflow version.
 *
 * Pins the registry declaration (role: editor), the pre-adapter rejections
 * (non-failed source, ambiguous failed node, ad-hoc run without a saved
 * version), the happy wiring into `redriveRun` (latest version resolved,
 * source input carried forward, audit written), and the adapter-error → API
 * error-code mapping.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { dbQueue, redriveRunMock, auditActionMock, sendJsonMock } = vi.hoisted(() => ({
  dbQueue: [] as unknown[][],
  redriveRunMock: vi.fn(),
  auditActionMock: vi.fn(),
  sendJsonMock: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
}));

// Thenable query builder: every chained method returns the builder; awaiting
// it dequeues the next scripted result. One queue drives the route's
// sequential selects (runs → runNodes → source version → workflow → target).
function makeBuilder() {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit"]) {
    builder[method] = vi.fn(() => builder);
  }
  // Drizzle's real query builder IS thenable — the route awaits it directly,
  // so the mock must be awaitable too.
  // oxlint-disable-next-line unicorn/no-thenable
  (builder as { then: unknown }).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(dbQueue.shift() ?? []).then(resolve, reject);
  return builder;
}

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gt: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  lt: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  getOrgConfigSnapshot: vi.fn(),
  getRunComparison: vi.fn(),
  getWorkflowStatus: vi.fn(),
  WORKFLOW_STATUS_ACTIVE: "active",
}));

vi.mock("@janusly/db", () => ({
  db: { select: vi.fn(() => makeBuilder()) },
  runEvents: {},
  runNodes: {},
  runs: { id: "runs.id", orgId: "runs.org_id" },
  workflows: { id: "workflows.id", orgId: "workflows.org_id" },
  workflowVersions: { id: "wv.id", orgId: "wv.org_id" },
}));

vi.mock("@janusly/domain", () => ({ replayDecision: vi.fn() }));
vi.mock("@janusly/engine/src/adapters/redrive", () => ({ redriveRun: redriveRunMock }));
vi.mock("@janusly/engine/src/adapters/replay-lab", () => ({
  replayRunAsValidation: vi.fn(),
  replayRunAsValidationFork: vi.fn(),
}));
vi.mock("@janusly/engine/src/inputs-validator", () => ({
  WorkflowInputValidationError: class WorkflowInputValidationError extends Error {},
}));
vi.mock("@janusly/engine/src/persistence", () => ({ cancelRun: vi.fn() }));
vi.mock("@janusly/engine/src/resume-run", () => ({
  ResumeRunConflictError: class ResumeRunConflictError extends Error {},
  resumeRun: vi.fn(),
}));
vi.mock("@janusly/engine/src/start-run", () => ({ startRun: vi.fn() }));
vi.mock("@janusly/engine/src/workflow-readiness", () => ({ checkWorkflowReadiness: vi.fn(() => ({ status: "pass", issues: [] })) }));
vi.mock("@janusly/engine/src/workflow-validation", () => ({
  validateWorkflow: vi.fn(() => ({ valid: true, issues: [] })),
}));

vi.mock("../ai-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("../ai-runtime")>();
  return { ...original, orgLlmRuntime: vi.fn() };
});
vi.mock("../audit-helper", () => ({ auditAction: auditActionMock }));

const bodyBox: { value: unknown } = { value: {} };
vi.mock("../http", () => ({
  asRecord: (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {}),
  corsHeaders: vi.fn(() => ({})),
  readJson: vi.fn(() => Promise.resolve(bodyBox.value)),
  sendEventFrame: vi.fn(),
  sendJson: sendJsonMock,
  sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
    sendJsonMock(_res, params === undefined ? { error: message, code } : { error: message, code, params }, status)),
  sendSseComment: vi.fn(),
}));
vi.mock("../rate-limit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("../readiness-helpers", () => ({
  checkRollbackAvailability: vi.fn(),
  getCredentialReadinessIssues: vi.fn(),
  mergeReadiness: vi.fn(),
  productionSecretRefResolver: {},
}));

import { runsRoutes } from "./runs-routes";
import type { Route } from "../routes";

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as never;

function redriveRoute(): Route {
  const route = runsRoutes.find((r) => r.method === "POST" && typeof r.match === "string" && r.match === "/runs/redrive");
  if (!route) throw new Error("/runs/redrive route not found");
  return route;
}

function invoke() {
  return redriveRoute().handler({ req: { url: "/runs/redrive" } as never, res: {} as never, auth });
}

const SOURCE_RUN = {
  id: "run-1",
  orgId: "org-1",
  status: "failed",
  workflowVersionId: "wfv-1",
  inputJson: { workflow: { id: "wf-1" }, input: { orderId: "o-9" } },
};
const VALID_DAG = { id: "wf-1", name: "WF", nodes: [{ id: "n1", type: "noop", config: {} }], edges: [] };

afterEach(() => {
  vi.clearAllMocks();
  dbQueue.length = 0;
  bodyBox.value = {};
});

describe("POST /runs/redrive declaration", () => {
  it("declares role: editor", () => {
    expect(redriveRoute().role).toBe("editor");
  });
});

describe("POST /runs/redrive rejections", () => {
  it("409s when the source run is not failed", async () => {
    bodyBox.value = { runId: "run-1" };
    dbQueue.push([{ ...SOURCE_RUN, status: "succeeded" }]);
    await invoke();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "runs_redrive_source_not_failed" }), 409);
    expect(redriveRunMock).not.toHaveBeenCalled();
  });

  it("400s with the candidate list when multiple nodes failed and no nodeId was given", async () => {
    bodyBox.value = { runId: "run-1" };
    dbQueue.push([SOURCE_RUN]);
    dbQueue.push([
      { nodeId: "a", status: "failed" },
      { nodeId: "b", status: "failed" },
    ]);
    await invoke();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "runs_redrive_node_ambiguous", params: { nodeIds: "a, b" } }),
      400,
    );
  });

  it("409s for an ad-hoc run whose version id has no saved row", async () => {
    bodyBox.value = { runId: "run-1" };
    dbQueue.push([SOURCE_RUN]);
    dbQueue.push([{ nodeId: "n1", status: "failed" }]);
    dbQueue.push([]); // no workflow_versions row → ad-hoc
    await invoke();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "runs_redrive_requires_saved_workflow" }), 409);
  });

  it("maps the adapter's predecessor rejection onto the API error code", async () => {
    bodyBox.value = { runId: "run-1" };
    dbQueue.push([SOURCE_RUN]);
    dbQueue.push([{ nodeId: "n1", status: "failed" }]);
    dbQueue.push([{ workflowId: "wf-1" }]);
    dbQueue.push([{ id: "wf-1", status: "active" }]);
    dbQueue.push([{ id: "wfv-2", workflowId: "wf-1", dagJson: VALID_DAG }]);
    redriveRunMock.mockResolvedValueOnce({ ok: false, code: "predecessor_not_succeeded", message: "nope" });
    await invoke();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "runs_redrive_predecessor_not_succeeded" }), 409);
  });
});

describe("POST /runs/redrive happy path", () => {
  it("resolves the latest version, forwards the source input, audits, and returns the continuation run id", async () => {
    bodyBox.value = { runId: "run-1" };
    dbQueue.push([SOURCE_RUN]);
    dbQueue.push([{ nodeId: "n1", status: "failed" }]);
    dbQueue.push([{ workflowId: "wf-1" }]);
    dbQueue.push([{ id: "wf-1", status: "active" }]);
    dbQueue.push([{ id: "wfv-2", workflowId: "wf-1", dagJson: VALID_DAG }]);
    redriveRunMock.mockResolvedValueOnce({ ok: true, runId: "run-2", predecessorCount: 0 });

    await invoke();

    expect(redriveRunMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      sourceRunId: "run-1",
      failedNodeId: "n1",
      targetWorkflowVersionId: "wfv-2",
      input: { orderId: "o-9" },
      createdBy: "user-1",
    }));
    expect(auditActionMock).toHaveBeenCalledWith(auth, "run.redrive", expect.objectContaining({
      targetType: "run",
      targetId: "run-2",
    }));
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), { runId: "run-2" });
  });
});
