/**
 * Route-level tests for the `/start` upstream-health pause gate + force-run
 * override (the "manual override" acceptance case).
 *
 * The gate: a saved workflow whose `workflows.status` is
 * `paused_upstream_degraded` rejects new run starts with HTTP 409 +
 * `code: "upstream_degraded"` — UNLESS the body carries
 * `forceRunDuringPause: true`, in which case the run proceeds and a
 * `workflow.force_run_during_pause` audit row is written.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auditActionMock,
  bodyBox,
  enforceRateLimitMock,
  getOrgConfigSnapshotMock,
  getWorkflowStatusMock,
  ownedRowsBox,
  sendJsonMock,
  startRunMock,
} = vi.hoisted(() => ({
  auditActionMock: vi.fn(),
  bodyBox: { value: {} as unknown },
  enforceRateLimitMock: vi.fn(),
  getOrgConfigSnapshotMock: vi.fn(),
  getWorkflowStatusMock: vi.fn(),
  ownedRowsBox: { rows: [] as unknown[] },
  sendJsonMock: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  startRunMock: vi.fn(),
}));

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
  getOrgConfigSnapshot: getOrgConfigSnapshotMock,
  getRunComparison: vi.fn(),
  getWorkflowStatus: getWorkflowStatusMock,
  WORKFLOW_STATUS_ACTIVE: "active",
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(ownedRowsBox.rows)),
      })),
    })),
  },
  runEvents: {},
  runNodes: {},
  runs: { id: "runs.id", orgId: "runs.org_id" },
  workflows: { id: "workflows.id", orgId: "workflows.org_id" },
  workflowVersions: { id: "wv.id", orgId: "wv.org_id" },
}));

vi.mock("@janusly/domain", () => ({ replayDecision: vi.fn() }));
vi.mock("@janusly/engine/src/adapters/redrive", () => ({ redriveRun: vi.fn() }));
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
vi.mock("@janusly/engine/src/start-run", () => ({ startRun: startRunMock }));
vi.mock("@janusly/engine/src/workflow-readiness", () => ({ checkWorkflowReadiness: vi.fn() }));
vi.mock("@janusly/engine/src/workflow-validation", () => ({
  validateWorkflow: vi.fn(() => ({ valid: true, issues: [] })),
}));

vi.mock("../ai-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("../ai-runtime")>();
  return { ...original, orgLlmRuntime: vi.fn() };
});
vi.mock("../audit-helper", () => ({ auditAction: auditActionMock }));
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
vi.mock("../rate-limit", () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock("../readiness-helpers", () => ({
  checkRollbackAvailability: vi.fn(),
  getCredentialReadinessIssues: vi.fn(),
  mergeReadiness: vi.fn(),
  productionSecretRefResolver: {},
}));

import { runsRoutes } from "./runs-routes";
import type { Route } from "../routes";

const auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" } as never;

function startRoute(): Route {
  const route = runsRoutes.find((r) => r.method === "POST" && typeof r.match === "string" && r.match === "/start");
  if (!route) throw new Error("/start route not found");
  return route;
}

async function callStart() {
  return startRoute().handler({ req: { url: "/start" } as never, res: {} as never, auth });
}

const SAVED_WORKFLOW = {
  dslVersion: "1.0",
  id: "wf-1",
  nodes: [{ id: "n1", type: "noop", config: {} }],
  edges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  bodyBox.value = {};
  ownedRowsBox.rows = [];
  getOrgConfigSnapshotMock.mockResolvedValue({ runs: { requireSavedWorkflow: false } });
  startRunMock.mockResolvedValue({ runId: "run-1" });
});

describe("/start upstream-health pause gate", () => {
  it("rejects a paused workflow with 409 + upstream_degraded", async () => {
    bodyBox.value = SAVED_WORKFLOW;
    ownedRowsBox.rows = [{ id: "wf-1" }]; // saved → not adhoc
    getWorkflowStatusMock.mockResolvedValue({ status: "paused_upstream_degraded", pausedReason: 'Upstream "stripe" degraded (major_outage)' });

    await callStart();

    const last = sendJsonMock.mock.calls.at(-1);
    expect(last?.[2]).toBe(409);
    expect(last?.[1]).toMatchObject({ code: "upstream_degraded" });
    expect(startRunMock).not.toHaveBeenCalled();
  });

  it("allows the run when forceRunDuringPause is set + writes the force-run audit", async () => {
    bodyBox.value = { ...SAVED_WORKFLOW, forceRunDuringPause: true };
    ownedRowsBox.rows = [{ id: "wf-1" }];
    getWorkflowStatusMock.mockResolvedValue({ status: "paused_upstream_degraded", pausedReason: "degraded" });

    await callStart();

    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(auditActionMock).toHaveBeenCalledWith(auth, "workflow.force_run_during_pause", expect.objectContaining({ targetId: "wf-1" }));
    // The run-started audit also carries the forcedDuringPause flag.
    expect(auditActionMock).toHaveBeenCalledWith(auth, "run.started", expect.objectContaining({
      metadata: expect.objectContaining({ forcedDuringPause: true }),
    }));
  });

  it("starts normally when the workflow is active (no gate)", async () => {
    bodyBox.value = SAVED_WORKFLOW;
    ownedRowsBox.rows = [{ id: "wf-1" }];
    getWorkflowStatusMock.mockResolvedValue({ status: "active", pausedReason: null });

    await callStart();
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(auditActionMock).not.toHaveBeenCalledWith(auth, "workflow.force_run_during_pause", expect.anything());
  });

  it("never gates an ad-hoc (unsaved) workflow — no status lookup", async () => {
    bodyBox.value = SAVED_WORKFLOW;
    ownedRowsBox.rows = []; // not owned → adhoc
    await callStart();
    expect(getWorkflowStatusMock).not.toHaveBeenCalled();
    expect(startRunMock).toHaveBeenCalledTimes(1);
  });
});

// Proves `guardMcpWrite` is WIRED at the TOP of each operate route — an
// MCP-source caller with the process flag off is refused before the body is
// even parsed, so no run is started/resumed/cancelled. Tenant isolation for
// resume/cancel additionally rides on their `run.orgId !== auth.orgId → 403`
// ownership checks (covered elsewhere); this guards the consent wiring.
describe("operate routes — MCP-source write consent gate", () => {
  const mcpAuth = { orgId: "org-1", userId: "user-1", mode: "service-token", source: "mcp", serviceTokenSuffix: "abcd" } as never;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function findRoute(match: string): Route {
    const route = runsRoutes.find((r) => r.method === "POST" && typeof r.match === "string" && r.match === match);
    if (!route) throw new Error(`${match} route not found`);
    return route;
  }

  for (const match of ["/start", "/resume", "/run/cancel"]) {
    it(`${match} refuses MCP-source traffic (403 mcp_process_disabled) with the process flag off, and never mutates`, async () => {
      vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
      bodyBox.value = SAVED_WORKFLOW;
      await findRoute(match).handler({ req: { url: match } as never, res: {} as never, auth: mcpAuth });
      const last = sendJsonMock.mock.calls.at(-1);
      expect(last?.[2]).toBe(403);
      expect((last![1] as { code?: string }).code).toBe("mcp_process_disabled");
      // The gate short-circuited before any run mutation.
      expect(startRunMock).not.toHaveBeenCalled();
    });
  }
});
