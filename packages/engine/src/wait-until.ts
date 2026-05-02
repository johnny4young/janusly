/**
 * `wait_until` node — pauses the run for a configurable ISO 8601 duration,
 * then resumes downstream automatically. A user-triggered `POST /resume`
 * short-circuits the wait; a cancelled run causes the wake-up to no-op.
 *
 * Async pause-and-resume mirrors the existing `webhook` / `approval`
 * machinery: the executor schedules a delayed BullMQ wake-up and returns
 * `{ status: "waiting" }`. The runtime persists `wakeAt` metadata on the
 * node and stops queueing downstream work. When the delay elapses, the
 * worker pulls the wake-up job, checks the node is still `waiting`, and
 * calls `resumeRun` — same path manual resume uses.
 *
 * Used by:
 * - `node-registry.ts` registers `wait_until: waitUntilExecutor`.
 * - `worker.ts` dispatches `job.name === "wait-resume"` to
 *   `handleWaitResume`.
 *
 * Invariants:
 * - Wake-up jobs are idempotent. The status check inside `handleWaitResume`
 *   guarantees that manual-resume-before-firing or run-cancel-before-firing
 *   leave the node alone.
 * - The duration must resolve to a strictly positive number of milliseconds.
 *   Zero or negative durations throw rather than wake immediately — a "wait
 *   0" workflow should use `noop` instead.
 * - Long delays (e.g. days, weeks) survive worker restarts because BullMQ
 *   persists delayed jobs in Redis. The node stays `waiting` across the
 *   restart and BullMQ delivers the job at its scheduled time.
 */

import type { NodeExecutor } from "./node-registry";
import { parseIsoDuration } from "./iso-duration";
import { enqueueWaitUntilResume } from "./queue";
import { getRunNodeStatus } from "./persistence";
import { resumeRun } from "./resume-run";

const WAIT_RESUME_STATUS_RETRY_DELAY_MS = 1_000;
const WAIT_RESUME_MAX_STATUS_RETRIES = 60;

/**
 * Translate a `wait_until` node's config into a strictly positive number of
 * milliseconds. Throws with a descriptive message on invalid input so the
 * runtime surfaces the failure on `node.failed` rather than silently
 * skipping the wait.
 */
export function resolveWaitUntilDelay(config: unknown): number {
  const duration = isPlainObject(config) && typeof config.duration === "string" ? config.duration : "";
  if (!duration) {
    throw new Error("wait_until.duration is required (ISO 8601 duration, e.g. \"P3D\")");
  }
  const delayMs = parseIsoDuration(duration);
  if (delayMs === null) {
    throw new Error(`wait_until.duration must be a valid ISO 8601 duration, got: ${duration}`);
  }
  if (delayMs <= 0) {
    throw new Error(`wait_until.duration must resolve to a positive number of milliseconds, got: ${delayMs}`);
  }
  return delayMs;
}

/** Executor for the `wait_until` node — schedules the wake-up and returns the waiting checkpoint. */
export const waitUntilExecutor: NodeExecutor = async (ctx) => {
  const delayMs = resolveWaitUntilDelay(ctx.config);
  const wakeAt = new Date(Date.now() + delayMs).toISOString();
  await enqueueWaitUntilResume(ctx.runId, ctx.nodeId, delayMs);
  return {
    status: "waiting",
    reason: "Waiting for absolute time",
    metadata: { wakeAt, durationMs: delayMs },
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
  const statusCheckAttempts = typeof data.statusCheckAttempts === "number" && Number.isFinite(data.statusCheckAttempts)
    ? Math.max(0, Math.floor(data.statusCheckAttempts))
    : 0;

  const status = await getRunNodeStatus(runId, nodeId);
  if ((status === "queued" || status === "running") && statusCheckAttempts < WAIT_RESUME_MAX_STATUS_RETRIES) {
    await enqueueWaitUntilResume(runId, nodeId, WAIT_RESUME_STATUS_RETRY_DELAY_MS, statusCheckAttempts + 1);
    return;
  }
  if (status !== "waiting") return; // already advanced — manual resume, cancellation, etc.

  await resumeRun(runId, nodeId);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
