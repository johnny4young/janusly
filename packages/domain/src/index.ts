/**
 * `@janusly/domain` barrel — pure-logic decision / RL / causal / improvement
 * primitives.
 *
 * Invariant: this package is **pure logic, no I/O**. No drizzle imports, no
 * fetch, no fs. The repos under `packages/data` plumb persisted state in and
 * out; the runtime under `packages/engine` orchestrates timing. Domain just
 * decides.
 *
 * Used by:
 * - `packages/engine/src/core/runtime.ts` — invokes `decide()` to score
 *   routing candidates and `applyRlAdjustments` to bias them.
 * - `packages/engine/src/core/runtime.ts` — calls `computeConfidence`,
 *   `shouldRollback`, and `shouldPromote` during improvement evaluation.
 * - `apps/api/src/routes/runs-routes.ts` — `replayDecision` for the
 *   `GET /causal` decision explorer.
 */

export * from "./causalReasoning";
export * from "./decisionEngine";
export * from "./improvementEngine";
export * from "./reinforcement";
