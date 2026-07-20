/**
 * Bounded workflow-queue health projection for request-path observability.
 *
 * Used by:
 * - `routes/health-routes.ts` for the coarse public signal and admin details.
 * - `index.ts` to close the lazy BullMQ connection during shutdown.
 *
 * Invariants:
 * - Never reuse the worker's BullMQ connection here: its
 *   `maxRetriesPerRequest: null` can pin a readiness request indefinitely.
 * - Public callers receive only `{ degraded }`; live counts stay admin-only.
 * - Redis failures resolve to `null` and are cached briefly so `/health`
 *   remains fail-open without hammering a sick dependency.
 */

import {
  closeWorkflowQueueObservationClient,
  createBoundedWorkflowQueue,
  withWorkflowQueueObservationTimeout,
} from "@janusly/engine/src/observability/queue-reader";
import type { Job, Queue } from "bullmq";

export const QUEUE_HEALTH_CACHE_MS = 5_000;
export const QUEUE_LAG_WARN_SECONDS_DEFAULT = 60;

const QUEUE_LAG_WARN_SECONDS_MAX = 86_400;

export type QueueHealthSnapshot = {
  waiting: number;
  active: number;
  oldestWaitingSeconds: number | null;
  warnSeconds: number;
};

export type PublicQueueHealth = { degraded: boolean };

export type QueueHealthSource = {
  getCounts: () => Promise<{ waiting: number; active: number }>;
  getOldestWaitingTimestamp: () => Promise<number | null>;
};

type WaitingJobTiming = {
  timestamp?: number;
  processedOn?: number | null;
  opts?: { delay?: number };
};

type CacheOptions = {
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
};

type QueueHealthClient = Pick<Queue, "getJobCounts" | "getJobs" | "close">;
type QueueHealthClientFactory = () => QueueHealthClient;

/** Resolve the server-owned queue-lag threshold from its closed range. */
export function resolveQueueLagWarnSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return QUEUE_LAG_WARN_SECONDS_DEFAULT;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= QUEUE_LAG_WARN_SECONDS_MAX
    ? parsed
    : QUEUE_LAG_WARN_SECONDS_DEFAULT;
}

