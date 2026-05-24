/**
 * Pure-unit tests for the credential readiness sidecar.
 *
 * Pinned invariants:
 * - With no resolver supplied, the helper returns []: existing call
 *   sites that haven't been wired stay byte-for-byte compatible.
 * - A credential reference whose secret_ref resolver returns false
 *   emits one ``credential_missing`` warn per referencing node.
 * - The emitted message NEVER echoes the env-var name. Only the
 *   operator-chosen credential ``name`` appears in user-visible text.
 * - An MCP alias whose connection has unresolvable env refs fires the
 *   warn with a missing-count summary.
 * - An MCP alias for which no connection row exists in this org fires
 *   the "no matching connection" warn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data/src/credentialsRepo", () => ({
  listCredentialsForOrg: vi.fn(),
}));

vi.mock("@janusly/data/src/mcpConnectionsRepo", () => ({
  listConnections: vi.fn(),
}));

// The helper at the bottom of readiness-helpers.ts (`mergeReadiness` +
// `checkRollbackAvailability`) reads workflow_versions via Drizzle.
// We don't exercise that path here — just stub the module so the import
// doesn't open a real DB connection.
vi.mock("@janusly/db", () => ({
  db: { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })) },
  workflowVersions: { id: "id", orgId: "org_id", workflowId: "workflow_id" },
}));

import type { Workflow } from "@janusly/shared";
import { getCredentialReadinessIssues } from "./readiness-helpers";
import { listCredentialsForOrg } from "@janusly/data/src/credentialsRepo";
import { listConnections } from "@janusly/data/src/mcpConnectionsRepo";

const listCredentialsMock = vi.mocked(listCredentialsForOrg);
const listConnectionsMock = vi.mocked(listConnections);

function makeWorkflow(partial: Partial<Workflow>): Workflow {
  return {
    dslVersion: "1.0",
    nodes: [],
    edges: [],
    ...partial,
  } as Workflow;
}

beforeEach(() => {
  listCredentialsMock.mockReset().mockResolvedValue([]);
  listConnectionsMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getCredentialReadinessIssues", () => {
  it("returns [] when no resolver is supplied (back-compat carve-out)", async () => {
    const workflow = makeWorkflow({
      nodes: [{ id: "n1", type: "tool", config: { tool: "slack.post", input: { credential: "slack-prod" } } as never }],
    });
    const issues = await getCredentialReadinessIssues("org-1", workflow);
    expect(issues).toEqual([]);
    // The bulk loaders MUST NOT be queried in the no-resolver path —
    // otherwise we'd burn a DB round-trip on every legacy call site.
    expect(listCredentialsMock).not.toHaveBeenCalled();
    expect(listConnectionsMock).not.toHaveBeenCalled();
  });

  it("emits one credential_missing warn per node when the resolver reports the secret is absent", async () => {
    listCredentialsMock.mockResolvedValueOnce([
      {
        id: "c1",
        orgId: "org-1",
        name: "slack-prod",
        kind: "slack_webhook",
        secretRef: "SLACK_WEBHOOK_PROD",
        metadata: null,
        createdBy: null,
        createdAt: null,
      } as never,
    ]);
    const workflow = makeWorkflow({
      nodes: [
        { id: "alert", type: "tool", config: { tool: "slack.post", input: { credential: "slack-prod" } } as never },
        { id: "notify", type: "tool", config: { tool: "slack.post", input: { credential: "slack-prod" } } as never },
      ],
    });
    const issues = await getCredentialReadinessIssues("org-1", workflow, () => false);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.code === "credential_missing")).toBe(true);
    expect(issues.every((issue) => issue.severity === "warn")).toBe(true);
    expect(issues.map((issue) => issue.nodeId).sort()).toEqual(["alert", "notify"]);
    // The env-var name MUST NOT appear in any user-visible string.
    for (const issue of issues) {
      expect(issue.message).not.toContain("SLACK_WEBHOOK_PROD");
      expect(issue.suggestion ?? "").not.toContain("SLACK_WEBHOOK_PROD");
      expect(issue.message).toContain("slack-prod");
    }
  });

  it("emits the 'no matching credential' variant when the workflow references a name with no row in this org", async () => {
    listCredentialsMock.mockResolvedValueOnce([]);
    const workflow = makeWorkflow({
      nodes: [{ id: "alert", type: "tool", config: { tool: "slack.post", input: { credential: "ghost-credential" } } as never }],
    });
    const issues = await getCredentialReadinessIssues("org-1", workflow, () => true);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "credential_missing", severity: "warn", nodeId: "alert" });
    expect(issues[0]?.message).toContain("ghost-credential");
    expect(issues[0]?.message).toContain("no matching credential");
  });

  it("flags mcp_tool aliases whose env refs don't resolve, without echoing the env-var name", async () => {
    listConnectionsMock.mockResolvedValueOnce([
      {
        id: "mcp-1",
        orgId: "org-1",
        alias: "notion-prod",
        transport: "http",
        command: null,
        args: null,
        url: "https://notion.example/mcp",
        envRefs: {
          NOTION_TOKEN: { kind: "env", name: "NOTION_INTERNAL_SECRET_VAR" },
        },
        enabled: true,
        status: "active",
        statusReason: null,
        exposeToAi: false,
        lastDiscoveryAt: null,
        createdBy: null,
        createdAt: null,
        updatedAt: null,
      } as never,
    ]);
    const workflow = makeWorkflow({
      nodes: [
        { id: "fetch-page", type: "mcp_tool", config: { connectionAlias: "notion-prod", toolName: "pages.read" } as never },
      ],
    });
    const issues = await getCredentialReadinessIssues(
      "org-1",
      workflow,
      (name) => name !== "NOTION_INTERNAL_SECRET_VAR",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "credential_missing", severity: "warn", nodeId: "fetch-page" });
    expect(issues[0]?.message).toContain("notion-prod");
    expect(issues[0]?.message).not.toContain("NOTION_INTERNAL_SECRET_VAR");
    expect(issues[0]?.suggestion ?? "").not.toContain("NOTION_INTERNAL_SECRET_VAR");
  });

  it("returns no issues when the resolver reports every reference resolves", async () => {
    listCredentialsMock.mockResolvedValueOnce([
      {
        id: "c1",
        orgId: "org-1",
        name: "slack-prod",
        kind: "slack_webhook",
        secretRef: "SLACK_WEBHOOK_PROD",
        metadata: null,
        createdBy: null,
        createdAt: null,
      } as never,
    ]);
    const workflow = makeWorkflow({
      nodes: [{ id: "alert", type: "tool", config: { tool: "slack.post", input: { credential: "slack-prod" } } as never }],
    });
    const issues = await getCredentialReadinessIssues("org-1", workflow, () => true);
    expect(issues).toEqual([]);
  });
});
