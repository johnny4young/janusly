import { describe, expect, it, vi } from "vitest";

import { runEventChannel, type PublishedRunEvent } from "@janusly/engine/src/run-event-stream";

import { createRunStreamHub, type SubscriberClient } from "./run-stream";

/**
 * Fake ioredis subscriber: records subscribe/unsubscribe calls and lets a test
 * push a message onto a channel (mimicking a Redis PUBLISH arriving).
 */
function buildFakeSubscriber(options: { rejectSubscribe?: boolean } = {}) {
  const subscribed = new Set<string>();
  const subscribeCalls: string[] = [];
  const unsubscribeCalls: string[] = [];
  let handler: ((channel: string, message: string) => void) | null = null;

  const client: SubscriberClient = {
    subscribe: vi.fn(async (channel: string) => {
      if (options.rejectSubscribe) throw new Error("subscribe failed");
      subscribed.add(channel);
      subscribeCalls.push(channel);
      return 1;
    }),
    unsubscribe: vi.fn(async (channel: string) => {
      subscribed.delete(channel);
      unsubscribeCalls.push(channel);
      return 0;
    }),
    on: (_event, listener) => {
      handler = listener;
      return client;
    },
  };

  return {
    client,
    subscribeCalls,
    unsubscribeCalls,
    isSubscribed: (channel: string) => subscribed.has(channel),
    emit: (runId: string, orgId: string, event: PublishedRunEvent) => {
      handler?.(runEventChannel(runId), JSON.stringify({ orgId, event }));
    },
    emitRaw: (channel: string, message: string) => handler?.(channel, message),
  };
}

const eventFor = (id: string): PublishedRunEvent => ({
  kind: "event",
  id,
  nodeId: "n1",
  type: "node.succeeded",
  payload: { ok: true },
  createdAt: "2026-05-28T00:00:00.000Z",
});

