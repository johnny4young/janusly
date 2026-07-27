import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findQualification: vi.fn(),
  finish: vi.fn(),
  getLatest: vi.fn(),
  qualify: vi.fn(),
  recordQualification: vi.fn(),
  resolveQualificationVersions: vi.fn(),
}));

vi.mock("@janusly/data", () => ({
  createWorkflowRollout: mocks.create,
  findWorkflowRecoveryQualification: mocks.findQualification,
  finishWorkflowRollout: mocks.finish,
  getLatestWorkflowRollout: mocks.getLatest,
  recordWorkflowRecoveryQualification: mocks.recordQualification,
  resolveWorkflowRecoveryQualificationVersions:
    mocks.resolveQualificationVersions,
  WORKFLOW_ROLLOUT_TRAFFIC_MIN: 1,
  WORKFLOW_ROLLOUT_TRAFFIC_MAX: 50,
  WORKFLOW_ROLLOUT_SAMPLE_MIN: 5,
  WORKFLOW_ROLLOUT_SAMPLE_MAX: 100,
  WORKFLOW_ROLLOUT_SUCCESS_RATE_MIN: 1,
  WORKFLOW_ROLLOUT_SUCCESS_RATE_MAX: 100,
}));
vi.mock("@janusly/engine", async importOriginal => {
  const actual = await importOriginal<typeof import("@janusly/engine")>();
  return {
    ...actual,
    qualifyRecoveryCandidate: mocks.qualify,
  };
});
vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));
vi.mock("../http", async importOriginal => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readJson: vi.fn(),
    sendError: vi.fn((_res: unknown, code: string, error: string, status = 400, params?: unknown) => ({
      status,
      payload: { code, error, params },
    })),
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ status, payload })),
  };
});

import { auditAction } from "../audit-helper";
import { readJson } from "../http";
import type { Route } from "../routes";
import { workflowRolloutsRoutes } from "./workflow-rollouts-routes";

const auth = { orgId: "org-1", userId: "admin-1", mode: "dev-headers", source: "dev" } as const;
const now = new Date("2026-07-21T12:00:00.000Z");
const rollout = {
  id: "rollout-1",
  orgId: "org-1",
  workflowId: "workflow-1",
  baselineVersionId: "version-1",
  canaryVersionId: "version-2",
  trafficPercent: 20,
  minimumSampleSize: 5,
  minimumSuccessRatePercent: 90,
  status: "active",
  baselineSucceeded: 3,
  baselineFailed: 0,
  canarySucceeded: 1,
  canaryFailed: 0,
  rolledBackReason: null,
  createdBy: "admin-1",
  createdAt: now,
  updatedAt: now,
  endedAt: null,
  lastOutcomeAt: now,
};
const qualificationSummary = {
  datasetVersion: "semantic-outcomes-v1",
  datasetDigest: "digest-1",
  mode: "compare",
  status: "passed",
  baselineCaseCount: 2,
  candidateCaseCount: 2,
  candidateAssertionCount: 4,
  passedCandidateAssertions: 4,
  failedCandidateAssertions: 0,
  regressionCount: 0,
  coverageFailureCount: 0,
  baselineDatasetValid: true,
  failures: [],
  failuresTruncated: false,
};
const qualification = {
  id: "qualification-1",
  orgId: "org-1",
  workflowId: "workflow-1",
  baselineVersionId: "version-1",
  candidateVersionId: "version-2",
  datasetVersion: "semantic-outcomes-v1",
  datasetDigest: "digest-1",
  mode: "compare",
  status: "passed",
  summaryJson: qualificationSummary,
  createdBy: "admin-1",
  createdAt: now,
};
const resolvedQualificationVersions = {
  kind: "resolved",
  baseline: {
    id: "version-1",
    version: 1,
    workflow: {
      recovery: { contract: { version: "2" } },
    },
  },
  candidate: {
    id: "version-2",
    version: 2,
    workflow: {
      recovery: { contract: { version: "2" } },
    },
  },
};

