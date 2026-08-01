/**
 * Per-node timeout primitive. `withTimeout` races a promise against a
 * `setTimeout` reject; on a tie the timeout wins and a `NodeTimeoutError`
 * is thrown. The timer is always cleared in `finally` so a fast-resolving
 * promise doesn't leak a pending handle, and the losing (abandoned) promise's
 * eventual rejection is swallowed so it never surfaces as an
 * `unhandledRejection` after the timeout already won the race.
 *
 * Used by `execute-node.ts` to enforce `config.timeoutMs` at the single
 * executor chokepoint — before this, a `tool` / `subworkflow` / `ai` /
 * `transform` node whose executor hung blocked the worker until the 5-minute
 * stalled-node reaper — and by `node-executors/agents.ts:runAgentLoop` for per-tool
 * timeouts inside an agent (via this shared implementation, not a private
 * duplicate).
 */

import type { WorkflowNode } from "@janusly/shared";

/**
 * Thrown when `withTimeout` races out. Carries the configured `timeoutMs`
 * and an optional `label` (the node type / agent-tool name) folded into the
 * message. `writeSide` is set by `execute-node.ts` when the timed-out node
 * could have already committed an external side effect (a write-side HTTP
 * method or a `writeSide` tool) — the abandoned executor keeps running after
 * the race, so a blind replay might duplicate the effect. It rides through to
 * `error_json` / the DLQ so the operator (and the recovery loop) can treat a
 * write-side timeout with the care a read-side one doesn't need.
 */
export class NodeTimeoutError extends Error {
  code = "NODE_TIMEOUT";
  /** True when the timed-out node may have committed an external side effect. */
  writeSide = false;

  constructor(readonly timeoutMs: number, readonly label?: string) {
    super(`${label ?? "Node"} timed out after ${timeoutMs}ms`);
    this.name = "NodeTimeoutError";
  }
}

/** Read `config.timeoutMs` off a `WorkflowNode` if it's a positive finite number; otherwise `undefined`. */
export function getNodeTimeoutMs(node: WorkflowNode): number | undefined {
  const timeoutMs = node.config?.timeoutMs;

  if (typeof timeoutMs !== "number") return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;

  return timeoutMs;
}

/**
 * Race a promise against a timeout. When `timeoutMs` is falsy the promise is
 * returned unchanged (behavior-preserving when a node declares no timeout).
 * On timeout, rejects with `NodeTimeoutError(timeoutMs, label)`. The abandoned
 * `promise` may still be pending — its later rejection is caught so it can't
 * become an unhandled rejection (e.g. a hung fetch that aborts moments after
 * the node was already marked timed-out).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs?: number,
  opts: { label?: string; onTimeout?: () => void } = {},
): Promise<T> {
  if (!timeoutMs) return promise;

  // Swallow a late rejection of the abandoned promise once the timeout wins.
  // Attached unconditionally: in the success/normal-reject case the value or
  // rejection is delivered through the race first, so this handler is a no-op.
  promise.catch(() => {});

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Settle the timeout promise first so an executor that reacts
      // synchronously to cancellation cannot replace NODE_TIMEOUT with its
      // own abort error at the boundary.
      reject(new NodeTimeoutError(timeoutMs, opts.label));
      try {
        opts.onTimeout?.();
      } catch {
        // Cancellation is best-effort; it must never hide the timeout.
      }
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
