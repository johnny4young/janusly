import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listRecoveryCasesMock,
  recoverSemanticOutcomeMock,
  auditActionMock,
} = vi.hoisted(() => ({
  listRecoveryCasesMock: vi.fn(),
  recoverSemanticOutcomeMock: vi.fn(),
  auditActionMock: vi.fn(),
}));

vi.mock("@janusly/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@janusly/data")>();
  return {
    ...actual,
    listRecoveryCases: listRecoveryCasesMock,
  };
});

vi.mock("@janusly/engine/src/semantic-recovery", () => ({
  recoverSemanticOutcome: recoverSemanticOutcomeMock,
}));

vi.mock("../audit-helper", () => ({
  auditAction: auditActionMock,
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
  });
});
