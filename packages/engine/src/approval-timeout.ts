/**
 * Delayed approval policy execution.
 *
 * The executor records ownership/deadline metadata and schedules one BullMQ
 * job. The handler then applies the policy only if the node still waits on the
 * same persisted deadline generation. Manual resume, cancellation, replay, or
 * duplicate delivery therefore wins cleanly instead of being overwritten.
 */

import type { NodeExecutor } from "./node-registry";
import {
  escalateWaitingApprovalNode,
  failWaitingApprovalNode,
  getRunNodeWaitingSnapshot,
} from "./persistence";
import { enqueueApprovalDeadlineArm, enqueueApprovalTimeout } from "./queue";
import {
  parseAbsoluteInstant,
  resolveApprovalWaitingConfig,
  type ApprovalTimeoutPolicy,
} from "./waiting-time";

const STATUS_RETRY_DELAY_MS = 1_000;

/** Approval executor — preserves legacy indefinite waits when no deadline exists. */
export const approvalExecutor: NodeExecutor<"approval"> = async (ctx) => {
  const title = typeof ctx.config.title === "string" && ctx.config.title.trim()
    ? ctx.config.title.trim()
    : typeof ctx.config.message === "string" && ctx.config.message.trim()
      ? ctx.config.message.trim()
      : undefined;
  const description = typeof ctx.config.description === "string" && ctx.config.description.trim()
    ? ctx.config.description.trim()
    : undefined;
  const resolvedWaiting = resolveApprovalWaitingConfig(ctx.config);
  let waiting: typeof resolvedWaiting = resolvedWaiting;

  if (resolvedWaiting.deadlineAt) {
    // Install a durable watcher before the checkpoint is committed. Relative
    // deadlines are materialized by the runtime from the checkpoint clock,
    // after this Redis write succeeds, so queue latency never consumes the
    // operator's decision window.
    await enqueueApprovalDeadlineArm(ctx.runId, ctx.nodeId, 0);
    if (typeof ctx.config.decisionTimeoutMs === "number") {
      const { deadlineAt: _deadlineAt, delayMs, ...rest } = resolvedWaiting;
      waiting = { ...rest, decisionTimeoutMs: delayMs };
    }
  }

  return {
    status: "waiting",
    reason: "Waiting for human approval",
    metadata: {
      kind: "approval",
      title,
      description,
      resumeToken: `${ctx.runId}:${ctx.nodeId}`,
      ...waiting,
    },
  };
};

/** Arm the exact delayed policy job after the approval checkpoint exists. */
export async function handleApprovalDeadlineArm(data: unknown): Promise<void> {
  if (!isPlainObject(data)) return;
  const { runId, nodeId } = data;
  if (typeof runId !== "string" || !runId || typeof nodeId !== "string" || !nodeId) return;
  const snapshot = await getRunNodeWaitingSnapshot(runId, nodeId);
  if (snapshot?.status === "queued" || snapshot?.status === "running") {
    await enqueueApprovalDeadlineArm(runId, nodeId, STATUS_RETRY_DELAY_MS);
    return;
  }
  if (snapshot?.status !== "waiting" || snapshot.waiting?.kind !== "approval") return;
  if (snapshot.waiting.timeoutState !== undefined) return;
  const deadlineAt = typeof snapshot.waiting.deadlineAt === "string"
    ? snapshot.waiting.deadlineAt
    : "";
  const deadlineMs = parseAbsoluteInstant(deadlineAt);
  if (deadlineMs === null) return;
  await enqueueApprovalTimeout(runId, nodeId, deadlineAt, Math.max(0, deadlineMs - Date.now()));
}

/** Apply a delayed approval policy once its exact persisted deadline is due. */
export async function handleApprovalTimeout(data: unknown): Promise<void> {
  if (!isPlainObject(data)) return;
  const { runId, nodeId, deadlineAt } = data;
  if (typeof runId !== "string" || !runId || typeof nodeId !== "string" || !nodeId) return;
  if (typeof deadlineAt !== "string" || parseAbsoluteInstant(deadlineAt) === null) return;
  const snapshot = await getRunNodeWaitingSnapshot(runId, nodeId);
  if (snapshot?.status === "queued" || snapshot?.status === "running") {
    // The job is deliberately installed before the waiting checkpoint so a
    // process crash cannot commit an unsupervised deadline. Keep bridging
    // until the node leaves execution; the stalled-node reaper eventually
    // terminates a worker-crash row, so this cannot become an immortal loop.
    await enqueueApprovalTimeout(runId, nodeId, deadlineAt, STATUS_RETRY_DELAY_MS);
    return;
  }
  if (snapshot?.status !== "waiting" || snapshot.waiting?.kind !== "approval") return;
  if (snapshot.waiting.deadlineAt !== deadlineAt || snapshot.waiting.timeoutState !== undefined) return;

  const persistedDeadlineMs = parseAbsoluteInstant(snapshot.waiting.deadlineAt);
  if (persistedDeadlineMs === null) return;
  const remainingMs = persistedDeadlineMs - Date.now();
  if (remainingMs > 0) {
    await enqueueApprovalTimeout(runId, nodeId, deadlineAt, remainingMs);
    return;
  }

  const policy = readPolicy(snapshot.waiting.onTimeout);
  if (policy === "escalate") {
    const escalateTo = typeof snapshot.waiting.escalateTo === "string"
      ? snapshot.waiting.escalateTo.trim()
      : "";
    if (escalateTo) {
      await escalateWaitingApprovalNode(runId, nodeId, deadlineAt, escalateTo);
      return;
    }
  }

  const terminalPolicy = policy === "auto_reject" ? "auto_reject" : "fail";
  await failWaitingApprovalNode(runId, nodeId, deadlineAt, terminalPolicy);
}

function readPolicy(value: unknown): ApprovalTimeoutPolicy {
  return value === "auto_reject" || value === "escalate" ? value : "fail";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
