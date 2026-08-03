import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  deadLettersTable,
  runEventsTable,
  runNodesTable,
  runsTable,
  publishInitialNodeMock,
  transactionMock,
  txInsertMock,
} = vi.hoisted(() => ({
  deadLettersTable: { id: "id", attempt: "attempt", orgId: "orgId", runId: "runId", nodeId: "nodeId" },
  runEventsTable: { name: "runEvents" },
  runNodesTable: { name: "runNodes" },
  runsTable: { name: "runs" },
  publishInitialNodeMock: vi.fn(),
  transactionMock: vi.fn(),
  txInsertMock: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: { transaction: transactionMock },
  deadLetters: deadLettersTable,
  runEvents: runEventsTable,
  runNodes: runNodesTable,
  runs: runsTable,
}));

vi.mock("../initial-node-publication", () => ({
  publishInitialNode: publishInitialNodeMock,
}));

vi.mock("../safe-persist", () => ({
  safePersistPayload: (payload: unknown) => payload,
}));

import {
  prepareRuntimeFailureWorkflow,
  runRuntimeFailureDrill,
} from "./runtime-failure-drill";

const workflow = {
  dslVersion: "1.0" as const,
  id: "incident-triage",
  name: "Incident triage",
  nodes: [
    { id: "trigger", type: "webhook_received" as const, config: { endpointKey: "incident-triage" } },
    { id: "classify", type: "ai" as const, config: { prompt: "Classify" } },
    {
      id: "open_issue",
      type: "tool" as const,
      config: { tool: "github.create_issue", input: { title: "Incident" } },
    },
    { id: "notify", type: "tool" as const, config: { tool: "slack.post" } },
  ],
  edges: [
    { from: "trigger", to: "classify" },
    { from: "classify", to: "open_issue" },
    { from: "open_issue", to: "notify" },
  ],
};

const source = {
  kind: "solution_pack_drill" as const,
  packId: "incident-triage",
  fixtureId: "github_secret_unbound",
  failureMode: "credential_unavailable",
  recoveryPath: "runtime_failure" as const,
};

beforeEach(() => {
  delete process.env.JANUSLY_RUNTIME_DRILL_MISSING_SECRET;
  publishInitialNodeMock.mockReset();
  publishInitialNodeMock.mockResolvedValue(undefined);
  txInsertMock.mockReset();
  transactionMock.mockReset();
  transactionMock.mockImplementation(async (handler: (tx: unknown) => Promise<void>) => handler({
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        txInsertMock(table, values);
        return Promise.resolve(undefined);
      },
    }),
  }));
});

afterEach(() => {
  delete process.env.JANUSLY_RUNTIME_DRILL_MISSING_SECRET;
});

describe("prepareRuntimeFailureWorkflow", () => {
  it("clones the workflow and puts a missing-secret probe before the original target config", () => {
    const prepared = prepareRuntimeFailureWorkflow(workflow, "open_issue");
    const target = prepared.workflow.nodes.find((node) => node.id === "open_issue")!;

    expect(prepared.ancestorIds).toEqual(new Set(["trigger", "classify"]));
    expect(Object.keys(target.config)[0]).toBe("runtimeDrillProbe");
    expect(target.config.runtimeDrillProbe).toBe("{{secret.JANUSLY_RUNTIME_DRILL_MISSING_SECRET}}");
    expect(target.config.tool).toBe("github.create_issue");
    expect(workflow.nodes.find((node) => node.id === "open_issue")?.config).not.toHaveProperty("runtimeDrillProbe");
  });
});

describe("runRuntimeFailureDrill", () => {
  it("seeds only ancestors, queues the target, and returns the real DLQ identity", async () => {
    const result = await runRuntimeFailureDrill({
      orgId: "org-1",
      createdBy: "user-1",
      workflow,
      failedNodeId: "open_issue",
      input: { event: { payload: { alertName: "Database down" } } },
      source,
    }, {
      now: () => new Date("2026-07-31T12:00:00.000Z"),
      waitForFailure: vi.fn(async () => ({ id: "dlq-runtime", attempt: 3 })),
    });

    expect(result).toMatchObject({
      runId: expect.any(String),
      deadLetterId: "dlq-runtime",
      evidence: {
        recoveryPath: "runtime_failure",
        boundary: "worker_dlq",
        executedNodeId: "open_issue",
        seededAncestorCount: 2,
        attempts: 3,
      },
    });

    const runInsert = txInsertMock.mock.calls.find(([table]) => table === runsTable)?.[1];
    expect(runInsert).toMatchObject({
      id: result.runId,
      orgId: "org-1",
      replayMode: "validation",
      validationEvidenceLevel: "static",
      inputJson: { drill: source },
    });

    const nodeInserts = txInsertMock.mock.calls.find(([table]) => table === runNodesTable)?.[1] as Array<{
      nodeId: string;
      status: string;
      attempts: number;
      queuePublicationGeneration: number | null;
    }>;
    expect(nodeInserts.find((node) => node.nodeId === "trigger")?.status).toBe("succeeded");
    expect(nodeInserts.find((node) => node.nodeId === "classify")?.status).toBe("succeeded");
    expect(nodeInserts.find((node) => node.nodeId === "open_issue")).toMatchObject({
      status: "queued",
      attempts: 1,
      queuePublicationGeneration: 1,
    });
    expect(nodeInserts.find((node) => node.nodeId === "notify")?.status).toBe("pending");
    expect(publishInitialNodeMock).toHaveBeenCalledWith({
      runId: result.runId,
      nodeId: "open_issue",
      attempt: 1,
      publicationGeneration: 1,
    });
  });

  it("fails closed when the reserved probe secret is configured", async () => {
    process.env.JANUSLY_RUNTIME_DRILL_MISSING_SECRET = "unexpected";
    await expect(runRuntimeFailureDrill({
      orgId: "org-1",
      workflow,
      failedNodeId: "open_issue",
      source,
    })).rejects.toThrow("must remain unset");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown target before persisting a run", async () => {
    await expect(runRuntimeFailureDrill({
      orgId: "org-1",
      workflow,
      failedNodeId: "missing",
      source,
    })).rejects.toThrow("node missing not found");
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
