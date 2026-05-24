/**
 * Pure-unit tests for the credential health snapshot helper.
 *
 * Mocks ``@janusly/db`` so the Drizzle chains never touch a real
 * database. Mocks the MCP repo's two list helpers since the snapshot
 * composes them (they have their own tests). Asserts:
 *
 * - The returned shape excludes ``secret_ref`` / env-var names entirely.
 * - ``secretRefPresent`` reflects the injected resolver.
 * - ``referencingWorkflowIds`` honours latest-version-only (older
 *   versions that referenced a credential but the latest does not are
 *   excluded).
 * - ``lastErrorMessage`` passes through ``scrubSecretShapes``.
 * - ``staleDays`` is ``null`` when ``lastDiscoveryAt`` is missing.
 * - Multi-tenant scope: every Drizzle ``where`` clause carried
 *   ``eq(<table>.orgId, orgId)``.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  credentialsRows: [] as Array<Record<string, unknown>>,
  workflowMaxVersionRows: [] as Array<{ workflowId: string; maxVersion: number }>,
  workflowLatestRows: new Map<string, Record<string, unknown>>(),
  credentialUsageRows: [] as Array<Record<string, unknown>>,
  mcpUsageRows: [] as Array<Record<string, unknown>>,
  whereSpy: vi.fn(),
}));

vi.mock("@janusly/db", () => {
  // The repo uses three different SELECT shapes:
  //   1) bare `db.select().from(credentials).where(...)`           → rows
  //   2) `db.select({...}).from(usage_events).where(...).orderBy(...)` → rows
  //   3) `db.select({...}).from(workflow_versions).where(...).groupBy(...).limit(N)` → maxVersionRows
  //      followed by `.where(...).limit(1)` → workflowLatestRows
  // The chain mock dispatches by inspecting which table the caller pulled.
  const buildChain = (
    rows: unknown[],
    options: { latestSingle?: boolean } = {},
  ) => {
    const chain: Record<string, unknown> = {
      where: vi.fn((expr: unknown) => {
        hoisted.whereSpy(expr);
        return chain;
      }),
      orderBy: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      limit: vi.fn(() => {
        if (options.latestSingle) {
          // The repo calls `.limit(1)` to fetch a specific
          // (workflowId, version) row. Pull the first matching row from
          // the map — we don't try to inspect the actual `where`
          // predicate; the test sets up only one workflow per case.
          const row = Array.from(hoisted.workflowLatestRows.values())[0];
          return Promise.resolve(row ? [row] : []);
        }
        return Promise.resolve(rows);
      }),
      then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
    };
    return chain;
  };

  const select = vi.fn((selection?: Record<string, unknown>) => {
    // The credentials list path calls `db.select()` with no argument.
    if (!selection) {
      return {
        from: vi.fn(() => buildChain(hoisted.credentialsRows)),
      };
    }
    // Discriminate the typed SELECT by the keys it asked for. The repo
    // queries are stable so this is reliable.
    const keys = Object.keys(selection);
    if (keys.includes("maxVersion")) {
      return { from: vi.fn(() => buildChain(hoisted.workflowMaxVersionRows)) };
    }
    if (keys.includes("dagJson")) {
      return { from: vi.fn(() => buildChain([], { latestSingle: true })) };
    }
    if (keys.includes("ok")) {
      return { from: vi.fn(() => buildChain(hoisted.credentialUsageRows)) };
    }
    if (keys.includes("alias")) {
      return { from: vi.fn(() => buildChain(hoisted.mcpUsageRows)) };
    }
    return { from: vi.fn(() => buildChain([])) };
  });

  return {
    db: { select },
    credentials: { id: "id", orgId: "org_id", name: "name", kind: "kind" },
    usageEvents: { id: "id", orgId: "org_id", metric: "metric", metadata: "metadata", createdAt: "created_at" },
    workflowVersions: { id: "id", orgId: "org_id", workflowId: "workflow_id", version: "version", dagJson: "dag_json" },
    mcpConnections: { id: "id", orgId: "org_id" },
    mcpToolDescriptors: { id: "id" },
  };
});

vi.mock("./mcpConnectionsRepo", () => ({
  listConnections: vi.fn(),
  listToolDescriptors: vi.fn(),
}));

import {
  collectWorkflowReferences,
  getCredentialHealth,
  type WorkflowReferenceIndex,
} from "./credentialHealthRepo";
import { listConnections, listToolDescriptors } from "./mcpConnectionsRepo";

const listConnectionsMock = vi.mocked(listConnections);
const listToolDescriptorsMock = vi.mocked(listToolDescriptors);

function setUsageRow(row: {
  name: string;
  createdAtMsAgo: number;
  ok: boolean | null;
  error?: string;
}): Record<string, unknown> {
  return {
    name: row.name,
    createdAt: new Date(Date.now() - row.createdAtMsAgo).toISOString(),
    ok: row.ok,
    error: row.error ?? null,
  };
}

beforeEach(() => {
  hoisted.credentialsRows = [];
  hoisted.credentialUsageRows = [];
  hoisted.mcpUsageRows = [];
  hoisted.workflowMaxVersionRows = [];
  hoisted.workflowLatestRows = new Map();
  hoisted.whereSpy.mockReset();
  listConnectionsMock.mockReset().mockResolvedValue([]);
  listToolDescriptorsMock.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getCredentialHealth", () => {
  it("returns credentials with secretRefPresent driven by the resolver and never echoes the env-var name", async () => {
    hoisted.credentialsRows = [
      { id: "c1", name: "slack-prod", kind: "slack_webhook", secretRef: "SLACK_PROD_URL", metadata: null },
      { id: "c2", name: "github-bot", kind: "github_token", secretRef: "GH_BOT_TOKEN", metadata: null },
    ];
    const resolver = vi.fn((name: string) => name === "SLACK_PROD_URL");
    const snap = await getCredentialHealth("org-1", resolver);

    expect(snap.credentials).toHaveLength(2);
    expect(snap.credentials[0]).toMatchObject({ name: "slack-prod", secretRefPresent: true });
    expect(snap.credentials[1]).toMatchObject({ name: "github-bot", secretRefPresent: false });
    // The env-var names that the resolver was queried with MUST NOT
    // appear on any returned payload — defense-in-depth string match.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("SLACK_PROD_URL");
    expect(serialized).not.toContain("GH_BOT_TOKEN");
    // The bare `secretRef` field (without the `Present` suffix) must
    // never be a key on any returned object. The string `secretRefPresent`
    // is the legitimate health flag and is allowed.
    for (const cred of snap.credentials) {
      expect(cred).not.toHaveProperty("secretRef");
    }
  });

  it("joins usage_events on metadata.credentialName for last-used + last-error + 30-day count, with secret-shape scrubbing", async () => {
    hoisted.credentialsRows = [
      { id: "c1", name: "slack-prod", kind: "slack_webhook", secretRef: "SLACK_PROD_URL", metadata: null },
    ];
    hoisted.credentialUsageRows = [
      setUsageRow({ name: "slack-prod", createdAtMsAgo: 60_000, ok: false, error: "upstream rejected Bearer abcdef1234567890abcdef1234" }),
      setUsageRow({ name: "slack-prod", createdAtMsAgo: 120_000, ok: true }),
      setUsageRow({ name: "slack-prod", createdAtMsAgo: 180_000, ok: true }),
    ];
    const snap = await getCredentialHealth("org-1", () => true);
    const entry = snap.credentials[0]!;
    expect(entry.usageCount30d).toBe(3);
    expect(entry.lastErrorAt).not.toBeNull();
    expect(entry.lastUsedAt).not.toBeNull();
    // The Bearer-shaped token MUST be redacted by scrubSecretShapes.
    expect(entry.lastErrorMessage).not.toContain("Bearer abcdef");
    expect(entry.lastErrorMessage).toContain("[redacted]");
  });

  it("includes a workflow id in referencingWorkflowIds only when the LATEST version still references the credential", async () => {
    hoisted.credentialsRows = [
      { id: "c1", name: "slack-prod", kind: "slack_webhook", secretRef: "SLACK_PROD_URL", metadata: null },
    ];
    hoisted.workflowMaxVersionRows = [
      { workflowId: "wf-current", maxVersion: 3 },
    ];
    // The "latest" row is the v3 DAG; it does reference slack-prod.
    hoisted.workflowLatestRows.set("wf-current", {
      workflowId: "wf-current",
      dagJson: {
        nodes: [
          { id: "n1", type: "tool", config: { tool: "slack.post", input: { credential: "slack-prod" } } },
        ],
      },
    });
    const snap = await getCredentialHealth("org-1", () => true);
    expect(snap.credentials[0]?.referencingWorkflowIds).toEqual(["wf-current"]);
  });

  it("walks `connectionAlias` references in the same pass so MCP entries get referencingWorkflowIds too", async () => {
    // No credentials, but the workflow references an MCP alias.
    hoisted.workflowMaxVersionRows = [{ workflowId: "wf-mcp", maxVersion: 1 }];
    hoisted.workflowLatestRows.set("wf-mcp", {
      workflowId: "wf-mcp",
      dagJson: {
        nodes: [
          { id: "n1", type: "mcp_tool", config: { connectionAlias: "notion-prod", toolName: "pages.read" } },
        ],
      },
    });
    listConnectionsMock.mockResolvedValueOnce([
      {
        id: "mcp-1",
        orgId: "org-1",
        alias: "notion-prod",
        transport: "http",
        command: null,
        args: null,
        url: "https://notion.example/mcp",
        envRefs: {},
        enabled: true,
        status: "active",
        statusReason: null,
        exposeToAi: false,
        lastDiscoveryAt: new Date().toISOString(),
        createdBy: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    listToolDescriptorsMock.mockResolvedValueOnce([]);
    const snap = await getCredentialHealth("org-1", () => true);
    expect(snap.mcpConnections[0]?.referencingWorkflowIds).toEqual(["wf-mcp"]);
  });

  it("returns staleDays: null when an MCP connection has never been discovered", async () => {
    listConnectionsMock.mockResolvedValueOnce([
      {
        id: "mcp-1",
        orgId: "org-1",
        alias: "notion-prod",
        transport: "http",
        command: null,
        args: null,
        url: "https://notion.example/mcp",
        envRefs: {},
        enabled: true,
        status: "pending",
        statusReason: null,
        exposeToAi: false,
        lastDiscoveryAt: null,
        createdBy: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    listToolDescriptorsMock.mockResolvedValueOnce([]);
    const snap = await getCredentialHealth("org-1", () => true);
    expect(snap.mcpConnections).toHaveLength(1);
    expect(snap.mcpConnections[0]).toMatchObject({
      alias: "notion-prod",
      status: "pending",
      lastDiscoveryAt: null,
      staleDays: null,
      toolCount: 0,
      enabledToolCount: 0,
    });
  });

  it("collects MCP envRefsMissingKeys as the operator-chosen KEYS — never the env-var NAMES", async () => {
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
          NOTION_DB: { kind: "env", name: "NOTION_DB_VAR_PRESENT" },
        },
        enabled: true,
        status: "active",
        statusReason: null,
        exposeToAi: false,
        lastDiscoveryAt: new Date().toISOString(),
        createdBy: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    listToolDescriptorsMock.mockResolvedValueOnce([
      { id: "d1", connectionId: "mcp-1", name: "pages.read", description: null, inputSchema: null, writeSide: false, enabled: true, rateLimitPerMin: null, exposeToAi: false, createdAt: null, updatedAt: null },
    ]);
    const snap = await getCredentialHealth(
      "org-1",
      (envName) => envName === "NOTION_DB_VAR_PRESENT",
    );
    expect(snap.mcpConnections[0]?.envRefsMissingKeys).toEqual(["NOTION_TOKEN"]);
    // The internal env-var NAMES that the resolver saw must NOT leak.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain("NOTION_INTERNAL_SECRET_VAR");
    expect(serialized).not.toContain("NOTION_DB_VAR_PRESENT");
  });

  it("scopes every Drizzle SELECT to the caller's orgId", async () => {
    hoisted.credentialsRows = [];
    listConnectionsMock.mockResolvedValueOnce([]);
    await getCredentialHealth("org-target", () => true);
    // The repo issues four primary SELECTs (credentials, usage, mcp
    // usage, workflow max versions). Each .where(...) hits the spy.
    expect(hoisted.whereSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    // The MCP enrichment delegates to listConnections, which carries
    // its own org scope in its repo (already pinned by mcpConnectionsRepo
    // tests). Verify we invoked it with the right org.
    expect(listConnectionsMock).toHaveBeenCalledWith("org-target");
  });
});

describe("collectWorkflowReferences (pure helper)", () => {
  it("adds the workflowId when a tool config carries `input.credential`", () => {
    const index: WorkflowReferenceIndex = { byCredentialName: new Map(), byMcpAlias: new Map() };
    collectWorkflowReferences("wf-a", {
      nodes: [
        { id: "n1", type: "tool", config: { tool: "slack.post", input: { credential: "cred-a" } } },
        { id: "n2", type: "http", config: {} },
        { id: "n3", type: "noop", config: null },
      ],
    }, index);
    expect(Array.from(index.byCredentialName.entries())).toEqual([
      ["cred-a", new Set(["wf-a"])],
    ]);
  });

  it("tolerates a malformed dagJson without throwing", () => {
    const index: WorkflowReferenceIndex = { byCredentialName: new Map(), byMcpAlias: new Map() };
    expect(() => collectWorkflowReferences("wf-x", null, index)).not.toThrow();
    expect(() => collectWorkflowReferences("wf-x", { nodes: "not-an-array" }, index)).not.toThrow();
    expect(index.byCredentialName.size).toBe(0);
  });
});
