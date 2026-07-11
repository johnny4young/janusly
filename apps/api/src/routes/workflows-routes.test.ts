/**
 * Route-level proof that the MCP write-consent gate is WIRED on the
 * workflow-mutating routes exposed over MCP (`workflows.save`,
 * `workflows.rollback`). This is the regression guard that a future edit
 * can't silently drop the gate line — it caught exactly that on
 * `/workflows/rollback` once.
 *
 * The heavy engine/db/data imports are stubbed so the module loads; the
 * REAL `../mcp-consent` is used so the test exercises `guardMcpWrite` /
 * `isMcpWriteAllowed` end-to-end. With the process flag off, an MCP-source
 * caller must be refused (403 `mcp_process_disabled`) BEFORE the body is
 * read or any version is written. Tenant isolation itself rides on the
 * org-scoped repo calls exercised by the rest of the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auditActionMock,
  bodyBox,
  enforceRateLimitMock,
  getOrgConfigSnapshotMock,
  rollbackMock,
  saveMock,
  sendJsonMock,
} = vi.hoisted(() => ({
  auditActionMock: vi.fn(),
  bodyBox: { value: {} as unknown },
  enforceRateLimitMock: vi.fn(),
  getOrgConfigSnapshotMock: vi.fn(),
  rollbackMock: vi.fn(),
  saveMock: vi.fn(),
  sendJsonMock: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  isNotNull: vi.fn(() => ({})),
}));

vi.mock("@janusly/db", () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })) },
  deadLetters: {},
  runs: {},
  workflows: {},
  workflowMetadata: {},
  workflowVersions: {},
}));

// getOrgConfigSnapshot is the only @janusly/data export the real mcp-consent
// reaches — and only when the process flag is ON, which these tests keep OFF.
vi.mock("@janusly/data", () => ({
  getOrgConfigSnapshot: getOrgConfigSnapshotMock,
  queryHealthSignals: vi.fn(),
  DEFAULT_HEALTH_WINDOW_DAYS: 7,
  findScheduleEntriesForWorkflow: vi.fn(),
  getWorkflowSlo: vi.fn(),
  listDeletedWorkflowsWithRunSummary: vi.fn(),
  listDistinctWorkflowFoldersForOrg: vi.fn(),
  listDistinctWorkflowTagsForOrg: vi.fn(),
  listWorkflowsWithRunSummary: vi.fn(),
  queryScheduleFires: vi.fn(),
  setWorkflowSlo: vi.fn(),
}));

vi.mock("@janusly/engine/src/schedule-scheduler", () => ({
  unregisterAllForWorkflow: vi.fn(),
  syncWorkflowSchedules: vi.fn(),
}));
vi.mock("@janusly/engine/src/schedule-history", () => ({
  bucketScheduleFires: vi.fn(),
  computeNextFires: vi.fn(),
  DEFAULT_NEXT_FIRES: 5,
  MAX_FIRE_ROWS: 100,
  MAX_HISTORY_DAYS: 30,
  MAX_NEXT_FIRES: 20,
}));
vi.mock("@janusly/engine/src/workflow-health", () => ({ computeWorkflowHealth: vi.fn(), MIN_RUNS_FOR_DELTA: 5 }));
vi.mock("@janusly/engine/src/workflow-readiness", () => ({ checkWorkflowReadiness: vi.fn() }));
vi.mock("@janusly/engine/src/workflow-validation", () => ({ validateWorkflow: vi.fn(() => ({ valid: true, issues: [] })) }));

vi.mock("../audit-helper", () => ({ auditAction: auditActionMock }));
vi.mock("../http", () => ({
  asRecord: (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {}),
  readJson: vi.fn(() => Promise.resolve(bodyBox.value)),
  sendJson: sendJsonMock,
  sendError: vi.fn((_res: unknown, code: string, message: string, status = 400) => sendJsonMock(_res, { error: message, code }, status)),
}));
vi.mock("../rate-limit", () => ({ enforceRateLimit: enforceRateLimitMock }));
vi.mock("../readiness-helpers", () => ({
  checkRollbackAvailability: vi.fn(),
  getCredentialReadinessIssues: vi.fn(),
  mergeReadiness: vi.fn(),
  productionSecretRefResolver: {},
}));
vi.mock("../workflows-rollback", () => ({ rollbackAuditMetadata: vi.fn(() => ({})), rollbackWorkflowToVersion: rollbackMock }));
vi.mock("../workflows-save", () => ({ saveWorkflowVersion: saveMock }));

// NOTE: ../mcp-consent is intentionally NOT mocked — the gate logic is what
// we're proving is wired.

import { workflowsRoutes } from "./workflows-routes";
import type { Route } from "../routes";

const mcpAuth = { orgId: "org-1", userId: "mcp-user", mode: "service-token", source: "mcp", serviceTokenSuffix: "abcd" } as never;

function findRoute(match: string): Route {
  const route = workflowsRoutes.find((r) => r.method === "POST" && typeof r.match === "string" && r.match === match);
  if (!route) throw new Error(`${match} route not found`);
  return route;
}

beforeEach(() => {
  vi.clearAllMocks();
  bodyBox.value = { workflowId: "wf-1", sourceVersionId: "v1", dslVersion: "1.0", nodes: [], edges: [] };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workflow-mutating routes — MCP-source write consent gate", () => {
  it("/workflows/save refuses MCP-source traffic (403 mcp_process_disabled) with the process flag off, never saving", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    await findRoute("/workflows/save").handler({ req: { url: "/workflows/save" } as never, res: {} as never, auth: mcpAuth });
    const last = sendJsonMock.mock.calls.at(-1);
    expect(last?.[2]).toBe(403);
    expect((last![1] as { code?: string }).code).toBe("mcp_process_disabled");
    expect(saveMock).not.toHaveBeenCalled();
    // The gate fires before the tenant consent read + the rate limit.
    expect(getOrgConfigSnapshotMock).not.toHaveBeenCalled();
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
  });

  it("/workflows/rollback refuses MCP-source traffic (403 mcp_process_disabled) with the process flag off, never rolling back", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    await findRoute("/workflows/rollback").handler({ req: { url: "/workflows/rollback" } as never, res: {} as never, auth: mcpAuth });
    const last = sendJsonMock.mock.calls.at(-1);
    expect(last?.[2]).toBe(403);
    expect((last![1] as { code?: string }).code).toBe("mcp_process_disabled");
    expect(rollbackMock).not.toHaveBeenCalled();
  });

  it("both routes are declared editor-gated (RBAC layered under the MCP gate)", () => {
    expect(findRoute("/workflows/save").role).toBe("editor");
    expect(findRoute("/workflows/rollback").role).toBe("editor");
  });
});
