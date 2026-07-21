/**
 * BullMQ queue + ioredis connection for the engine worker.
 *
 * Owns the customer-facing `workflow-nodes` queue, the isolated
 * `maintenance-jobs` queue, and the singleton Redis connection used by
 * their BullMQ producers. The connection is BullMQ-tuned (`maxRetriesPerRequest: null` —
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
 * - One process-wide BullMQ Redis pool per engine process. Queue isolation is
 *   provided by separate BullMQ queue names and Workers, not extra producer
 *   sockets. Do not reuse this
 *   connection for request-path/ad-hoc commands; those need bounded retry
 *   clients such as `rate-limit-redis.ts`.
 * - `removeOnComplete: 1000` keeps the most recent thousand successful jobs
 *   for debugging while bounding memory.
 * - `removeOnFail` is bounded too (count + age): the durable failure record
 *   is Postgres `dead_letters`, not Redis — without a bound, BullMQ keeps
 *   failed jobs forever, so a poisoned producer or schema drift would grow
 *   Redis unboundedly.
 * - `execute-node` job payloads are SLIM (`{ runId, nodeId, attempt,
 *   publicationGeneration, recoveryClaimToken? }`) — the
 *   worker reloads the workflow from `runs.inputJson` per job rather than
 *   carrying the full workflow JSON in every Redis message.
 */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { loadRootEnv } from "@janusly/db";
import type { EnqueueNodeInput } from "./core/types";
import { buildExecuteNodeJobId, buildReplayCampaignJobId } from "./queue-job-id";
import { MAINTENANCE_QUEUE_NAME, WORKFLOW_QUEUE_NAME } from "./queue-names";

export { MAINTENANCE_QUEUE_NAME, WORKFLOW_QUEUE_NAME } from "./queue-names";

loadRootEnv();

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("Missing REDIS_URL. Add it to .env or .env.example.");
}

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const workflowQueue = new Queue(WORKFLOW_QUEUE_NAME, {
  connection,
});

/** Producers for retention, reconciliation, calibration, and health jobs. */
export const maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, {
  connection,
});

/** Redis retention for failed jobs — Postgres `dead_letters` is the durable record. */
const REMOVE_ON_FAIL = { count: 1000, age: 7 * 24 * 60 * 60 };

export async function enqueueNode(payload: EnqueueNodeInput) {
  return workflowQueue.add(
    "execute-node",
    {
      runId: payload.runId,
      nodeId: payload.nodeId,
      attempt: payload.attempt,
      publicationGeneration: payload.publicationGeneration ?? 0,
      ...(payload.recoveryClaimToken ? { recoveryClaimToken: payload.recoveryClaimToken } : {}),
    },
    {
      attempts: 1,
      delay: payload.delayMs ?? 0,
      jobId: buildExecuteNodeJobId(payload),
      removeOnComplete: 1000,
      removeOnFail: REMOVE_ON_FAIL,
    },
  );
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
export async function enqueueWaitUntilResume(runId: string, nodeId: string, delayMs: number) {
  return workflowQueue.add(
    "wait-resume",
    { runId, nodeId },
    {
      attempts: 20,
      backoff: { type: "exponential", delay: 1_000 },
      delay: Math.max(0, delayMs),
      removeOnComplete: 1000,
      removeOnFail: REMOVE_ON_FAIL,
    },
  );
}

/** Install the pre-checkpoint watcher that arms an approval's exact deadline. */
export async function enqueueApprovalDeadlineArm(runId: string, nodeId: string, delayMs: number) {
  return workflowQueue.add(
    "approval-deadline-arm",
    { runId, nodeId },
    {
      attempts: 20,
      backoff: { type: "exponential", delay: 1_000 },
      delay: Math.max(0, delayMs),
      removeOnComplete: 1000,
      removeOnFail: REMOVE_ON_FAIL,
    },
  );
}

/** Schedule a policy decision for one exact approval-deadline generation. */
export async function enqueueApprovalTimeout(
  runId: string,
  nodeId: string,
  deadlineAt: string,
  delayMs: number,
) {
  return workflowQueue.add(
    "approval-timeout",
    { runId, nodeId, deadlineAt },
    {
      // Handler failures are infrastructure failures, not policy outcomes.
      // Exponential retry keeps the persisted Redis job durable through a
      // prolonged Postgres/Redis recovery window without hot-looping.
      attempts: 20,
      backoff: { type: "exponential", delay: 1_000 },
      delay: Math.max(0, delayMs),
      removeOnComplete: 1000,
      removeOnFail: REMOVE_ON_FAIL,
    },
  );
}

/**
 * Publish one paced replay-campaign step. The due timestamp is part of the
 * BullMQ id so API publication and the Postgres reconciler converge on the
 * same delivery; the database dispatch lease still prevents parallel drains.
 */
export async function enqueueReplayCampaignStep(
  campaignId: string,
  dueAt: Date,
): Promise<void> {
  await workflowQueue.add(
    "replay-campaign-step",
    { campaignId },
    {
      attempts: 20,
      backoff: { type: "exponential", delay: 1_000 },
      delay: Math.max(0, dueAt.getTime() - Date.now()),
      jobId: buildReplayCampaignJobId(campaignId, dueAt),
      removeOnComplete: 1000,
      removeOnFail: REMOVE_ON_FAIL,
    },
  );
}
