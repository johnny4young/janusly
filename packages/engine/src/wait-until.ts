/**
 * `wait_until` node — pauses the run for an ISO 8601 duration or absolute
 * ISO date-time, then resumes downstream automatically. A user-triggered
 * `POST /resume` short-circuits the wait; cancellation makes wake-up a no-op.
 *
 * Async pause-and-resume mirrors the existing `webhook` / `approval`
 * machinery: the executor schedules a delayed BullMQ wake-up and returns
 * `{ status: "waiting" }`. The runtime persists `wakeAt` metadata on the
 * node and stops queueing downstream work. When the delay elapses, the
 * worker pulls the wake-up job, checks the node is still `waiting`, and
 * calls `resumeRun` — same path manual resume uses.
 *
 * Used by:
 * - `node-executors/delegated.ts` registers `wait_until: waitUntilExecutor`.
 * - `worker.ts` dispatches `job.name === "wait-resume"` to
 *   `handleWaitResume`.
 *
 * Invariants:
 * - Wake-up jobs are idempotent. The status check inside `handleWaitResume`
 *   guarantees that manual-resume-before-firing or run-cancel-before-firing
 *   leave the node alone.
 * - Relative durations must resolve to a strictly positive number of
 *   milliseconds. A past absolute instant resumes immediately instead of
 *   making a previously valid saved workflow fail at run time.
 * - Long delays (e.g. days, weeks) survive worker restarts because BullMQ
 *   persists delayed jobs in Redis. The node stays `waiting` across the
 *   restart and BullMQ delivers the job at its scheduled time.
 */

import type { NodeExecutor } from "./node-executors/types";
import { enqueueWaitUntilResume } from "./queue";
import { getRunNodeStatus } from "./persistence";
import { resumeRun } from "./resume-run";
import { resolveWaitUntilSchedule } from "./waiting-time";

const WAIT_RESUME_STATUS_RETRY_DELAY_MS = 1_000;

/**
 * Translate a `wait_until` node's config into a strictly positive number of
 * milliseconds. Throws with a descriptive message on invalid input so the
 * runtime surfaces the failure on `node.failed` rather than silently
 * skipping the wait.
 */
export function resolveWaitUntilDelay(config: unknown, nowMs = Date.now()): number {
  return resolveWaitUntilSchedule(config, nowMs).delayMs;
}

/** Executor for the `wait_until` node — schedules the wake-up and returns the waiting checkpoint. */
export const waitUntilExecutor: NodeExecutor<"wait_until"> = async (ctx) => {
  const schedule = resolveWaitUntilSchedule(ctx.config);
  await enqueueWaitUntilResume(ctx.runId, ctx.nodeId, schedule.delayMs);
  return {
    status: "waiting",
    reason: "Waiting for scheduled time",
    metadata: {
      kind: "timer",
      wakeAt: schedule.wakeAt,
      durationMs: schedule.delayMs,
      source: schedule.source,
    },
  };
};

/**
 * Handle a delayed wake-up job. Verifies the node is still in `waiting`
 * status before resuming — manual `POST /resume` or run cancellation may
 * have advanced the node past `waiting`, in which case this fire is a
 * no-op (idempotency guard).
 */
export async function handleWaitResume(data: unknown): Promise<void> {
  if (!isPlainObject(data)) return;
  const { runId, nodeId } = data;
  if (typeof runId !== "string" || typeof nodeId !== "string") return;
  if (runId.length === 0 || nodeId.length === 0) return;
  const status = await getRunNodeStatus(runId, nodeId);
  if (status === "queued" || status === "running") {
    await enqueueWaitUntilResume(runId, nodeId, WAIT_RESUME_STATUS_RETRY_DELAY_MS);
    return;
  }
  if (status !== "waiting") return; // already advanced — manual resume, cancellation, etc.

  await resumeRun(runId, nodeId);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
