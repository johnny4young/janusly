import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getRecoveryCaseMock,
  listRecoveryCasesMock,
  listRecoveryCaseTransitionsMock,
  resolveRecoveryCaseAutonomyProfileMock,
  recoverSemanticOutcomeMock,
  auditActionMock,
  guardMcpWriteMock,
} = vi.hoisted(() => ({
  getRecoveryCaseMock: vi.fn(),
  listRecoveryCasesMock: vi.fn(),
  listRecoveryCaseTransitionsMock: vi.fn(),
  resolveRecoveryCaseAutonomyProfileMock: vi.fn(),
  recoverSemanticOutcomeMock: vi.fn(),
  auditActionMock: vi.fn(),
  guardMcpWriteMock: vi.fn(),
}));

vi.mock("@janusly/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@janusly/data")>();
  return {
    ...actual,
    getRecoveryCase: getRecoveryCaseMock,
    listRecoveryCases: listRecoveryCasesMock,
    listRecoveryCaseTransitions: listRecoveryCaseTransitionsMock,
    resolveRecoveryCaseAutonomyProfile:
      resolveRecoveryCaseAutonomyProfileMock,
  };
});

vi.mock("@janusly/engine/src/semantic-recovery", () => ({
  recoverSemanticOutcome: recoverSemanticOutcomeMock,
}));

vi.mock("../audit-helper", () => ({
  auditAction: auditActionMock,
}));

vi.mock("../mcp-consent", () => ({
  guardMcpWrite: guardMcpWriteMock,
}));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readJson: vi.fn(),
    sendJson: vi.fn(
      (_res: unknown, payload: unknown, status = 200) => ({
        payload,
        status,
      }),
    ),
    sendError: vi.fn(
      (
        _res: unknown,
        code: string,
        error: string,
        status = 400,
      ) => ({
        payload: { error, code },
        status,
      }),
    ),
  };
});

import { readJson } from "../http";
import { recoveryRoutes } from "./recovery-routes";

const readJsonMock = vi.mocked(readJson);
const auth = {
  orgId: "org-1",
  userId: "operator-1",
  mode: "dev-headers",
  source: "dev",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  guardMcpWriteMock.mockResolvedValue({ ok: true });
  resolveRecoveryCaseAutonomyProfileMock.mockResolvedValue({
    level: 3,
    source: "workflow_default",
    detectorIds: ["operator-approved"],
    unavailableReason: null,
    capabilities: {
      observe: true,
      recommend: true,
      validate: true,
      applyWithApproval: true,
      autonomousApply: false,
    },
    factors: [
      { capability: "observe", requiredLevel: 0, enabled: true },
      { capability: "recommend", requiredLevel: 1, enabled: true },
      { capability: "validate", requiredLevel: 2, enabled: true },
      {
        capability: "apply_with_approval",
        requiredLevel: 3,
        enabled: true,
      },
      {
        capability: "autonomous_apply",
        requiredLevel: 4,
        enabled: false,
      },
    ],
  });
});

