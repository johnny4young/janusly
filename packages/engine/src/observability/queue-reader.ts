/**
 * Bounded BullMQ readers for observability paths.
 *
 * Used by:
 * - `worker.ts` for asynchronous queue-depth gauges.
 * - `apps/api/src/queue-health.ts` for cached queue-age snapshots.
 *
 * The delivery queue intentionally retries Redis forever; scrape and health
 * paths must not inherit that behavior or an outage can accumulate pending
 * collections and delay shutdown.
 */

import { Queue } from "bullmq";
import { MAINTENANCE_QUEUE_NAME, WORKFLOW_QUEUE_NAME } from "../queue-names";

export const QUEUE_OBSERVABILITY_COMMAND_TIMEOUT_MS = 1_000;
export const QUEUE_OBSERVABILITY_READ_TIMEOUT_MS = 1_500;

type QueueCountClient = Pick<Queue, "getJobCounts" | "close">;
type QueueCountClientFactory = () => QueueCountClient;

/** Create a named queue client whose Redis operations fail in bounded time. */
export function createBoundedQueue(queueName: string): Queue {
  const queue = new Queue(queueName, {
    connection: {
      url: process.env.REDIS_URL ?? "redis://localhost:6379",
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: QUEUE_OBSERVABILITY_COMMAND_TIMEOUT_MS,
      commandTimeout: QUEUE_OBSERVABILITY_COMMAND_TIMEOUT_MS,
      lazyConnect: true,
      retryStrategy: (attempt) => Math.min(attempt * 100, 500),
    },
  });
  queue.on("error", () => undefined);
  return queue;
}

/** Create a bounded client for the customer workflow lane. */
export function createBoundedWorkflowQueue(): Queue {
  return createBoundedQueue(WORKFLOW_QUEUE_NAME);
}

/** Create a bounded client for the isolated maintenance lane. */
export function createBoundedMaintenanceQueue(): Queue {
  return createBoundedQueue(MAINTENANCE_QUEUE_NAME);
}

/** Bound a BullMQ observation independently of the Redis client's retries. */
export function withWorkflowQueueObservationTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Workflow queue observation timed out")),
      QUEUE_OBSERVABILITY_READ_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Close an observation client without allowing shutdown to hang or fail. */
export async function closeWorkflowQueueObservationClient(
  client: Pick<Queue, "close">,
): Promise<void> {
  try {
    await withWorkflowQueueObservationTimeout(Promise.resolve().then(() => client.close()));
  } catch {
    // Queue observations are best-effort; retirement must never block shutdown.
  }
}

/**
 * Own a bounded queue client and coalesce concurrent count scrapes. A failed
 * read is not cached; the next scrape can observe Redis recovery immediately.
 */
export function createQueueCountReader(
  createClient: QueueCountClientFactory,
  queueLabel: string,
): {
  getCounts: () => Promise<{ waiting: number; active: number }>;
  close: () => Promise<void>;
} {
  let client: QueueCountClient | null = null;
  let inFlight: Promise<{ waiting: number; active: number }> | null = null;
  let closed = false;

  const getCounts = () => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(async () => {
        if (closed) throw new Error(`${queueLabel} queue count reader is closed`);
        const current = client ?? createClient();
        client = current;
        try {
          const counts = await withWorkflowQueueObservationTimeout(
            current.getJobCounts("waiting", "active"),
          );
          return { waiting: counts.waiting ?? 0, active: counts.active ?? 0 };
        } catch (error) {
          if (client === current) client = null;
          void closeWorkflowQueueObservationClient(current);
          throw error;
        }
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    const current = client;
    client = null;
    if (current) await closeWorkflowQueueObservationClient(current);
  };

  return { getCounts, close };
}

/** Own a coalesced bounded count reader for workflow metrics. */
export function createWorkflowQueueCountReader(
  createClient: QueueCountClientFactory = createBoundedWorkflowQueue,
) {
  return createQueueCountReader(createClient, "Workflow");
}

/** Own a coalesced bounded count reader for maintenance metrics. */
export function createMaintenanceQueueCountReader(
  createClient: QueueCountClientFactory = createBoundedMaintenanceQueue,
) {
  return createQueueCountReader(createClient, "Maintenance");
}
