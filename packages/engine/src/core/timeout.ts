import type { WorkflowNode } from "@janusly/shared";

export class NodeTimeoutError extends Error {
  code = "NODE_TIMEOUT";

  constructor(readonly timeoutMs: number) {
    super(`Node timed out after ${timeoutMs}ms`);
    this.name = "NodeTimeoutError";
  }
}

export function getNodeTimeoutMs(node: WorkflowNode): number | undefined {
  const timeoutMs = (node as any)?.config?.timeoutMs;

  if (typeof timeoutMs !== "number") return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;

  return timeoutMs;
}

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
