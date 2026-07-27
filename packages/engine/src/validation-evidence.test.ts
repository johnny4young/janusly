import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSetMock = vi.hoisted(() => vi.fn());
const insertValuesMock = vi.hoisted(() => vi.fn());
const transactionMock = vi.hoisted(() => vi.fn());
const publishRunEventMock = vi.hoisted(() => vi.fn());

vi.mock("@janusly/db", () => ({
  db: { transaction: transactionMock },
  runs: {
    id: "runs.id",
    replayMode: "runs.replay_mode",
    validationEvidenceLevel: "runs.validation_evidence_level",
  },
  runEvents: { id: "run_events.id" },
}));

vi.mock("./run-event-stream", () => ({
  publishRunEvent: publishRunEventMock,
}));

import { recordValidationWriteSkip } from "./validation-evidence";

beforeEach(() => {
  vi.clearAllMocks();
  updateSetMock.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  insertValuesMock.mockResolvedValue(undefined);
  transactionMock.mockImplementation(async (handler) => handler({
    update: vi.fn(() => ({ set: updateSetMock })),
    insert: vi.fn(() => ({ values: insertValuesMock })),
  }));
});

describe("recordValidationWriteSkip", () => {
  it("persists the evidence upgrade and event before publishing live telemetry", async () => {
    const id = await recordValidationWriteSkip(
      "run-1",
      "node-1",
      "tool.dry_run.skipped",
      { tool: "email.send" },
    );

    expect(id).toEqual(expect.any(String));
    expect(updateSetMock).toHaveBeenCalledWith({
      validationEvidenceLevel: "writes_skipped",
    });
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      id,
      runId: "run-1",
      nodeId: "node-1",
      type: "tool.dry_run.skipped",
      payload: { tool: "email.send" },
    }));
    expect(publishRunEventMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        kind: "event",
        id,
        type: "tool.dry_run.skipped",
      }),
    );
    expect(transactionMock.mock.invocationCallOrder[0]).toBeLessThan(
      publishRunEventMock.mock.invocationCallOrder[0]!,
    );
  });
});