describe("semantic recovery case routes", () => {
  it("returns a bounded tenant-scoped case list", async () => {
    listRecoveryCasesMock.mockResolvedValueOnce([
      {
        id: "case-1",
        orgId: "org-1",
        runId: "run-1",
        state: "contained",
      },
    ]);
    const route = recoveryRoutes.find(
      (candidate) =>
        candidate.method === "GET" &&
        typeof candidate.match === "function" &&
        candidate.match("/recovery/cases?limit=25"),
    );
    expect(route?.permission).toBe("recovery.read");

    const result = await route!.handler({
      req: {
        url: "/recovery/cases?limit=25&openOnly=false&runId=run-1",
      } as never,
      res: {} as never,
      auth: auth as never,
    });

    expect(listRecoveryCasesMock).toHaveBeenCalledWith("org-1", {
      openOnly: false,
      runId: "run-1",
      limit: 25,
    });
    expect(result).toEqual({
      status: 200,
      payload: {
        cases: [
          expect.objectContaining({ id: "case-1" }),
        ],
      },
    });
  });

  it("falls back to a safe integer limit for malformed legacy queries", async () => {
    listRecoveryCasesMock.mockResolvedValueOnce([]);
    const route = recoveryRoutes.find(
      (candidate) =>
        candidate.method === "GET" &&
        typeof candidate.match === "function" &&
        candidate.match("/recovery/cases?limit=1.5"),
    );

    await route!.handler({
      req: { url: "/recovery/cases?limit=1.5" } as never,
      res: {} as never,
      auth: auth as never,
    });

    expect(listRecoveryCasesMock).toHaveBeenCalledWith("org-1", {
      openOnly: true,
      runId: undefined,
      limit: 100,
    });
  });

  it("returns one tenant-scoped case with its ordered transition history", async () => {
    getRecoveryCaseMock.mockResolvedValueOnce({
      id: "case-1",
      orgId: "org-1",
      runId: "run-1",
      state: "contained",
    });
    listRecoveryCaseTransitionsMock.mockResolvedValueOnce([
      {
        id: "transition-1",
        caseId: "case-1",
        fromState: "detected",
        toState: "contained",
      },
    ]);
    const route = recoveryRoutes.find(
      (candidate) =>
        candidate.method === "GET" &&
        typeof candidate.match === "function" &&
        candidate.match("/recovery/cases/case-1"),
    );

    const result = await route!.handler({
      req: { url: "/recovery/cases/case-1" } as never,
      res: {} as never,
      auth: auth as never,
    });

    expect(getRecoveryCaseMock).toHaveBeenCalledWith("org-1", "case-1");
    expect(listRecoveryCaseTransitionsMock).toHaveBeenCalledWith(
      "org-1",
      "case-1",
    );
    expect(result).toEqual({
      status: 200,
      payload: {
        case: expect.objectContaining({ id: "case-1" }),
        transitions: [
          expect.objectContaining({ id: "transition-1" }),
        ],
        autonomy: expect.objectContaining({
          level: 3,
          capabilities: expect.objectContaining({
            applyWithApproval: true,
          }),
        }),
      },
    });
    expect(resolveRecoveryCaseAutonomyProfileMock)
      .toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ id: "case-1" }),
      );
  });

  it("does not expose another tenant's recovery case history", async () => {
    getRecoveryCaseMock.mockResolvedValueOnce(null);
    const route = recoveryRoutes.find(
      (candidate) =>
        candidate.method === "GET" &&
        typeof candidate.match === "function" &&
        candidate.match("/recovery/cases/case-missing"),
    );

    const result = await route!.handler({
      req: { url: "/recovery/cases/case-missing" } as never,
      res: {} as never,
      auth: auth as never,
    });

    expect(result).toMatchObject({
      status: 404,
      payload: { code: "recovery_case_not_found" },
    });
    expect(listRecoveryCaseTransitionsMock).not.toHaveBeenCalled();
  });

  it("resolves a quarantined case with an authenticated operator decision", async () => {
    readJsonMock.mockResolvedValueOnce({
      decision: "replace",
      output: { mode: "ai" },
      reason: "Reviewed replacement",
    });
    recoverSemanticOutcomeMock.mockResolvedValueOnce({
      status: "resolved",
      runId: "run-1",
      sourceNodeId: "answer",
      decision: "replace",
      resumed: true,
      workflow: { nodes: [], edges: [] },
      resolvedCaseIds: ["case-1", "case-2"],
    });
    const route = recoveryRoutes.find(
      (candidate) =>
        candidate.method === "POST" &&
        typeof candidate.match === "function" &&
        candidate.match("/recovery/cases/case-1/resolve"),
    );
    expect(route).toMatchObject({
      role: "editor",
      permission: "recovery.write",
    });

    const result = await route!.handler({
      req: {
        url: "/recovery/cases/case-1/resolve",
      } as never,
      res: {} as never,
      auth: auth as never,
    });

    expect(recoverSemanticOutcomeMock).toHaveBeenCalledWith({
      orgId: "org-1",
      caseId: "case-1",
      actorId: "operator-1",
      decision: "replace",
      output: { mode: "ai" },
      reason: "Reviewed replacement",
    });
    expect(auditActionMock).toHaveBeenCalledWith(
      auth,
      "recovery.semantic_resolved",
      expect.objectContaining({
        targetType: "recovery_case",
        targetId: "case-1",
      }),
    );
    expect(result).toEqual({
      status: 200,
      payload: {
        ok: true,
        runId: "run-1",
        sourceNodeId: "answer",
        decision: "replace",
        resumed: true,
        resolvedCaseIds: ["case-1", "case-2"],
      },
    });
    expect(guardMcpWriteMock).toHaveBeenCalledWith(
      auth,
      "recovery.cases.resolve",
    );
  });

  it("enforces MCP write consent before reading a resolution body", async () => {
    guardMcpWriteMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      body: {
        error: "Tenant MCP writes are disabled",
        code: "mcp_tenant_disabled",
      },
    });
    const route = recoveryRoutes.find(
      (candidate) =>
        candidate.method === "POST" &&
        typeof candidate.match === "function" &&
        candidate.match("/recovery/cases/case-1/resolve"),
    );

    const result = await route!.handler({
      req: {
        url: "/recovery/cases/case-1/resolve",
      } as never,
      res: {} as never,
      auth: { ...auth, source: "mcp" } as never,
    });

    expect(result).toEqual({
      status: 403,
      payload: {
        error: "Tenant MCP writes are disabled",
        code: "mcp_tenant_disabled",
      },
    });
    expect(readJsonMock).not.toHaveBeenCalled();
    expect(recoverSemanticOutcomeMock).not.toHaveBeenCalled();
  });

  it("returns a stable conflict when the frozen autonomy policy blocks replacement", async () => {
    readJsonMock.mockResolvedValueOnce({
      decision: "replace",
      output: { mode: "ai" },
      reason: "Reviewed replacement",
    });
    recoverSemanticOutcomeMock.mockResolvedValueOnce({
      status: "policy_blocked",
      profile: {
        level: 1,
        source: "failure_override",
        detectorIds: ["operator-approved"],
        unavailableReason: null,
        capabilities: {
          observe: true,
          recommend: true,
          validate: false,
          applyWithApproval: false,
          autonomousApply: false,
        },
        factors: [],
      },
    });
    const route = recoveryRoutes.find(
      (candidate) =>
        candidate.method === "POST" &&
        typeof candidate.match === "function" &&
        candidate.match("/recovery/cases/case-1/resolve"),
    );

    const result = await route!.handler({
      req: {
        url: "/recovery/cases/case-1/resolve",
      } as never,
      res: {} as never,
      auth: auth as never,
    });

    expect(result).toMatchObject({
      status: 409,
      payload: {
        code: "recovery_autonomy_policy_blocked",
      },
    });
    expect(auditActionMock).not.toHaveBeenCalled();
  });
});