describe("run-stream hub", () => {
  it("subscribes once per run and unsubscribes when the last client leaves", () => {
    const fake = buildFakeSubscriber();
    const hub = createRunStreamHub(fake.client);

    const a = hub.addSubscriber("run-1", "org-A", () => {}, 50);
    const b = hub.addSubscriber("run-1", "org-A", () => {}, 50);
    expect(a.ok && b.ok).toBe(true);
    // Two clients, ONE channel subscription.
    expect(fake.subscribeCalls).toEqual([runEventChannel("run-1")]);
    expect(fake.isSubscribed(runEventChannel("run-1"))).toBe(true);

    if (a.ok) a.remove();
    expect(fake.unsubscribeCalls).toEqual([]); // one client still attached
    if (b.ok) b.remove();
    expect(fake.unsubscribeCalls).toEqual([runEventChannel("run-1")]);
    expect(fake.isSubscribed(runEventChannel("run-1"))).toBe(false);
  });

  it("exposes one shared readiness barrier for every subscriber of a run", async () => {
    let acknowledge!: () => void;
    const ready = new Promise<void>((resolve) => { acknowledge = resolve; });
    const fake = buildFakeSubscriber();
    fake.client.subscribe = vi.fn(() => ready);
    const hub = createRunStreamHub(fake.client);

    const first = hub.addSubscriber("run-1", "org-A", () => {}, 50);
    const second = hub.addSubscriber("run-1", "org-A", () => {}, 50);
    if (!first.ok || !second.ok) throw new Error("subscriber was unexpectedly rejected");

    expect(first.ready).toBe(second.ready);
    let settled = false;
    void first.ready.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledge();
    await expect(first.ready).resolves.toBeUndefined();
  });

  it("fans a message to every client of the run", () => {
    const fake = buildFakeSubscriber();
    const hub = createRunStreamHub(fake.client);
    const received1: PublishedRunEvent[] = [];
    const received2: PublishedRunEvent[] = [];
    hub.addSubscriber("run-1", "org-A", (e) => received1.push(e), 50);
    hub.addSubscriber("run-1", "org-A", (e) => received2.push(e), 50);

    fake.emit("run-1", "org-A", eventFor("evt-1"));

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect(received1[0]!.kind === "event" && received1[0]!.id).toBe("evt-1");
  });

  it("never delivers a run's events to a subscriber of a different run", () => {
    const fake = buildFakeSubscriber();
    const hub = createRunStreamHub(fake.client);
    const received: PublishedRunEvent[] = [];
    hub.addSubscriber("run-A", "org-A", (e) => received.push(e), 50);

    // A message for run-B (a different org's run on a different channel).
    fake.emit("run-B", "org-B", eventFor("evt-x"));

    expect(received).toHaveLength(0);
  });

  it("drops a message whose org does not match the subscriber (defense in depth)", () => {
    const fake = buildFakeSubscriber();
    const hub = createRunStreamHub(fake.client);
    const received: PublishedRunEvent[] = [];
    hub.addSubscriber("run-1", "org-A", (e) => received.push(e), 50);

    // Same channel, but the message claims a different org — must be dropped.
    fake.emit("run-1", "org-EVIL", eventFor("evt-1"));

    expect(received).toHaveLength(0);
  });

  it("ignores malformed channel payloads without throwing", () => {
    const fake = buildFakeSubscriber();
    const hub = createRunStreamHub(fake.client);
    const received: PublishedRunEvent[] = [];
    hub.addSubscriber("run-1", "org-A", (e) => received.push(e), 50);

    expect(() => fake.emitRaw(runEventChannel("run-1"), "not json")).not.toThrow();
    expect(() => fake.emitRaw("janusly:run-events:run-1", JSON.stringify({ nope: 1 }))).not.toThrow();
    expect(received).toHaveLength(0);
  });

  it("enforces the per-org cap and recovers a slot on remove", () => {
    const fake = buildFakeSubscriber();
    const hub = createRunStreamHub(fake.client);

    const first = hub.addSubscriber("run-1", "org-A", () => {}, 2);
    const second = hub.addSubscriber("run-2", "org-A", () => {}, 2);
    const third = hub.addSubscriber("run-3", "org-A", () => {}, 2);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.reason).toBe("cap_exceeded");
    expect(hub.activeCount("org-A")).toBe(2);

    // A different org has its own budget.
    expect(hub.addSubscriber("run-9", "org-B", () => {}, 2).ok).toBe(true);

    // Freeing a slot lets the next connection in.
    if (first.ok) first.remove();
    expect(hub.activeCount("org-A")).toBe(1);
    expect(hub.addSubscriber("run-3", "org-A", () => {}, 2).ok).toBe(true);
  });

  it("closes subscribers and frees their slots when Redis subscribe fails", async () => {
    const fake = buildFakeSubscriber({ rejectSubscribe: true });
    const hub = createRunStreamHub(fake.client);
    const unavailable = vi.fn();

    const added = hub.addSubscriber("run-1", "org-A", () => {}, 1, unavailable);
    expect(added.ok).toBe(true);
    if (added.ok) await expect(added.ready).rejects.toThrow("subscribe failed");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(hub.activeCount("org-A")).toBe(0);
    expect(hub.addSubscriber("run-2", "org-A", () => {}, 1).ok).toBe(true);
    if (added.ok) added.remove(); // idempotent after the failure cleanup
  });

  it("a single client's write fault does not stop fan-out to peers", () => {
    const fake = buildFakeSubscriber();
    const hub = createRunStreamHub(fake.client);
    const received: PublishedRunEvent[] = [];
    hub.addSubscriber("run-1", "org-A", () => { throw new Error("boom"); }, 50);
    hub.addSubscriber("run-1", "org-A", (e) => received.push(e), 50);

    expect(() => fake.emit("run-1", "org-A", eventFor("evt-1"))).not.toThrow();
    expect(received).toHaveLength(1);
  });
});