function assertCount(value: number, field: "waiting" | "active"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid workflow queue ${field} count`);
  }
  return value;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Derive when a waiting job first became eligible. BullMQ keeps `timestamp`
 * at creation time even after promoting a delayed job, while the original
 * delay remains in `opts`. Previously processed work can return through retry
 * or stalled recovery, but neither path retains its exact waiting transition;
 * its age therefore stays unknown instead of using the earlier attempt start.
 */
export function getWaitingEligibleTimestamp(job: WaitingJobTiming | null): number | null {
  if (!job || !isTimestamp(job.timestamp)) return null;
  const delay = isTimestamp(job.opts?.delay) ? job.opts.delay : 0;
  const firstEligibleAt = job.timestamp + delay;
  if (!isTimestamp(job.processedOn)) return firstEligibleAt;
  return null;
}

/** Read and validate one queue snapshot from an injected source. */
export async function readQueueHealthSnapshot(
  source: QueueHealthSource,
  options: { now?: () => number; warnSeconds?: number } = {},
): Promise<QueueHealthSnapshot> {
  const now = options.now ?? Date.now;
  const warnSeconds = options.warnSeconds ?? resolveQueueLagWarnSeconds(
    process.env.JANUSLY_QUEUE_LAG_WARN_SECONDS,
  );
  if (!Number.isSafeInteger(warnSeconds) || warnSeconds < 1) {
    throw new Error("Invalid workflow queue warning threshold");
  }

  const counts = await source.getCounts();
  const waiting = assertCount(counts.waiting, "waiting");
  const active = assertCount(counts.active, "active");
  const oldestTimestamp = waiting > 0
    ? await source.getOldestWaitingTimestamp()
    : null;
  const oldestWaitingSeconds = typeof oldestTimestamp === "number"
    && Number.isFinite(oldestTimestamp)
    && oldestTimestamp >= 0
    ? Math.max(0, Math.floor((now() - oldestTimestamp) / 1_000))
    : null;

  return { waiting, active, oldestWaitingSeconds, warnSeconds };
}

/** Truncate an admin snapshot to the unauthenticated public-safe shape. */
export function toPublicQueueHealth(
  snapshot: QueueHealthSnapshot | null,
): PublicQueueHealth | null {
  if (!snapshot) return null;
  return {
    degraded: snapshot.oldestWaitingSeconds !== null
      && snapshot.oldestWaitingSeconds > snapshot.warnSeconds,
  };
}

/**
 * Create a coalescing TTL cache. Both successful and failed reads are cached;
 * concurrent callers share one in-flight probe.
 */
export function createQueueHealthCache(
  load: () => Promise<QueueHealthSnapshot>,
  options: CacheOptions = {},
): { get: () => Promise<QueueHealthSnapshot | null>; clear: () => void } {
  const ttlMs = options.ttlMs ?? QUEUE_HEALTH_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { value: QueueHealthSnapshot | null; expiresAt: number } | null = null;
  let inFlight: Promise<QueueHealthSnapshot | null> | null = null;

  const clear = () => {
    cached = null;
    inFlight = null;
  };

  const get = async (): Promise<QueueHealthSnapshot | null> => {
    if (cached && cached.expiresAt > now()) return cached.value;
    if (inFlight) return inFlight;

    inFlight = load()
      .catch((error) => {
        options.onError?.(error);
        return null;
      })
      .then((value) => {
        cached = { value, expiresAt: now() + ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return { get, clear };
}

/**
 * Own a recoverable request-path Queue. BullMQ memoizes its first lazy Redis
 * initialization promise, so a failed connection must retire the whole Queue;
 * retrying commands on that same instance cannot observe Redis recovery.
 */
export function createQueueHealthSource(
  createClient: QueueHealthClientFactory = createBoundedWorkflowQueue,
): { source: QueueHealthSource; close: () => Promise<void> } {
  let queue: QueueHealthClient | null = null;
  let closed = false;

  const read = async <T>(operation: (current: QueueHealthClient) => Promise<T>): Promise<T> => {
    if (closed) throw new Error("Workflow queue health source is closed");
    const current = queue ?? createClient();
    queue = current;
    try {
      return await withWorkflowQueueObservationTimeout(
        Promise.resolve().then(() => operation(current)),
      );
    } catch (error) {
      if (queue === current) queue = null;
      void closeWorkflowQueueObservationClient(current);
      throw error;
    }
  };

  const source: QueueHealthSource = {
    getCounts: async () => {
      const counts = await read((current) => current.getJobCounts("waiting", "active"));
      return { waiting: counts.waiting, active: counts.active };
    },
    getOldestWaitingTimestamp: async () => {
      const [job] = await read((current) => current.getJobs(["waiting"], 0, 0, true));
      return getWaitingEligibleTimestamp((job as Job | undefined) ?? null);
    },
  };

  return {
    source,
    close: async () => {
      if (closed) return;
      closed = true;
      const current = queue;
      queue = null;
      if (current) await closeWorkflowQueueObservationClient(current);
    },
  };
}

const queueHealthReader = createQueueHealthSource();

const cache = createQueueHealthCache(
  () => readQueueHealthSnapshot(queueHealthReader.source),
  {
    onError: () => {
      console.warn("[queue-health] Redis unavailable; health remains fail-open");
    },
  },
);

/** Return the cached admin queue snapshot, or null while Redis is unavailable. */
export function getQueueHealthSnapshot(): Promise<QueueHealthSnapshot | null> {
  return cache.get();
}

/** Return the cached unauthenticated public-safe queue signal. */
export async function getPublicQueueHealth(): Promise<PublicQueueHealth | null> {
  return toPublicQueueHealth(await cache.get());
}

/** Close the lazy request-path queue connection during API shutdown. */
export async function closeQueueHealth(): Promise<void> {
  cache.clear();
  await queueHealthReader.close();
}
