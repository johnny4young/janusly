/**
 * Transient-error fast path. Pure logic — no I/O.
 *
 * Most production failures are transient: a 429, a dropped connection, a
 * gateway timeout. Dead-lettering those burns the wedge's credibility (the
 * operator gets paged for something that would have healed) and its budget
 * (an LLM patch proposal for a rate limit). This module decides — with ZERO
 * model involvement — whether an error that already exhausted its per-node
 * retry policy deserves one more deterministic ladder of attempts before the
 * DLQ, and how long to wait.
 *
 * Used by `core/runtime.ts` at the single point between "per-node retries
 * exhausted" and `persistTerminalFailure`.
 *
 * Invariants:
 * - The tier NEVER applies to a write-side error. A timed-out or partially
 *   committed external write needs an operator decision, exactly like the
 *   whole-node retry guard above it (duplicate side effects are worse than a
 *   dead letter).
 * - The ladder position is DERIVED, not stored: it is `attempt - maxAttempts`,
 *   read off the `run_nodes.attempts` counter the runtime already persists and
 *   the queue already carries. No second counter to keep in sync, and a crash
 *   mid-ladder resumes at the right rung for free.
 * - Classes are deterministic and closed. Adding one means a new entry here
 *   plus its `TRANSIENT_LADDER_MS` row — never a heuristic on free-form text
 *   beyond the labels `classifyError` already produces.
 */

import { classifyError } from "./retry-policy";
import type { SerializedError } from "./types";

/** Closed set of error classes the fast path recognises. */
export const TRANSIENT_CLASSES = ["rate_limit", "connection", "timeout"] as const;
export type TransientClass = (typeof TRANSIENT_CLASSES)[number];

/**
 * Backoff ladder per class, in milliseconds. Length = the cap on transient
 * attempts for that class. Rate limits get the longest tail (a provider quota
 * window is minutes, not seconds); connection/timeout blips heal faster.
 *
 * Deliberately conservative: the ladder buys the operator a quiet recovery,
 * it does not replace the DLQ. Every class terminates.
 */
export const TRANSIENT_LADDER_MS: Record<TransientClass, readonly number[]> = {
  rate_limit: [30_000, 120_000, 300_000],
  connection: [5_000, 30_000, 120_000],
  timeout: [10_000, 60_000, 180_000],
};

/** Env override name for disabling the tier entirely. */
export const TRANSIENT_TIER_ENV = "JANUSLY_TRANSIENT_TIER_ENABLED";

/**
 * Map a serialized error onto a transient class, or null when it isn't one.
 * Reuses `classifyError`'s labels so the vocabulary matches the retry policy
 * and the clustering signatures — no second, drifting classifier.
 */
export function classifyTransient(error: SerializedError): TransientClass | null {
  const labels = new Set(classifyError(error));

  // Rate limiting is explicit: the status code is the contract. 429 only —
  // a 503 is a server fault that may need a real fix, not a quota wait.
  if (labels.has("429")) return "rate_limit";

  // Timeout before connection: an ETIMEDOUT carries both flavours and the
  // longer ladder is the safer read.
  if (labels.has("timeout") || labels.has("ETIMEDOUT")) return "timeout";

  if (labels.has("network") || labels.has("ECONNRESET") || labels.has("ENOTFOUND") || labels.has("ECONNREFUSED")) {
    return "connection";
  }

  return null;
}

/** What the runtime should do with a failure whose node retries are spent. */
export type TransientDecision =
  | { kind: "dead_letter" }
  | { kind: "transient_retry"; transientClass: TransientClass; delayMs: number; transientAttempt: number; ladderLength: number };

/**
 * Decide the fate of an exhausted-retry failure.
 *
 * `transientAttempt` is the number of ladder steps ALREADY taken for this
 * node (0 on the first transient failure). Returns `dead_letter` when the
 * error isn't transient, the tier is disabled, the ladder is spent, or the
 * error touched a write side.
 */
export function decideTransient(input: {
  error: SerializedError;
  transientAttempt: number;
  enabled: boolean;
}): TransientDecision {
  if (!input.enabled) return { kind: "dead_letter" };

  // Write-side errors are the runtime's hard line: a possibly-committed
  // external effect is an operator decision, never an automatic re-run.
  if (input.error.writeSide === true) return { kind: "dead_letter" };

  const transientClass = classifyTransient(input.error);
  if (!transientClass) return { kind: "dead_letter" };

  const ladder = TRANSIENT_LADDER_MS[transientClass];
  if (input.transientAttempt >= ladder.length) return { kind: "dead_letter" };

  return {
    kind: "transient_retry",
    transientClass,
    delayMs: ladder[input.transientAttempt]!,
    transientAttempt: input.transientAttempt + 1,
    ladderLength: ladder.length,
  };
}

/**
 * Ladder position for a failure whose node retries are spent: how many tier
 * steps this node has already taken. Derived from the persisted attempt
 * counter — `attempt` is the one that just failed, `maxAttempts` the node's
 * own retry budget — so it needs no separate bookkeeping and survives a crash.
 * Clamped at 0 for defensive callers (a legacy row with a stale counter).
 */
export function transientAttemptFromCounters(attempt: number, maxAttempts: number): number {
  return Math.max(0, attempt - Math.max(1, maxAttempts));
}

/** Whether the tier is on. Defaults to ENABLED; set the env to "false" to opt out. */
export function isTransientTierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TRANSIENT_TIER_ENV] !== "false";
}
