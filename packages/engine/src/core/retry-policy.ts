/**
 * Retry policy evaluator. Pure logic — no I/O. Maps a serialized error to a
 * set of label strings (HTTP status, error name/code, "timeout", "network")
 * and decides whether a `RetryPolicy` should retry it, plus the next delay.
 *
 * Used by `core/runtime.ts` after each node-executor failure and by
 * `BullMQQueueAdapter` to wire BullMQ's per-job retry config.
 *
 * Invariants:
 * - `shouldRetry` returns `false` when no policy is configured — callers
 *   that want a default policy must construct one explicitly.
 * - The HTTP-status pattern is `\dxx` (e.g. `5xx` matches 500–599); don't
 *   add looser patterns without updating the pattern matcher.
 */

import type { RetryPolicy, SerializedError } from "./types";

const HTTP_STATUS_PATTERN = /^(\d)xx$/;

/**
 * Convert a serialized error into label strings used for retry-policy
 * pattern matching: HTTP status code (`"500"`), status family (`"5xx"`),
 * error name / code, and the synthetic `"timeout"` / `"network"` flags.
 */
export function classifyError(error: SerializedError): string[] {
  const labels = new Set<string>();

  if (error.name) labels.add(error.name);
  if (error.code) labels.add(error.code);

  const statusCode = error.statusCode;
  if (typeof statusCode === "number") {
    labels.add(String(statusCode));
    labels.add(`${Math.floor(statusCode / 100)}xx`);
  }

  const message = error.message.toLowerCase();
  // "timed out" (the wording `NodeTimeoutError` itself emits) counts too —
  // matching only "timeout" left the executor's own timeout unlabelled, so a
  // `retryOn: ["timeout"]` policy silently never fired for it.
  if (
    message.includes("timeout")
    || message.includes("timed out")
    || error.code === "ETIMEDOUT"
    || error.code === "NODE_TIMEOUT"
  ) {
    labels.add("timeout");
  }
  if (message.includes("network") || error.code === "ECONNRESET" || error.code === "ENOTFOUND") labels.add("network");

  return [...labels];
}

function matchesPattern(label: string, pattern: string): boolean {
  if (label === pattern) return true;

  const match = pattern.match(HTTP_STATUS_PATTERN);
  if (!match) return false;

  return label.startsWith(match[1]) && label.length === 3;
}

/**
 * Decide whether `error` should trigger a retry under `policy`. Returns
 * `false` when no policy is supplied; otherwise honours `ignoreOn` first,
 * then `retryOn` (default: retry everything not ignored).
 */
export function shouldRetry(error: SerializedError, policy?: RetryPolicy): boolean {
  if (!policy) return false;

  const labels = classifyError(error);

  if (policy.ignoreOn?.some((pattern) => labels.some((label) => matchesPattern(label, pattern)))) {
    return false;
  }

  if (!policy.retryOn || policy.retryOn.length === 0) {
    return true;
  }

  return policy.retryOn.some((pattern) => labels.some((label) => matchesPattern(label, pattern)));
}

/**
 * Compute the delay (ms) before the next retry attempt. Supports
 * exponential backoff (`base * 2^(attempt-1)`), a hard cap (`maxDelayMs`),
 * and full jitter (sample uniformly in `[delay/2, delay]`).
 */
export function computeRetryDelay(attempt: number, policy?: RetryPolicy): number {
  if (!policy) return 0;

  const base = policy.delayMs ?? 1000;
  const rawDelay = policy.backoff === "exponential"
    ? base * Math.pow(2, attempt - 1)
    : base;

  const cappedDelay = typeof policy.maxDelayMs === "number"
    ? Math.min(rawDelay, policy.maxDelayMs)
    : rawDelay;

  if (!policy.jitter) return cappedDelay;

  const min = Math.floor(cappedDelay * 0.5);
  const max = cappedDelay;
  return Math.floor(min + Math.random() * (max - min));
}
