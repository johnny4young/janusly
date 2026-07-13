/**
 * Live-run SSE fan-out hub (subscriber side) + publisher registration for the
 * API process.
 *
 * The engine persists every run lifecycle signal to Postgres and also pushes
 * it through the `setRunEventPublisher` seam. This module owns BOTH ends of
 * the Redis pub/sub bridge for the API:
 *
 * - **Publisher** (`registerRunEventPublisher`): wires the seam to a Redis
 *   PUBLISH on the shared request-path client, via the engine's
 *   `createRedisRunEventPublisher` factory (so channel name + message shape
 *   stay identical to the worker's publisher and to the subscriber below).
 * - **Subscriber hub** (`getRunStreamHub`): one dedicated ioredis connection
 *   (subscriber mode is exclusive — it can't share the request-path client),
 *   refcounted per-run channel SUBSCRIBE, in-process fan-out to every open
 *   SSE response for that run, and a per-org connection cap.
 *
 * Used by:
 * - `apps/api/src/index.ts` — boot: `registerRunEventPublisher()`.
 * - `apps/api/src/routes/runs-routes.ts` — the `GET /runs/:runId/stream` route
 *   adds/removes subscribers.
 *
 * Org isolation (defense in depth): the channel is keyed by `runId` and a run
 * belongs to exactly one org, so a cross-org subscriber is structurally
 * impossible. On top of that the route gates on `run.orgId === auth.orgId`
 * before subscribing, AND every published message carries `orgId` which the
 * hub re-checks against the subscriber's org before writing the frame.
 *
 * Invariants:
 * - The subscriber cap is **per API replica** by design: SSE connections are
 *   pinned to one replica, so the in-process counter is exactly what protects
 *   that process's socket/memory budget. No Redis counter (which would leak
 *   on crash with no natural TTL for a long-lived connection). Capacity-planning
 *   note for operators: the effective CLUSTER-WIDE ceiling is therefore
 *   replica_count × `runs.streamMaxSubscriptions`, not the per-org config value
 *   alone — size the config with the replica count in mind.
 * - Publish is fire-and-forget and never throws — streaming is best-effort.
 */

import IORedis from "ioredis";

import { getRunMetadata } from "@janusly/engine/src/persistence";
import {
  createRedisRunEventPublisher,
  runIdFromRunEventChannel,
  runEventChannel,
  setRunEventPublisher,
  type PublishedRunEvent,
  type RunEventChannelMessage,
} from "@janusly/engine/src/run-event-stream";

import { redis } from "./redis";

/** A connected SSE client's delivery callback. The hub calls it per signal. */
type StreamWriter = (event: PublishedRunEvent) => void;

type Subscriber = { orgId: string; write: StreamWriter; onUnavailable?: () => void; removed: boolean };

/** Outcome of an `addSubscriber` attempt. */
export type AddSubscriberResult =
  | { ok: true; ready: Promise<void>; remove: () => void }
  | { ok: false; reason: "cap_exceeded" };

/**
 * Minimal ioredis subscriber-mode surface the hub depends on. Tests inject a
 * fake that also exposes an `emit(channel, message)` to drive the handler.
 */
export type SubscriberClient = {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
};

/**
 * Return the API process's dedicated Redis subscriber connection.
 *
 * The run-event hub owns the connection lifecycle. Other API-only pub/sub
 * consumers can attach a channel listener here rather than opening another
 * subscriber connection per replica.
 */
export function getRunStreamSubscriber(): IORedis {
  getRunStreamHub();
  if (!subscriberConn) throw new Error("Run stream subscriber was not initialized");
  return subscriberConn;
}

export type RunStreamHub = {
  /**
   * Attach a client to a run's stream. Refcounts the Redis SUBSCRIBE and
   * enforces the per-org cap. `ready` resolves only after Redis acknowledges
   * the channel subscription; callers must await it before taking a database
   * catch-up snapshot. Returns a `remove()` the caller invokes on disconnect
   * (idempotent).
   */
  addSubscriber(runId: string, orgId: string, write: StreamWriter, cap: number, onUnavailable?: () => void): AddSubscriberResult;
  /** Current open-connection count for an org (for tests / observability). */
  activeCount(orgId: string): number;
};

/**
 * Build a hub over a subscriber connection. Exposed for tests; production uses
 * the lazily-created singleton from `getRunStreamHub`.
 */
