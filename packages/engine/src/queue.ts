/**
 * BullMQ queue + ioredis connection for the engine worker.
 *
 * Owns the `workflow-nodes` queue and the singleton Redis connection used by
 * BullMQ. The connection is BullMQ-tuned (`maxRetriesPerRequest: null` —
 * BullMQ explicitly requires this to avoid premature giving-up inside the
 * queue's polling loop), which is why `apps/api/src/redis.ts` keeps a
 * separate request-path client with bounded retries.
 *
 * Used by:
 * - `packages/engine/src/worker.ts` — opens a `Worker` against `connection`.
 * - `packages/engine/src/adapters/bullmq-queue-adapter.ts` — composes
 *   `enqueueNode` into the runtime's queue contract (with the DLQ adapter
 *   wrapping it).
 *
 * Invariants:
 * - One process-wide Redis pool per engine process. Don't add a second
 *   ioredis client for ad-hoc commands; route through the adapters.
 * - `removeOnComplete: 1000` keeps the most recent thousand successful jobs
 *   for debugging while bounding memory.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { loadRootEnv } from "@janusly/db";
import type { EnqueueNodeInput } from "./core/types";

loadRootEnv();

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("Missing REDIS_URL. Add it to .env or .env.example.");
}

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const workflowQueue = new Queue("workflow-nodes", {
  connection,
});

export async function enqueueNode(payload: EnqueueNodeInput) {
  return workflowQueue.add("execute-node", payload, {
    attempts: 1,
    delay: payload.delayMs ?? 0,
    removeOnComplete: 1000,
  });
}

/**
 * Enqueue a delayed wake-up job that resumes a paused node after `delayMs`.
 * Pushed onto the same `workflow-nodes` queue as regular execution jobs but
 * with a distinct BullMQ job name (`wait-resume`); the worker switches on
 * `job.name` to dispatch.
 *
 * The handler at the receiving end is idempotent — if the node has been
 * manually resumed or cancelled before the delay elapses, the wake-up call
 * is a no-op. This guards the (rare) double-resume race when a user calls
 * `POST /resume` while the delayed job is already in flight.
 */
export async function enqueueWaitUntilResume(runId: string, nodeId: string, delayMs: number, statusCheckAttempts = 0) {
  return workflowQueue.add(
    "wait-resume",
    { runId, nodeId, statusCheckAttempts },
    {
      attempts: 1,
      delay: Math.max(0, delayMs),
      removeOnComplete: 1000,
    },
  );
}