function route(method: Route["method"], url: string): Route {
  const found = workflowRolloutsRoutes.find(candidate => candidate.method === method && (
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
  mocks.getLatest.mockResolvedValue(rollout);
  mocks.create.mockResolvedValue({ kind: "created", rollout });
  mocks.finish.mockResolvedValue({ kind: "updated", rollout });
  mocks.findQualification.mockResolvedValue(qualification);
  mocks.qualify.mockReturnValue(qualificationSummary);
  mocks.recordQualification.mockResolvedValue(qualification);
  mocks.resolveQualificationVersions.mockResolvedValue(
    resolvedQualificationVersions,
  );
});

describe("workflow rollout route declarations", () => {
  it("keeps reads broadly visible and lifecycle controls admin-only", () => {
    expect(route("GET", "/workflows/workflow-1/rollout")).toMatchObject({ permission: "workflows.read" });
    expect(
      route(
        "GET",
        "/workflows/workflow-1/rollout/qualification?baselineVersionId=version-1&candidateVersionId=version-2",
      ),
    ).toMatchObject({ permission: "workflows.read" });
    expect(
      route("POST", "/workflows/workflow-1/rollout/qualification"),
    ).toMatchObject({
      role: "admin",
      permission: "workflows.write",
    });
    expect(route("POST", "/workflows/workflow-1/rollout")).toMatchObject({ role: "admin", permission: "workflows.write" });
    expect(route("POST", "/workflows/workflow-1/rollout/rollout-1/promote")).toMatchObject({ role: "admin", permission: "workflows.write" });
  });
});

describe("workflow rollout lifecycle", () => {
  it("returns an organization-scoped projection without creator identity", async () => {
    const result = await call("GET", "/workflows/workflow-1/rollout");

    expect(mocks.getLatest).toHaveBeenCalledWith("org-1", "workflow-1");
    expect(result).toMatchObject({ status: 200, payload: { rollout: { id: "rollout-1", status: "active" } } });
    expect((result as { payload: { rollout: Record<string, unknown> } }).payload.rollout).not.toHaveProperty("createdBy");
  });

  it("validates bounded settings, creates the rollout, and audits it", async () => {
    vi.mocked(readJson).mockResolvedValue({
      baselineVersionId: "version-1",
      canaryVersionId: "version-2",
      trafficPercent: 20,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 90,
    });

    const result = await call("POST", "/workflows/workflow-1/rollout");

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      workflowId: "workflow-1",
      createdBy: "admin-1",
    }));
    expect(vi.mocked(auditAction)).toHaveBeenCalledWith(auth, "workflow.rollout.started", expect.any(Object));
    expect(result).toMatchObject({ status: 201, payload: { rollout: { id: "rollout-1" } } });
  });

  it("returns the current deterministic qualification without creator identity", async () => {
    const result = await call(
      "GET",
      "/workflows/workflow-1/rollout/qualification?baselineVersionId=version-1&candidateVersionId=version-2",
    );

    expect(mocks.resolveQualificationVersions).toHaveBeenCalledWith({
      orgId: "org-1",
      workflowId: "workflow-1",
      baselineVersionId: "version-1",
      candidateVersionId: "version-2",
    });
    expect(mocks.findQualification).toHaveBeenCalledWith(
      expect.objectContaining({
        datasetVersion: "semantic-outcomes-v1",
      }),
    );
    expect(result).toMatchObject({
      status: 200,
      payload: {
        required: true,
        qualification: {
          id: "qualification-1",
          status: "passed",
        },
      },
    });
    expect(
      (result as {
        payload: { qualification: Record<string, unknown> };
      }).payload.qualification,
    ).not.toHaveProperty("createdBy");
  });

  it("records and audits one exact version-pair comparison", async () => {
    vi.mocked(readJson).mockResolvedValue({
      baselineVersionId: "version-1",
      candidateVersionId: "version-2",
    });

    const result = await call(
      "POST",
      "/workflows/workflow-1/rollout/qualification",
    );

    expect(mocks.qualify).toHaveBeenCalledWith({
      baseline: resolvedQualificationVersions.baseline.workflow,
      candidate: resolvedQualificationVersions.candidate.workflow,
    });
    expect(mocks.recordQualification).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        workflowId: "workflow-1",
        baselineVersionId: "version-1",
        candidateVersionId: "version-2",
        status: "passed",
      }),
    );
    expect(vi.mocked(auditAction)).toHaveBeenCalledWith(
      auth,
      "workflow.recovery_qualification.recorded",
      expect.any(Object),
    );
    expect(result).toMatchObject({
      status: 200,
      payload: {
        required: true,
        qualification: { status: "passed" },
      },
    });
  });

  it("maps a missing semantic qualification to a stable rollout conflict", async () => {
    vi.mocked(readJson).mockResolvedValue({
      baselineVersionId: "version-1",
      canaryVersionId: "version-2",
      trafficPercent: 20,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 90,
    });
    mocks.create.mockResolvedValue({
      kind: "recovery_qualification_required",
    });

    const result = await call(
      "POST",
      "/workflows/workflow-1/rollout",
    );

    expect(result).toMatchObject({
      status: 409,
      payload: {
        code: "workflow_recovery_qualification_required",
      },
    });
    expect(auditAction).not.toHaveBeenCalled();
  });

  it("rejects out-of-range canary traffic before persistence", async () => {
    vi.mocked(readJson).mockResolvedValue({
      baselineVersionId: "version-1",
      canaryVersionId: "version-2",
      trafficPercent: 90,
      minimumSampleSize: 5,
      minimumSuccessRatePercent: 90,
    });

    const result = await call("POST", "/workflows/workflow-1/rollout");

    expect(result).toMatchObject({ status: 400, payload: { code: "workflow_rollout_invalid" } });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("promotes with a scoped CAS and emits the typed audit action", async () => {
    vi.mocked(readJson).mockResolvedValue({});
    mocks.finish.mockResolvedValue({ kind: "updated", rollout: { ...rollout, status: "promoted" } });

    const result = await call("POST", "/workflows/workflow-1/rollout/rollout-1/promote");

    expect(mocks.finish).toHaveBeenCalledWith({
      orgId: "org-1",
      workflowId: "workflow-1",
      rolloutId: "rollout-1",
      decision: "promote",
      reason: undefined,
    });
    expect(vi.mocked(auditAction)).toHaveBeenCalledWith(auth, "workflow.rollout.promoted", expect.any(Object));
    expect(result).toMatchObject({ status: 200, payload: { rollout: { status: "promoted" } } });
  });

  it("maps a repeated decision to a stable conflict", async () => {
    vi.mocked(readJson).mockResolvedValue({ reason: "Observed errors" });
    mocks.finish.mockResolvedValue({ kind: "not_active" });

    const result = await call("POST", "/workflows/workflow-1/rollout/rollout-1/rollback");

    expect(result).toMatchObject({ status: 409, payload: { code: "workflow_rollout_not_active" } });
  });

  it("matches but rejects an unknown lifecycle action", async () => {
    const result = await call("POST", "/workflows/workflow-1/rollout/rollout-1/archive");

    expect(result).toMatchObject({ status: 400, payload: { code: "workflow_rollout_invalid" } });
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});
