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
    inputJson: "runs.input_json",
  },
  runEvents: { id: "run_events.id" },
}));

vi.mock("./run-event-stream", () => ({
  publishRunEvent: publishRunEventMock,
}));

import {
  recordValidationProviderReceipt,
  recordValidationWriteSkip,
} from "./validation-evidence";

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

describe("recordValidationProviderReceipt", () => {
  it("atomically promotes qualified evidence and persists the receipt", async () => {
    const returningMock = vi.fn().mockResolvedValue([{ id: "run-1" }]);
    updateSetMock.mockReturnValueOnce({
      where: vi.fn(() => ({ returning: returningMock })),
    });
    const receipt = {
      kind: "provider_simulation_receipt",
      version: 1,
      provider: "webhook",
      operation: "deliver",
      scope: "validation",
      effectId: "effect-1",
      idempotencyKey: "invoice-1",
      applied: true,
      duplicate: false,
      requestId: "request-1",
    } as const;

    const id = await recordValidationProviderReceipt(
      "run-1",
      "node-1",
      "webhook.send",
      receipt,
    );

    expect(updateSetMock).toHaveBeenCalledWith({
      validationEvidenceLevel: "provider_simulated",
    });
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      id,
      runId: "run-1",
      nodeId: "node-1",
      type: "validation.provider.receipt",
      payload: { tool: "webhook.send", receipt },
    }));
    expect(publishRunEventMock).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ id, type: "validation.provider.receipt" }),
    );
  });

  it("refuses to record a receipt when the run cannot be promoted", async () => {
    updateSetMock.mockReturnValueOnce({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
    });

    await expect(recordValidationProviderReceipt(
      "run-1",
      "node-1",
      "webhook.send",
      {
        kind: "provider_simulation_receipt",
        version: 1,
        provider: "webhook",
        operation: "deliver",
        scope: "validation",
        effectId: "effect-1",
        idempotencyKey: "invoice-1",
        applied: true,
        duplicate: false,
        requestId: "request-1",
      },
    )).rejects.toThrow("receipt rejected");
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(publishRunEventMock).not.toHaveBeenCalled();
  });
});
