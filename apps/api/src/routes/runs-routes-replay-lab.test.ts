import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  auditMock,
  bodyBox,
  enforceRateLimitMock,
  getRunComparisonMock,
  orgLlmRuntimeMock,
  replayRunAsValidationMock,
  selectRowsBox,
  sendJsonMock,
} = vi.hoisted(() => ({
  auditMock: vi.fn(),
  bodyBox: { value: {} as unknown },
  enforceRateLimitMock: vi.fn(),
  getRunComparisonMock: vi.fn(),
  orgLlmRuntimeMock: vi.fn(),
  replayRunAsValidationMock: vi.fn(),
  selectRowsBox: { rows: [] as unknown[][] },
  sendJsonMock: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gt: vi.fn(() => ({})),
  lt: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
}));

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: vi.fn(),
}));

vi.mock("@janusly/data/src/runComparisonRepo", () => ({
  getRunComparison: getRunComparisonMock,
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(selectRowsBox.rows.shift() ?? [])),
        orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
      })),
    })),
  },
  runEvents: {},
  runNodes: {},
  runs: {
    id: "runs.id",
    orgId: "runs.org_id",
    workflowVersionId: "runs.workflow_version_id",
  },
  workflows: {},
  workflowVersions: {
    id: "workflow_versions.id",
    orgId: "workflow_versions.org_id",
  },
}));

vi.mock("@janusly/domain", () => ({
  replayDecision: vi.fn(),
}));

vi.mock("@janusly/engine/src/adapters/replay-lab", () => ({
  replayRunAsValidation: replayRunAsValidationMock,
}));

vi.mock("@janusly/engine/src/inputs-validator", () => ({
  WorkflowInputValidationError: class WorkflowInputValidationError extends Error {},
}));

vi.mock("@janusly/engine/src/persistence", () => ({
  cancelRun: vi.fn(),
}));

vi.mock("@janusly/engine/src/resume-run", () => ({
  ResumeRunConflictError: class ResumeRunConflictError extends Error {},
  resumeRun: vi.fn(),
}));

vi.mock("@janusly/engine/src/start-run", () => ({
  startRun: vi.fn(),
}));

vi.mock("@janusly/engine/src/workflow-readiness", () => ({
  checkWorkflowReadiness: vi.fn(),
}));

vi.mock("@janusly/engine/src/workflow-validation", () => ({
  validateWorkflow: vi.fn(() => ({ valid: true, issues: [] })),
}));

vi.mock("../ai-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("../ai-runtime")>();
  return {
    ...original,
    orgLlmRuntime: orgLlmRuntimeMock,
  };
});

vi.mock("../audit", () => ({
  audit: auditMock,
}));

vi.mock("../http", () => ({
  asRecord: (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {}),
  corsHeaders: vi.fn(() => ({})),
  readJson: vi.fn(() => Promise.resolve(bodyBox.value)),
  sendEvent: vi.fn(),
  sendJson: sendJsonMock,
}));

vi.mock("../rate-limit", () => ({
  enforceRateLimit: enforceRateLimitMock,
}));

vi.mock("../readiness-helpers", () => ({
  checkRollbackAvailability: vi.fn(),
  mergeReadiness: vi.fn(),
}));

import { getRunComparison } from "@janusly/data/src/runComparisonRepo";
import { replayRunAsValidation } from "@janusly/engine/src/adapters/replay-lab";
import { orgLlmRuntime } from "../ai-runtime";
import { audit } from "../audit";
import { enforceRateLimit } from "../rate-limit";
import { runsRoutes } from "./runs-routes";

const auth = {
  orgId: "org-1",
  userId: "user-1",
  mode: "dev-headers" as const,
  source: "dev" as const,
};
const workflow = {
  dslVersion: "1.0" as const,
  nodes: [{ id: "start", type: "noop" as const, config: {} }],
  edges: [],
};
const parsedWorkflow = { ...workflow, metadata: { tags: [] } };

beforeEach(() => {
  bodyBox.value = {};
  selectRowsBox.rows = [];
  vi.mocked(audit).mockReset();
  vi.mocked(enforceRateLimit).mockReset();
  vi.mocked(getRunComparison).mockReset();
  vi.mocked(orgLlmRuntime).mockReset();
  vi.mocked(replayRunAsValidation).mockReset();
  sendJsonMock.mockClear();
  orgLlmRuntimeMock.mockResolvedValue({ orgConfig: { ai: { rateLimitPerMin: 42 } } });
  replayRunAsValidationMock.mockResolvedValue({ runId: "replay-run" });
});

describe("runsRoutes Replay Lab handlers", () => {
  it("starts a validation run from an org-scoped source run and writes audit metadata", async () => {
    bodyBox.value = { sourceRunId: "source-run" };
    selectRowsBox.rows = [
      [{
        id: "source-run",
        orgId: "org-1",
        workflowVersionId: "workflow-version-1",
        replayMode: null,
        inputJson: { input: { invoiceId: "inv-42" } },
      }],
      [{ dagJson: workflow }],
    ];

    await replayLabRoute().handler({
      req: { url: "/runs/replay-lab" } as never,
      res: {} as never,
      auth,
    });

    expect(enforceRateLimit).toHaveBeenCalledWith("org-1", { name: "ai", windowMs: 60_000, max: 42 });
    expect(replayRunAsValidation).toHaveBeenCalledWith({
      orgId: "org-1",
      sourceRunId: "source-run",
      workflow: parsedWorkflow,
      input: { invoiceId: "inv-42" },
      createdBy: "user-1",
      hasPatch: false,
    });
    expect(audit).toHaveBeenCalledWith("org-1", "user-1", "replay_lab.started", "run", "source-run", expect.objectContaining({
      replayRunId: "replay-run",
      hasPatch: false,
    }));
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.anything(), { runId: "replay-run" });
  });

  it("rejects nested labs before enqueueing or auditing", async () => {
    bodyBox.value = { sourceRunId: "source-run" };
    selectRowsBox.rows = [[{
      id: "source-run",
      orgId: "org-1",
      workflowVersionId: "workflow-version-1",
      replayMode: "validation",
      inputJson: { input: {} },
    }]];

    await replayLabRoute().handler({
      req: { url: "/runs/replay-lab" } as never,
      res: {} as never,
      auth,
    });

    expect(replayRunAsValidation).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.anything(), {
      error: "Source run is itself a sandbox run; cannot start a nested lab",
    }, 400);
  });

  it("maps missing comparison runs to a no-enumeration 404 envelope", async () => {
    getRunComparisonMock.mockResolvedValue({ error: "base_run_not_found" });

    await compareRoute().handler({
      req: { url: "/runs/compare?baseRunId=base-run&replayRunId=replay-run" } as never,
      res: {} as never,
      auth,
    });

    expect(getRunComparison).toHaveBeenCalledWith({
      orgId: "org-1",
      baseRunId: "base-run",
      replayRunId: "replay-run",
    });
    expect(sendJsonMock).toHaveBeenLastCalledWith(expect.anything(), { error: "Base run not found" }, 404);
  });
});

function replayLabRoute() {
  const route = runsRoutes.find((candidate) => candidate.method === "POST" && candidate.match === "/runs/replay-lab");
  if (!route) throw new Error("Replay Lab route missing");
  return route;
}

function compareRoute() {
  const route = runsRoutes.find((candidate) =>
    candidate.method === "GET" &&
    typeof candidate.match === "function" &&
    candidate.match("/runs/compare")
  );
  if (!route) throw new Error("Run comparison route missing");
  return route;
}
