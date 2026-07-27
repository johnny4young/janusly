import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  deadLettersTable,
  runEventsTable,
  runNodesTable,
  runsTable,
  transactionMock,
  txInsertMock,
  recordRecoveryItemCreationEventMock,
} = vi.hoisted(() => ({
  deadLettersTable: { name: "deadLetters" },
  runEventsTable: { name: "runEvents" },
  runNodesTable: { name: "runNodes" },
  runsTable: { name: "runs" },
  transactionMock: vi.fn(),
  txInsertMock: vi.fn(),
  recordRecoveryItemCreationEventMock: vi.fn(),
}));

vi.mock("@janusly/data", () => ({
  recordRecoveryItemCreationEvent: recordRecoveryItemCreationEventMock,
}));

vi.mock("@janusly/db", () => ({
  db: {
    transaction: transactionMock,
  },
  deadLetters: deadLettersTable,
  runEvents: runEventsTable,
  runNodes: runNodesTable,
  runs: runsTable,
}));

vi.mock("../safe-persist", () => ({
  safePersistPayload: (payload: unknown) => payload,
}));

import { injectSampleFailure } from "./sample-failure";

const workflow = {
  dslVersion: "1.0" as const,
  id: "incident-triage",
  name: "Incident triage",
  nodes: [
    { id: "trigger", type: "webhook" as const, config: {} },
    { id: "classify", type: "ai" as const, config: { prompt: "Classify the incident" } },
  ],
  edges: [{ from: "trigger", to: "classify" }],
};

const source = {
  kind: "solution_pack_drill" as const,
  packId: "incident-triage",
  fixtureId: "classification_output_invalid",
  failureMode: "ai_output_invalid",
  recoveryPath: "direct_failure" as const,
};

beforeEach(() => {
  recordRecoveryItemCreationEventMock.mockReset();
  recordRecoveryItemCreationEventMock.mockResolvedValue(undefined);
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

describe("injectSampleFailure", () => {
  it("persists drill provenance on the run and failed event without changing the classifier error", async () => {
    const errorJson = {
      name: "AiOutputValidationError",
      code: "E_AI_OUTPUT_INVALID",
      message: "AI output did not match the required severity response contract",
    };

    const result = await injectSampleFailure({
      orgId: "org-1",
      createdBy: "user-1",
      workflow,
      failedNodeId: "classify",
      errorJson,
      source,
    });

    expect(result).toEqual({ runId: expect.any(String), deadLetterId: expect.any(String) });
    expect(transactionMock).toHaveBeenCalledTimes(1);

    const runInsert = txInsertMock.mock.calls.find(([table]) => table === runsTable)?.[1];
    expect(runInsert).toMatchObject({
      id: result.runId,
      orgId: "org-1",
      status: "failed",
      createdBy: "user-1",
      inputJson: { workflow, input: {}, drill: source },
      replayMode: "validation",
      validationEvidenceLevel: "static",
    });

    const eventInsert = txInsertMock.mock.calls.find(([table]) => table === runEventsTable)?.[1];
    expect(eventInsert).toMatchObject({
      runId: result.runId,
      nodeId: "classify",
      type: "node.failed",
      payload: { error: errorJson, drill: source },
    });

    const nodeInsert = txInsertMock.mock.calls.find(([table]) => table === runNodesTable)?.[1];
    const deadLetterInsert = txInsertMock.mock.calls.find(([table]) => table === deadLettersTable)?.[1];
    expect(nodeInsert).toMatchObject({ errorJson });
    expect(deadLetterInsert).toMatchObject({
      id: result.deadLetterId,
      orgId: "org-1",
      nodeId: "classify",
      errorJson,
      status: "open",
    });
    expect((deadLetterInsert as { errorJson: unknown }).errorJson).not.toHaveProperty("drill");
    expect(recordRecoveryItemCreationEventMock).toHaveBeenCalledWith({
      orgId: "org-1",
      deadLetterId: result.deadLetterId,
      workflowId: "incident-triage",
      errorSignature: expect.any(String),
      createdBy: "user-1",
    });
  });

  it("rejects a fixture whose node is absent before opening a transaction", async () => {
    await expect(injectSampleFailure({
      orgId: "org-1",
      workflow,
      failedNodeId: "missing",
      errorJson: { code: "fixture_error" },
      source,
    })).rejects.toThrow("node missing not found");

    expect(transactionMock).not.toHaveBeenCalled();
    expect(recordRecoveryItemCreationEventMock).not.toHaveBeenCalled();
  });
});
