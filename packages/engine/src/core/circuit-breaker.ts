/**
 * Recovery circuit breaker (containment slice). Pure logic —
 * no I/O.
 *
 * While an operator authors a patch, a broken workflow keeps running: every
 * scheduled tick and every trigger event re-executes the same doomed DAG,
 * flooding the DLQ with duplicates of one failure and — worse — re-firing
 * whatever write-side effects ran BEFORE the failing node. The breaker draws
 * the line: N consecutive dead letters for the same workflow trips it, the
 * workflow pauses, and the operator patches a quiet system.
 *
 * Deliberately narrow, because the mechanism is destructive (a paused workflow
 * stops accepting work):
 * - CONSECUTIVE failures only. A workflow that fails once an hour among
 *   hundreds of green runs is not broken; a workflow whose last N runs all
 *   dead-lettered is. Any success resets the streak.
 * - The tripped state reuses the EXISTING pause substrate (`workflows.status`
 *   + `pausedReason`, the same one upstream-health drives), so `POST /start`'s
 *   409 + the "Force run" override + the paused-workflow UI all work already.
 * - The operator resumes explicitly. Nothing auto-resumes a tripped breaker:
 *   the whole point is that a human decides the workflow is fixed. (An
 *   upstream-health pause auto-resumes because a status page is authoritative
 *   about the outage; nothing is authoritative about "the bug is gone".)
 *
 * Used by `adapters/dead-letter-queue.ts` at the single point where a terminal
 * failure has just been persisted.
 *
 * Composes with the transient tier: the transient tier absorbs the failures that heal, so a
 * streak that reaches this module is a real, persistent break — exactly what
 * should stop the line.
 */

/** Env kill switch. Default: ENABLED. */
export const CIRCUIT_BREAKER_ENV = "JANUSLY_CIRCUIT_BREAKER_ENABLED";

/**
 * Consecutive dead letters that trip the breaker when a workflow declares no
 * threshold of its own. Five is conservative: a genuinely broken workflow
 * reaches it in seconds, while a flaky-but-working one rarely strings five
 * failures with no success between them.
 */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;

/** Bounds for an operator-supplied threshold. 1 would trip on a single blip. */
export const MIN_CIRCUIT_BREAKER_THRESHOLD = 2;
export const MAX_CIRCUIT_BREAKER_THRESHOLD = 100;

/** Resolve the effective threshold for a workflow, or null when disabled. */
export function resolveCircuitBreakerThreshold(input: {
  /** `config.recovery.circuitBreaker.consecutiveFailures` off the workflow JSON. */
  workflowThreshold?: unknown;
  /** Org-level default; absent falls back to `DEFAULT_CIRCUIT_BREAKER_THRESHOLD`. */
  orgThreshold?: number | null;
  enabled: boolean;
}): number | null {
  if (!input.enabled) return null;

  // An explicit `false` on the workflow opts that workflow out entirely —
  // some pipelines are expected to fail loudly and keep going.
  if (input.workflowThreshold === false) return null;

  const candidate = typeof input.workflowThreshold === "number"
    ? input.workflowThreshold
    : typeof input.orgThreshold === "number"
      ? input.orgThreshold
      : DEFAULT_CIRCUIT_BREAKER_THRESHOLD;

  if (!Number.isFinite(candidate)) return DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
  if (candidate < MIN_CIRCUIT_BREAKER_THRESHOLD) return null; // 0 / 1 = opt out
  return Math.min(Math.floor(candidate), MAX_CIRCUIT_BREAKER_THRESHOLD);
}

/** Whether the just-persisted failure should trip the breaker. */
export function shouldTripCircuitBreaker(input: {
  /** Consecutive dead letters for this workflow, INCLUDING the one just written. */
  consecutiveFailures: number;
  threshold: number | null;
  /** Current `workflows.status` — only an active workflow can trip. */
  workflowStatus: string;
}): boolean {
  if (input.threshold === null) return false;
  if (input.workflowStatus !== "active") return false; // already paused / tombstoned
  return input.consecutiveFailures >= input.threshold;
}

/** Read the breaker knob off a workflow's JSON `config.recovery.circuitBreaker`. */
export function readWorkflowCircuitBreaker(workflowJson: unknown): number | false | undefined {
  if (!workflowJson || typeof workflowJson !== "object" || Array.isArray(workflowJson)) return undefined;
  const recovery = (workflowJson as { recovery?: unknown }).recovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return undefined;
  const breaker = (recovery as { circuitBreaker?: unknown }).circuitBreaker;
  if (breaker === false) return false;
  if (typeof breaker === "number") return breaker;
  if (breaker && typeof breaker === "object" && !Array.isArray(breaker)) {
    const value = (breaker as { consecutiveFailures?: unknown }).consecutiveFailures;
    if (value === false) return false;
    if (typeof value === "number") return value;
  }
  return undefined;
}

/** Whether the breaker is on. Defaults ENABLED; set the env to "false" to opt out. */
export function isCircuitBreakerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CIRCUIT_BREAKER_ENV] !== "false";
}
