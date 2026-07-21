/**
 * Bounded workflow and maintenance queue health for request observability.
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
  createBoundedMaintenanceQueue,
  createBoundedWorkflowQueue,
  withWorkflowQueueObservationTimeout,
} from "@janusly/engine/src/observability/queue-reader";
import type { Job, Queue } from "bullmq";

export const QUEUE_HEALTH_CACHE_MS = 5_000;
export const QUEUE_LAG_WARN_SECONDS_DEFAULT = 60;
export const MAINTENANCE_QUEUE_LAG_WARN_SECONDS_DEFAULT = 300;

const QUEUE_LAG_WARN_SECONDS_MAX = 86_400;

export type QueueHealthSnapshot = {
  waiting: number;
  active: number;
  oldestWaitingSeconds: number | null;
  warnSeconds: number;
};

/** Additive admin shape: legacy top-level fields remain the workflow queue. */
export type QueueHealthOverview = QueueHealthSnapshot & {
  maintenance: QueueHealthSnapshot | null;
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

export function resolveMaintenanceQueueLagWarnSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return MAINTENANCE_QUEUE_LAG_WARN_SECONDS_DEFAULT;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= QUEUE_LAG_WARN_SECONDS_MAX
    ? parsed
    : MAINTENANCE_QUEUE_LAG_WARN_SECONDS_DEFAULT;
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
  snapshot: QueueHealthSnapshot | QueueHealthOverview | null,
): PublicQueueHealth | null {
  if (!snapshot) return null;
  const maintenance = "maintenance" in snapshot ? snapshot.maintenance : null;
  return {
    degraded: isQueueDegraded(snapshot)
      || (maintenance !== null && isQueueDegraded(maintenance)),
  };
}

function isQueueDegraded(snapshot: QueueHealthSnapshot): boolean {
  return snapshot.oldestWaitingSeconds !== null
    && snapshot.oldestWaitingSeconds > snapshot.warnSeconds;
}

/**
 * Create a coalescing TTL cache. Both successful and failed reads are cached;
 * concurrent callers share one in-flight probe.
 */
export function createQueueHealthCache<T>(
  load: () => Promise<T>,
  options: CacheOptions = {},
): { get: () => Promise<T | null>; clear: () => void } {
  const ttlMs = options.ttlMs ?? QUEUE_HEALTH_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { value: T | null; expiresAt: number } | null = null;
  let inFlight: Promise<T | null> | null = null;

  const clear = () => {
    cached = null;
    inFlight = null;
  };

  const get = async (): Promise<T | null> => {
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
  queueLabel = "Workflow",
): { source: QueueHealthSource; close: () => Promise<void> } {
  let queue: QueueHealthClient | null = null;
  let closed = false;

  const read = async <T>(operation: (current: QueueHealthClient) => Promise<T>): Promise<T> => {
    if (closed) throw new Error(`${queueLabel} queue health source is closed`);
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
const maintenanceQueueHealthReader = createQueueHealthSource(
  createBoundedMaintenanceQueue,
  "Maintenance",
);

const workflowCache = createQueueHealthCache(
  () => readQueueHealthSnapshot(queueHealthReader.source),
  {
    onError: () => {
      console.warn("[queue-health] Redis unavailable; health remains fail-open");
    },
  },
);
const maintenanceCache = createQueueHealthCache(
  () => readQueueHealthSnapshot(maintenanceQueueHealthReader.source, {
    warnSeconds: resolveMaintenanceQueueLagWarnSeconds(
      process.env.JANUSLY_MAINTENANCE_QUEUE_LAG_WARN_SECONDS,
    ),
  }),
  {
    onError: () => {
      console.warn("[queue-health] maintenance Redis read unavailable; health remains fail-open");
    },
  },
);

/** Return workflow details plus an additive independent maintenance snapshot. */
export async function getQueueHealthSnapshot(): Promise<QueueHealthOverview | null> {
  const [workflow, maintenance] = await Promise.all([
    workflowCache.get(),
    maintenanceCache.get(),
  ]);
  if (!workflow) return null;
  return { ...workflow, maintenance };
}

/** Return the cached unauthenticated public-safe queue signal. */
export async function getPublicQueueHealth(): Promise<PublicQueueHealth | null> {
  return toPublicQueueHealth(await getQueueHealthSnapshot());
}

/** Close the lazy request-path queue connection during API shutdown. */
export async function closeQueueHealth(): Promise<void> {
  workflowCache.clear();
  maintenanceCache.clear();
  await Promise.all([
    queueHealthReader.close(),
    maintenanceQueueHealthReader.close(),
  ]);
}
