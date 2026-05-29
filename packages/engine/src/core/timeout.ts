/**
 * Per-node timeout primitive. `withTimeout` races a promise against a
 * `setTimeout` reject; on a tie the timeout wins and a `NodeTimeoutError`
 * is thrown. The timer is always cleared in `finally` so a fast-resolving
 * promise doesn't leak a pending handle.
 *
 * Used by `core/runtime.ts` for top-level node execution and by
 * `node-registry.ts:runAgentLoop` for tool-call timeouts inside an agent.
 */

import type { WorkflowNode } from "@janusly/shared";

/** Thrown when `withTimeout` races out. Carries the configured `timeoutMs`. */
export class NodeTimeoutError extends Error {
  code = "NODE_TIMEOUT";

  constructor(readonly timeoutMs: number) {
    super(`Node timed out after ${timeoutMs}ms`);
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
 * Race a promise against a timeout. When `timeoutMs` is falsy the promise
 * is returned unchanged. The timer is cleared on resolve/reject either way.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs) return promise;

  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NodeTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
