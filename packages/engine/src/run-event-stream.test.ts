import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetRunEventPublisherForTests,
  createRedisRunEventPublisher,
  getRunEventPublisher,
  publishRunEvent,
  runEventChannel,
  runIdFromRunEventChannel,
  setRunEventPublisher,
  type PublishedRunEvent,
} from "./run-event-stream";

const sampleEvent: PublishedRunEvent = {
  kind: "event",
  id: "evt-1",
  nodeId: "node-a",
  type: "node.succeeded",
  payload: { ok: true },
  createdAt: "2026-05-28T00:00:00.000Z",
};

/** Flush the microtask + macrotask queue so fire-and-forget publishes settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  _resetRunEventPublisherForTests();
  vi.restoreAllMocks();
});

describe("run-event-stream seam", () => {
  it("channel name round-trips through runEventChannel / runIdFromRunEventChannel", () => {
    expect(runEventChannel("run-123")).toBe("janusly:run-events:run-123");
    expect(runIdFromRunEventChannel("janusly:run-events:run-123")).toBe("run-123");
    expect(runIdFromRunEventChannel("some:other:channel")).toBeNull();
  });

  it("no-ops when no publisher is registered", () => {
    expect(getRunEventPublisher()).toBeNull();
    expect(() => publishRunEvent("run-1", sampleEvent)).not.toThrow();
  });

  it("forwards to the registered publisher", () => {
    const spy = vi.fn();
    setRunEventPublisher(spy);
    publishRunEvent("run-1", sampleEvent);
    expect(spy).toHaveBeenCalledWith("run-1", sampleEvent);
  });

  it("swallows publisher faults so the preceding persistence write is unaffected", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setRunEventPublisher(() => {
      throw new Error("redis down");
    });
    expect(() => publishRunEvent("run-1", sampleEvent)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("createRedisRunEventPublisher", () => {
  it("PUBLISHes the org-scoped message to the per-run channel", async () => {
    const publish = vi.fn(async (_channel: string, _message: string) => 1);
    const resolveOrgId = vi.fn(async () => "org-A");
    const publisher = createRedisRunEventPublisher({ publish, resolveOrgId });

    publisher("run-1", sampleEvent);
    await flush();

    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, message] = publish.mock.calls[0]!;
    expect(channel).toBe("janusly:run-events:run-1");
    expect(JSON.parse(message as string)).toEqual({ orgId: "org-A", event: sampleEvent });
  });

  it("resolves orgId once per run and serves the rest from cache", async () => {
    const publish = vi.fn(async (_channel: string, _message: string) => 1);
    const resolveOrgId = vi.fn(async () => "org-A");
    const publisher = createRedisRunEventPublisher({ publish, resolveOrgId });

    publisher("run-1", sampleEvent);
    await flush();
    publisher("run-1", { ...sampleEvent, id: "evt-2" });
    await flush();

    expect(resolveOrgId).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("skips publishing for an unknown / uncommitted run (orgId null)", async () => {
    const publish = vi.fn(async (_channel: string, _message: string) => 1);
    const resolveOrgId = vi.fn(async () => null);
    const publisher = createRedisRunEventPublisher({ publish, resolveOrgId });

    publisher("run-unknown", sampleEvent);
    await flush();

    expect(publish).not.toHaveBeenCalled();
  });

  it("never throws when the transport rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const publish = vi.fn((_channel: string, _message: string): Promise<number> =>
      Promise.reject(new Error("publish failed")),
    );
    const resolveOrgId = vi.fn(async () => "org-A");
    const publisher = createRedisRunEventPublisher({ publish, resolveOrgId });

    expect(() => publisher("run-1", sampleEvent)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
  });
});