export function createRunStreamHub(subscriber: SubscriberClient): RunStreamHub {
  const byRun = new Map<string, Set<Subscriber>>();
  const readyByRun = new Map<string, Promise<void>>();
  const orgCounts = new Map<string, number>();

  subscriber.on("message", (channel, message) => {
    const runId = runIdFromRunEventChannel(channel);
    if (!runId) return;
    const set = byRun.get(runId);
    if (!set || set.size === 0) return;
    let parsed: RunEventChannelMessage;
    try {
      parsed = JSON.parse(message) as RunEventChannelMessage;
    } catch {
      return;
    }
    if (!parsed || typeof parsed.orgId !== "string" || !parsed.event) return;
    for (const sub of set) {
      // Defense in depth: drop any message whose org doesn't match the
      // subscriber's, even though per-run channels make this unreachable.
      if (sub.orgId !== parsed.orgId) continue;
      try {
        sub.write(parsed.event);
      } catch {
        // A single client's write fault never stops fan-out to its peers.
      }
    }
  });

  function bumpOrg(orgId: string, delta: number): void {
    const next = (orgCounts.get(orgId) ?? 0) + delta;
    if (next <= 0) orgCounts.delete(orgId);
    else orgCounts.set(orgId, next);
  }

  function dropRunSubscribers(runId: string, expectedSet: Set<Subscriber>): void {
    const current = byRun.get(runId);
    if (current !== expectedSet) return;
    byRun.delete(runId);
    readyByRun.delete(runId);
    for (const sub of current) {
      if (sub.removed) continue;
      sub.removed = true;
      bumpOrg(sub.orgId, -1);
      try {
        sub.onUnavailable?.();
      } catch {
        // A cleanup fault for one client must not leak the remaining slots.
      }
    }
  }

  return {
    addSubscriber(runId, orgId, write, cap, onUnavailable) {
      if ((orgCounts.get(orgId) ?? 0) >= cap) {
        return { ok: false, reason: "cap_exceeded" };
      }
      let set = byRun.get(runId);
      if (!set) {
        set = new Set();
        byRun.set(runId, set);
        const subscribedSet = set;
        // First subscriber for this run — open the channel. A SUBSCRIBE fault
        // must close the affected SSE clients so the browser falls back to
        // polling; leaving a heartbeat-only stream open would suppress the
        // poll loop while no live events can arrive.
        const ready = Promise.resolve(subscriber.subscribe(runEventChannel(runId)))
          .then(() => undefined)
          .catch((err) => {
            console.warn("[run-stream] subscribe failed", { runId, err });
            dropRunSubscribers(runId, subscribedSet);
            throw err;
          });
        // The route awaits this promise. Keep an internal rejection handler as
        // well so an early client disconnect cannot turn a subscribe failure
        // into an unhandled process-level rejection.
        void ready.catch(() => {});
        readyByRun.set(runId, ready);
      }
      const sub: Subscriber = { orgId, write, removed: false };
      if (onUnavailable) sub.onUnavailable = onUnavailable;
      set.add(sub);
      bumpOrg(orgId, 1);

      let removed = false;
      const remove = () => {
        if (removed || sub.removed) return;
        removed = true;
        sub.removed = true;
        const current = byRun.get(runId);
        if (current) {
          current.delete(sub);
          if (current.size === 0) {
            byRun.delete(runId);
            readyByRun.delete(runId);
            void Promise.resolve(subscriber.unsubscribe(runEventChannel(runId))).catch((err) => {
              console.warn("[run-stream] unsubscribe failed", { runId, err });
            });
          }
        }
        bumpOrg(orgId, -1);
      };
      return { ok: true, ready: readyByRun.get(runId) ?? Promise.resolve(), remove };
    },
    activeCount(orgId) {
      return orgCounts.get(orgId) ?? 0;
    },
  };
}

let hubSingleton: RunStreamHub | null = null;
let subscriberConn: IORedis | null = null;

/**
 * The process-wide hub, backed by a dedicated ioredis subscriber connection
 * created on first use (so processes that never stream pay nothing).
 */
export function getRunStreamHub(): RunStreamHub {
  if (hubSingleton) return hubSingleton;
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  subscriberConn = new IORedis(redisUrl, {
    maxRetriesPerRequest: null, // subscriber connections block; don't bound retries
    enableReadyCheck: true,
    lazyConnect: false,
  });
  // Redis pub/sub is best-effort. An outage falls back to each cache's TTL,
  // so a connection error must not become an unhandled process-level event.
  subscriberConn.on("error", () => {});
  hubSingleton = createRunStreamHub(subscriberConn);
  return hubSingleton;
}

/** Close the dedicated subscriber connection during graceful shutdown. */
export async function closeRunStreamHub(): Promise<void> {
  const conn = subscriberConn;
  subscriberConn = null;
  hubSingleton = null;
  if (!conn) return;
  try {
    await conn.quit();
  } catch {
    // The stream and cache subscribers are both best-effort. A disconnected
    // Redis server must not turn an otherwise graceful API shutdown into a
    // failed process exit.
    conn.disconnect();
  }
}

/** Wire the engine's run-event seam to a Redis PUBLISH. Call once at boot. */
export function registerRunEventPublisher(): void {
  setRunEventPublisher(
    createRedisRunEventPublisher({
      publish: (channel, message) => redis.publish(channel, message),
      resolveOrgId: (runId) => getRunMetadata(runId).then((meta) => meta?.orgId ?? null),
    }),
  );
}
