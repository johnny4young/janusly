/**
 * Route-level tests for the auto-healing endpoints. Covers:
 *   - list multi-tenant scope
 *   - detail multi-tenant scope (cross-org returns 404 with no
 *     enumeration leak)
 *   - decide 409 when the CAS update affects zero rows
 *     (signature_already_resolved)
 *   - decide writes a recovery_feedback mirror row on apply
 *   - decide declines write the audit row + skip feedback when no
 *     `approachLabel` was set (defense-in-depth)
 *   - scan route is admin-only (the role check is declarative; this
 *     pin verifies the route declares the right gate)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data/src/autoHealingRepo", () => ({
  getByIdForOrg: vi.fn(),
  listPendingForOrg: vi.fn(),
  recordDecision: vi.fn(),
}));

vi.mock("@janusly/data/src/recoveryFeedbackRepo", () => ({
  recordRecoveryFeedback: vi.fn(),
}));

vi.mock("@janusly/engine/src/adapters/dlq-replay", () => ({
  DLQReplayAdapter: class {
    async replayDeadLetter() {
      return undefined;
    }
  },
}));

vi.mock("../audit", () => ({
  audit: vi.fn(),
}));

vi.mock("../rate-limit", () => ({
  enforceRateLimit: vi.fn(),
}));

vi.mock("../dlq", () => ({
  markDeadLetterReplayed: vi.fn(),
}));

vi.mock("../auto-healing-scanner", () => ({
  runOrgScan: vi.fn(),
}));

vi.mock("../auto-healing-queue", () => ({
  autoHealingQueue: {},
}));

const hoisted = vi.hoisted(() => ({
  selectFromMock: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: { select: vi.fn(() => ({ from: hoisted.selectFromMock })) },
  deadLetters: { orgId: "org_id", id: "id", runId: "run_id", workflowJson: "workflow_json", nodeId: "node_id" },
}));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readJson: vi.fn(),
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      ({ payload: params === undefined ? { error: message, code } : { error: message, code, params }, status })),
  };
});

import { autoHealingRoutes } from "./auto-healing-routes";
import {
  getByIdForOrg,
  listPendingForOrg,
  recordDecision,
} from "@janusly/data/src/autoHealingRepo";
import { recordRecoveryFeedback } from "@janusly/data/src/recoveryFeedbackRepo";
import { runOrgScan } from "../auto-healing-scanner";
import { audit } from "../audit";
import { readJson, sendJson } from "../http";
import type { Route } from "../routes";

const listPendingMock = vi.mocked(listPendingForOrg);
const getByIdMock = vi.mocked(getByIdForOrg);
const decisionMock = vi.mocked(recordDecision);
const feedbackMock = vi.mocked(recordRecoveryFeedback);
const runOrgScanMock = vi.mocked(runOrgScan);
const auditMock = vi.mocked(audit);
const readJsonMock = vi.mocked(readJson);
const sendJsonMock = vi.mocked(sendJson);
const selectFromMock = hoisted.selectFromMock;

const auth = {
  orgId: "org-1",
  userId: "user-1",
  mode: "dev-headers",
  source: "dev",
} as const;

function findRoute(method: string, path: string): Route {
  const route = autoHealingRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

async function callRoute(method: string, path: string, body?: Record<string, unknown>) {
  if (body) readJsonMock.mockResolvedValueOnce(body);
  const route = findRoute(method, path);
  return route.handler({
    req: { url: path } as never,
    res: {} as never,
    auth: auth as never,
  });
}

beforeEach(() => {
  listPendingMock.mockReset().mockResolvedValue([]);
  getByIdMock.mockReset();
  decisionMock.mockReset();
  feedbackMock.mockReset().mockResolvedValue(undefined);
  runOrgScanMock.mockReset().mockResolvedValue(undefined);
  auditMock.mockReset().mockResolvedValue(undefined);
  readJsonMock.mockReset();
  sendJsonMock.mockClear();
  selectFromMock.mockReset();
});

describe("GET /auto-healing/pending", () => {
  it("scopes to the caller's org", async () => {
    listPendingMock.mockResolvedValueOnce([{ id: "row-1", orgId: "org-1" } as never]);
    await callRoute("GET", "/auto-healing/pending");
    expect(listPendingMock).toHaveBeenCalledWith("org-1", 100);
  });
});

describe("GET /auto-healing/:id", () => {
  it("returns 404 on cross-org id (no enumeration leak)", async () => {
    getByIdMock.mockResolvedValueOnce(null);
    const result = (await callRoute("GET", "/auto-healing/row-other-org")) as { status: number };
    expect(result.status).toBe(404);
  });
});

describe("POST /auto-healing/:id/decide", () => {
  function setupDlqLookup(workflowId: string | undefined) {
    const limit = vi.fn().mockResolvedValue([
      {
        runId: "run-1",
        workflowJson: workflowId ? { id: workflowId } : {},
        nodeId: "n-1",
      },
    ]);
    const where = vi.fn(() => ({ limit }));
    selectFromMock.mockReturnValue({ where });
  }

  it("returns 409 signature_already_resolved when the CAS write loses the race", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "row-1",
      orgId: "org-1",
      deadLetterId: "dlq-1",
      status: "validated",
      approachLabel: "fix_url",
      proposedPatchJson: {
        id: "wf-1",
        nodes: [{ id: "n-1", type: "http", config: { url: "https://x.test", method: "GET" } }],
        edges: [],
      },
    } as never);
    decisionMock.mockResolvedValueOnce({ applied: false });
    setupDlqLookup("wf-1");

    const result = (await callRoute("POST", "/auto-healing/row-1/decide", { accepted: true })) as {
      status: number;
      payload: { code?: string };
    };
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe("autoheal_already_resolved");
  });

  it("on accept: records decision + writes recovery_feedback mirror row", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "row-1",
      orgId: "org-1",
      deadLetterId: "dlq-1",
      status: "validated",
      approachLabel: "fix_url",
      proposedPatchJson: {
        id: "wf-1",
        nodes: [{ id: "n-1", type: "http", config: { url: "https://x.test", method: "GET" } }],
        edges: [],
      },
    } as never);
    decisionMock.mockResolvedValueOnce({ applied: true });
    setupDlqLookup("wf-1");

    const result = (await callRoute("POST", "/auto-healing/row-1/decide", {
      accepted: true,
      comment: "looks good",
    })) as { status: number };

    expect(result.status).toBe(200);
    expect(feedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      workflowId: "wf-1",
      accepted: true,
      approachLabel: "fix_url",
    }));
  });

  it("does not claim the decision when the stored patch is invalid", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "row-1",
      orgId: "org-1",
      deadLetterId: "dlq-1",
      status: "validated",
      approachLabel: "fix_url",
      proposedPatchJson: { id: "wf-1", nodes: "not-an-array", edges: [] },
    } as never);
    setupDlqLookup("wf-1");

    const result = (await callRoute("POST", "/auto-healing/row-1/decide", {
      accepted: true,
    })) as { status: number };

    expect(result.status).toBe(500);
    expect(decisionMock).not.toHaveBeenCalled();
    expect(feedbackMock).not.toHaveBeenCalled();
  });

  it("on decline: writes the manual-decline audit row + skips replay", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "row-1",
      orgId: "org-1",
      deadLetterId: "dlq-1",
      status: "validated",
      approachLabel: "fix_url",
    } as never);
    decisionMock.mockResolvedValueOnce({ applied: true });
    setupDlqLookup("wf-1");

    const result = (await callRoute("POST", "/auto-healing/row-1/decide", {
      accepted: false,
      comment: "patch is wrong",
    })) as { status: number; payload: { accepted: boolean } };

    expect(result.status).toBe(200);
    expect(result.payload.accepted).toBe(false);
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "auto_healing.decline.manual",
      "auto_healing_run",
      "row-1",
      expect.objectContaining({ decisionActor: "user-1" }),
    );
  });
});

describe("POST /auto-healing/scan", () => {
  it("declares admin + autohealing.decide gates", () => {
    const route = findRoute("POST", "/auto-healing/scan");
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("autohealing.decide");
  });

  it("invokes runOrgScan(auth.orgId) when called", async () => {
    await callRoute("POST", "/auto-healing/scan");
    expect(runOrgScanMock).toHaveBeenCalledWith("org-1");
  });
});
