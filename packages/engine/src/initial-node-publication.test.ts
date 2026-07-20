import { describe, expect, it, vi } from "vitest";

vi.mock("./queue", () => ({ enqueueNode: vi.fn() }));
vi.mock("./persistence", () => ({
  appendEvent: vi.fn(),
  markQueuePublicationSucceeded: vi.fn(),
}));

import { publishInitialNode } from "./initial-node-publication";

const input = {
  runId: "run-1",
  nodeId: "node-1",
  attempt: 1,
  publicationGeneration: 1,
};

describe("publishInitialNode", () => {
  it("acknowledges an accepted generation and records its timeline event", async () => {
    const enqueue = vi.fn(async () => undefined);
    const acknowledge = vi.fn(async () => true);
    const appendQueuedEvent = vi.fn(async () => "event-1");

    await expect(publishInitialNode(input, { enqueue, acknowledge, appendQueuedEvent })).resolves.toBe(true);

    expect(enqueue).toHaveBeenCalledWith(input);
    expect(acknowledge).toHaveBeenCalledWith("run-1", "node-1", 1, 1, undefined);
    expect(appendQueuedEvent).toHaveBeenCalledWith("run-1", "node-1", "node.queued", {});
  });

  it("leaves the durable marker for reconciliation when Redis rejects the fast path", async () => {
    const enqueue = vi.fn(async () => { throw new Error("unavailable"); });
    const acknowledge = vi.fn(async () => true);
    const appendQueuedEvent = vi.fn(async () => "event-1");
    const warn = vi.fn();

    await expect(publishInitialNode(input, { enqueue, acknowledge, appendQueuedEvent, warn })).resolves.toBe(false);

    expect(acknowledge).not.toHaveBeenCalled();
    expect(appendQueuedEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[initial-node-publication] immediate publication deferred",
      expect.objectContaining({ stage: "enqueue", errorName: "Error" }),
    );
  });

  it("does not emit a queued event when the exact generation cannot be acknowledged", async () => {
    const appendQueuedEvent = vi.fn(async () => "event-1");
    const warn = vi.fn();

    await expect(publishInitialNode(input, {
      enqueue: vi.fn(async () => undefined),
      acknowledge: vi.fn(async () => false),
      appendQueuedEvent,
      warn,
    })).resolves.toBe(false);

    expect(appendQueuedEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[initial-node-publication] exact generation was not acknowledged",
      expect.objectContaining({ stage: "acknowledge" }),
    );
  });

  it("does not fail an accepted run when its optional timeline event fails", async () => {
    const warn = vi.fn();

    await expect(publishInitialNode(input, {
      enqueue: vi.fn(async () => undefined),
      acknowledge: vi.fn(async () => true),
      appendQueuedEvent: vi.fn(async () => { throw new Error("database unavailable"); }),
      warn,
    })).resolves.toBe(true);

    expect(warn).toHaveBeenCalledWith(
      "[initial-node-publication] queued timeline event was not recorded",
      expect.objectContaining({ errorName: "Error" }),
    );
  });
});
