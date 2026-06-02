/**
 * Pure scoring + baseline-comparison logic for the AI workflow-generation
 * golden eval suite (consumed by `scripts/run-evals.mjs`).
 *
 * Split out from the harness so the gate semantics — what counts as an
 * ai-mode hit, what counts as a shape pass, and when a run has regressed
 * past the committed baseline — are deterministic and unit-testable WITHOUT
 * standing up the API or spending provider credits.
 *
 * Why rates instead of per-case hard-fails for the AI cases: free-JSON
 * generation has real per-prompt variance (the same prompt can pass one run
 * and fall back the next). A single flake should not red the whole suite;
 * only a drop in the aggregate rate past a tolerance band signals a true
 * regression. Deterministic (fallback-keyed) cases stay hard per-case asserts
 * because their output does not vary.
 *
 * Used by:
 * - `scripts/run-evals.mjs` (the harness) — imports all three helpers.
 * - `scripts/evals-baseline.test.mjs` — node:test coverage of the gate logic.
 */

/**
 * @typedef {Object} EvalCaseResult
 *   Per-case outcome the harness produces for one fixture line. The rate
 *   helpers only read the fields below; the harness carries extra display
 *   fields (mode, nodeCount, issues) that are ignored here.
 * @property {boolean} requiresAi  true when the fixture is `requiresMode: "ai"`.
 * @property {boolean} [skipped]   true when a `requiresAi` case fell back with
 *   no `aiError` (no provider key reachable) — excluded from every denominator.
 * @property {boolean} [transportError] true on a network / HTTP / non-JSON
 *   failure — an infra problem, not model variance, so it is excluded from the
 *   rate denominators (the harness hard-fails the run on it instead).
 * @property {boolean} [aiMode]    did the response come back `mode: "ai"`.
 * @property {boolean} [shapePass] did the response meet its shape expectations
 *   (node counts + required / forbidden / anyOf types).
 */

/**
 * @typedef {Object} AiSummary
 *   Aggregate AI-case rates over a result set. Rates are in `[0, 1]`.
 * @property {number} aiCaseCount   non-skipped `requiresAi` cases — the rate
 *   denominator. `0` means no AI case actually ran (e.g. a no-key run); callers
 *   MUST skip the rate gate in that case rather than treat the `0` rates below
 *   as a regression.
 * @property {number} aiModeRate    fraction that returned `mode: "ai"`.
 * @property {number} shapePassRate fraction that met shape expectations.
 */

/**
 * Aggregate the AI-mode and shape-pass rates over the non-skipped
 * `requiresMode: "ai"` cases. Returns `aiCaseCount: 0` with zeroed rates when
 * no AI case ran — the caller treats that as "no rate signal", not a failure.
 *
 * @param {EvalCaseResult[]} results
 * @returns {AiSummary}
 */
export function summarizeAi(results) {
  const ai = results.filter((r) => r.requiresAi && !r.skipped && !r.transportError);
  const aiCaseCount = ai.length;
  if (aiCaseCount === 0) return { aiCaseCount: 0, aiModeRate: 0, shapePassRate: 0 };
  const aiModeHits = ai.filter((r) => r.aiMode).length;
  const shapeHits = ai.filter((r) => r.shapePass).length;
  return {
    aiCaseCount,
    aiModeRate: aiModeHits / aiCaseCount,
    shapePassRate: shapeHits / aiCaseCount,
  };
}

/**
 * @typedef {Object} EvalBaseline
 *   The committed expected floors, stored in `evals/baseline.json`.
 * @property {number} aiModeRate     expected floor (0..1) for the ai-mode rate.
 * @property {number} shapePassRate  expected floor (0..1) for the shape-pass rate.
 * @property {number} [tolerance]    allowed drop below each floor before it
 *   counts as a regression (0..1; absorbs normal model variance). Default 0.
 */

/**
 * @typedef {Object} BaselineComparison
 * @property {boolean} regressed  true when any metric fell past `floor - tolerance`.
 * @property {string[]} failures  one human-readable reason per regressed metric.
 */

/**
 * Compare observed rates against the committed baseline. A metric regresses
 * only when it drops strictly below `floor - tolerance`, so normal per-run
 * variance inside the tolerance band does not red the suite.
 *
 * @param {AiSummary} observed
 * @param {EvalBaseline} baseline
 * @returns {BaselineComparison}
 */
export function compareToBaseline(observed, baseline) {
  const tolerance = baseline.tolerance ?? 0;
  const failures = [];
  const check = (label, obs, floor) => {
    const threshold = floor - tolerance;
    if (obs < threshold) {
      failures.push(
        `${label} ${obs.toFixed(2)} regressed below baseline ${floor.toFixed(2)} - tolerance ${tolerance.toFixed(2)} = ${threshold.toFixed(2)}`,
      );
    }
  };
  check("ai-mode rate", observed.aiModeRate, baseline.aiModeRate);
  check("shape-pass rate", observed.shapePassRate, baseline.shapePassRate);
  return { regressed: failures.length > 0, failures };
}

/**
 * @typedef {Object} GateDecision
 * @property {boolean} failed    true when the run should exit non-zero.
 * @property {string[]} reasons  why it failed (empty when it passed).
 */

/**
 * The full exit decision for one eval run, kept pure so it is unit-testable
 * without the API. The run fails when there is ANY hard failure (a
 * deterministic case that missed its asserts, or a transport / HTTP / JSON
 * error), OR — only when at least one AI case actually ran — when the AI
 * rates regressed past the baseline. A run with no AI cases (no provider key)
 * is gated solely by the hard failures, so it stays green and $0.
 *
 * @param {{ hardFailures?: number, observed: AiSummary, baseline: EvalBaseline }} input
 * @returns {GateDecision}
 */
export function gateRun({ hardFailures = 0, observed, baseline }) {
  const reasons = [];
  if (hardFailures > 0) {
    reasons.push(`${hardFailures} hard failure(s) (deterministic case or transport error)`);
  }
  if (observed.aiCaseCount > 0) {
    const cmp = compareToBaseline(observed, baseline);
    if (cmp.regressed) reasons.push(...cmp.failures);
  }
  return { failed: reasons.length > 0, reasons };
}
