/**
 * Route-level tests for /solution-packs + /workflows/import-pack.
 *
 * Uses the REAL code-resident pack catalog (`@janusly/solution-packs`) and
 * the REAL `WorkflowSchema`; mocks the DB-backed reads, engine adapters,
 * and the save chokepoint. Covers: gate declarations, catalog projection
 * (no workflow JSON / secret leak), per-org dependency diff, install
 * (creates a version + audits + never auto-creates credentials + lands
 * under auth.orgId), sandbox sample-run, selected recovery drills, and 404s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  const sendJson = vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status }));
  return {
    ...actual,
    sendJson,
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      sendJson(_res, params === undefined ? { error: message, code } : { error: message, code, params }, status)),
    readJson: vi.fn(),
  };
});

// The route imports `getCredentialByName` + `listOrgConfig` from the barrel;
// mocking the barrel directly keeps the transitive DB import out of the test.
vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  getCredentialByName: vi.fn(),
  listOrgConfig: vi.fn(),
}));

vi.mock("@janusly/engine/src/adapters/sandbox-run", () => ({
  startSandboxRun: vi.fn(),
}));

vi.mock("@janusly/engine/src/adapters/sample-failure", () => ({
  injectSampleFailure: vi.fn(),
}));

vi.mock("@janusly/engine/src/adapters/stalled-node-drill", () => ({
  runStalledNodeDrill: vi.fn(),
}));

vi.mock("@janusly/engine/src/workflow-validation", () => ({
  validateWorkflow: vi.fn(() => ({ valid: true, issues: [] })),
}));

vi.mock("../workflows-save", () => ({
  saveWorkflowVersion: vi.fn(),
}));

vi.mock("../audit-helper", () => ({
  auditAction: vi.fn(),
}));

import { solutionPacksRoutes } from "./solution-packs-routes";
import { readJson } from "../http";
import { getCredentialByName, listOrgConfig } from "@janusly/data";
import { startSandboxRun } from "@janusly/engine/src/adapters/sandbox-run";
import { injectSampleFailure } from "@janusly/engine/src/adapters/sample-failure";
import { runStalledNodeDrill } from "@janusly/engine/src/adapters/stalled-node-drill";
import { saveWorkflowVersion } from "../workflows-save";
import { auditAction } from "../audit-helper";
import type { Route } from "../routes";

const readJsonMock = vi.mocked(readJson);
const getCredentialByNameMock = vi.mocked(getCredentialByName);
const listOrgConfigMock = vi.mocked(listOrgConfig);
const startSandboxRunMock = vi.mocked(startSandboxRun);
const injectSampleFailureMock = vi.mocked(injectSampleFailure);
const runStalledNodeDrillMock = vi.mocked(runStalledNodeDrill);
const saveWorkflowVersionMock = vi.mocked(saveWorkflowVersion);
const auditActionMock = vi.mocked(auditAction);

const AUTH = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" };

function findRoute(method: string, path: string): Route {
  const route = solutionPacksRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

async function callRoute(method: string, path: string, body?: unknown) {
  const route = findRoute(method, path);
  if (body !== undefined) readJsonMock.mockResolvedValue(body);
  return route.handler({ req: { url: path } as never, res: {} as never, auth: AUTH as never }) as Promise<{
    payload: Record<string, unknown>;
    status: number;
  }>;
}

beforeEach(() => {
  readJsonMock.mockReset();
  readJsonMock.mockResolvedValue({});
  // Default: org has no credentials configured and no tenant org-config rows.
  getCredentialByNameMock.mockResolvedValue(null);
  listOrgConfigMock.mockResolvedValue([] as never);
  saveWorkflowVersionMock.mockResolvedValue({
    kind: "ok",
    versionId: "ver-1",
    version: 1,
    workflowId: "wf-1",
    workflowName: "Incident triage",
    attempts: 1,
  } as never);
  startSandboxRunMock.mockResolvedValue({ runId: "run-1" } as never);
  injectSampleFailureMock.mockResolvedValue({ runId: "run-9", deadLetterId: "dlq-9" } as never);
  runStalledNodeDrillMock.mockResolvedValue({
    runId: "run-stalled",
    deadLetterId: "dlq-stalled",
    evidence: {
      recoveryPath: "stalled_node_reaper",
      thresholdMinutes: 60,
      simulatedStallMs: 3_601_000,
      reaperRuntimeMs: 12,
      scanned: 1,
      reaped: 1,
      deadLettered: 1,
    },
  } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("route gate declarations", () => {
  it("GET /solution-packs is viewer + packs.read", () => {
    const route = findRoute("GET", "/solution-packs");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("packs.read");
  });

  it("GET /solution-packs/:id is viewer + packs.read", () => {
    const route = findRoute("GET", "/solution-packs/incident-triage");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("packs.read");
  });

  it("POST /workflows/import-pack is editor + packs.install", () => {
    const route = findRoute("POST", "/workflows/import-pack");
    expect(route.role).toBe("editor");
    expect(route.permission).toBe("packs.install");
  });

  it("the action routes are editor + packs.install", () => {
    expect(findRoute("POST", "/solution-packs/incident-triage/sample-run").permission).toBe("packs.install");
    expect(findRoute("POST", "/solution-packs/incident-triage/inject-failure").permission).toBe("packs.install");
  });
});

describe("GET /solution-packs (catalog)", () => {
  it("returns safe drill descriptors without workflow JSON or raw error internals", async () => {
    const { payload } = await callRoute("GET", "/solution-packs");
    const packs = payload.packs as Array<Record<string, unknown>>;
    expect(packs.length).toBe(3);
    for (const pack of packs) {
      expect(pack).not.toHaveProperty("workflowJson");
      expect(pack).not.toHaveProperty("samplePayloads");
      expect(typeof pack.nodeCount).toBe("number");
      const fixtures = pack.failureFixtures as Array<Record<string, unknown>>;
      expect(fixtures.length).toBeGreaterThan(0);
      expect(fixtures[0]).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        description: expect.any(String),
        failureMode: expect.any(String),
        recoveryPath: expect.any(String),
      });
      expect(fixtures[0]).not.toHaveProperty("failedNodeId");
      expect(fixtures[0]).not.toHaveProperty("errorJson");
    }
    expect(JSON.stringify(payload)).not.toContain("secretRef");
  });
});

describe("GET /solution-packs/:id (detail + dependency diff)", () => {
  it("flags every declared credential as missing when the org has none", async () => {
    const { payload, status } = await callRoute("GET", "/solution-packs/incident-triage");
    expect(status).toBe(200);
    const missing = payload.missingCredentials as Array<{ name: string; kind: string }>;
    expect(missing.map((m) => m.name).sort()).toEqual(["ops_github", "ops_slack"]);
    // The diff reads credentials by (kind, name) — never a secretRef.
    expect(JSON.stringify(payload)).not.toContain("secretRef");
    expect(getCredentialByNameMock).toHaveBeenCalledWith("org-1", "github_token", "ops_github");
  });

  it("flags a required org-config key the tenant has not set", async () => {
    const { payload } = await callRoute("GET", "/solution-packs/support-escalation");
    const missingKeys = (payload.missingOrgConfigs as Array<{ key: string }>).map((c) => c.key);
    expect(missingKeys).toContain("email.from");
  });

  it("returns 404 for an unknown pack", async () => {
    const { payload, status } = await callRoute("GET", "/solution-packs/does-not-exist");
    expect(status).toBe(404);
    expect(payload.code).toBe("pack_not_found");
  });
});

describe("POST /workflows/import-pack", () => {
  it("saves a fresh workflow version under auth.orgId, audits, and never auto-creates a credential", async () => {
    const { payload, status } = await callRoute("POST", "/workflows/import-pack", { packId: "incident-triage" });
    expect(status).toBe(200);

    expect(saveWorkflowVersionMock).toHaveBeenCalledTimes(1);
    const saveArg = saveWorkflowVersionMock.mock.calls[0][0];
    expect(saveArg.orgId).toBe("org-1");
    // Copy-on-use: the saved workflow has a fresh (stripped) id.
    expect(saveArg.parsedWorkflow.id).toBeUndefined();
    expect(saveArg.parsedWorkflow.nodes.length).toBeGreaterThan(0);

    // Install lists what's missing but never provisions it.
    const missing = payload.missingCredentials as Array<{ name: string }>;
    expect(missing.map((m) => m.name).sort()).toEqual(["ops_github", "ops_slack"]);
    expect(payload.workflowId).toBe("wf-1");

    expect(auditActionMock).toHaveBeenCalledTimes(1);
    expect(auditActionMock.mock.calls[0][1]).toBe("workflow.pack_imported");
    // The env-var name behind a credential never rides the response.
    expect(JSON.stringify(payload)).not.toContain("secretRef");
  });

  it("returns 404 for an unknown pack and does not save", async () => {
    const { status, payload } = await callRoute("POST", "/workflows/import-pack", { packId: "nope" });
    expect(status).toBe(404);
    expect(payload.code).toBe("pack_not_found");
    expect(saveWorkflowVersionMock).not.toHaveBeenCalled();
  });
});

describe("POST /solution-packs/:id/sample-run", () => {
  it("starts a sandbox run against the bundled payload and audits", async () => {
    const { payload, status } = await callRoute("POST", "/solution-packs/incident-triage/sample-run", {});
    expect(status).toBe(200);
    expect(payload.runId).toBe("run-1");

    expect(startSandboxRunMock).toHaveBeenCalledTimes(1);
    const arg = startSandboxRunMock.mock.calls[0][0];
    expect(arg.orgId).toBe("org-1");
    expect(arg.source).toBe("pack:incident-triage");
    // The bundled sample payload becomes the run input.
    expect(arg.input).toMatchObject({ alertName: expect.any(String) });

    expect(auditActionMock.mock.calls[0][1]).toBe("solution_pack.sample_run_started");
  });

  it("returns 404 for an unknown pack", async () => {
    const { status } = await callRoute("POST", "/solution-packs/nope/sample-run", {});
    expect(status).toBe(404);
    expect(startSandboxRunMock).not.toHaveBeenCalled();
  });
});

describe("POST /solution-packs/:id/inject-failure", () => {
  it("seeds the selected drill with durable provenance and audits its failure mode", async () => {
    const { payload, status } = await callRoute(
      "POST",
      "/solution-packs/incident-triage/inject-failure",
      { fixtureId: "classification_output_invalid" },
    );
    expect(status).toBe(200);
    expect(payload.deadLetterId).toBe("dlq-9");
    expect(payload.fixtureId).toBe("classification_output_invalid");
    expect(payload.failureMode).toBe("ai_output_invalid");
    expect(payload.recoveryPath).toBe("direct_failure");

    expect(injectSampleFailureMock).toHaveBeenCalledTimes(1);
    const arg = injectSampleFailureMock.mock.calls[0][0];
    expect(arg.orgId).toBe("org-1");
    expect(arg.failedNodeId).toBe("classify");
    expect(arg.errorJson).toMatchObject({ code: "E_AI_OUTPUT_INVALID" });
    expect(arg.source).toEqual({
      kind: "solution_pack_drill",
      packId: "incident-triage",
      fixtureId: "classification_output_invalid",
      failureMode: "ai_output_invalid",
      recoveryPath: "direct_failure",
    });

    expect(auditActionMock.mock.calls[0][1]).toBe("solution_pack.failure_injected");
    expect(auditActionMock.mock.calls[0][2]).toMatchObject({
      metadata: {
        fixtureId: "classification_output_invalid",
        failureMode: "ai_output_invalid",
        recoveryPath: "direct_failure",
      },
    });
  });

  it("runs a worker interruption through the scoped stalled-node reaper path", async () => {
    const { payload, status } = await callRoute(
      "POST",
      "/solution-packs/incident-triage/inject-failure",
      { fixtureId: "worker_interrupted_during_page" },
    );

    expect(status).toBe(200);
    expect(payload).toMatchObject({
      runId: "run-stalled",
      deadLetterId: "dlq-stalled",
      fixtureId: "worker_interrupted_during_page",
      failureMode: "worker_stalled",
      recoveryPath: "stalled_node_reaper",
      evidence: {
        thresholdMinutes: 60,
        scanned: 1,
        reaped: 1,
        deadLettered: 1,
      },
    });
    expect(injectSampleFailureMock).not.toHaveBeenCalled();
    expect(runStalledNodeDrillMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      createdBy: "user-1",
      failedNodeId: "page_oncall",
      source: {
        kind: "solution_pack_drill",
        packId: "incident-triage",
        fixtureId: "worker_interrupted_during_page",
        failureMode: "worker_stalled",
        recoveryPath: "stalled_node_reaper",
      },
    }));
    expect(auditActionMock).toHaveBeenCalledWith(
      expect.anything(),
      "solution_pack.failure_injected",
      expect.objectContaining({
        metadata: expect.objectContaining({
          recoveryPath: "stalled_node_reaper",
          evidence: expect.objectContaining({ reaperRuntimeMs: 12 }),
        }),
      }),
    );
  });

  it("rejects an unknown fixture id without creating an untraceable default", async () => {
    const { payload, status } = await callRoute(
      "POST",
      "/solution-packs/incident-triage/inject-failure",
      { fixtureId: "not-a-drill" },
    );

    expect(status).toBe(400);
    expect(payload.code).toBe("pack_no_failure_fixture");
    expect(injectSampleFailureMock).not.toHaveBeenCalled();
  });
});
