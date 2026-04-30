/**
 * `@janusly/domain` barrel — pure-logic decision / RL / causal / improvement
 * primitives.
 *
 * AGENTS.md invariant: this package is **pure logic, no I/O**. No drizzle
 * imports, no fetch, no fs. The repos under `packages/data` plumb persisted
 * state in and out; the runtime under `packages/engine` orchestrates timing.
 * Domain just decides.
 *
 * Used by:
 * - `packages/engine/src/core/runtime.ts` — invokes `decide()` to score
 *   routing candidates and `applyRlAdjustments` to bias them.
 * - `packages/engine/src/improvement-engine` (orchestrator) — calls
 *   `computeConfidence`, `shouldRollback`, `shouldPromote`.
 * - `apps/api/src/index.ts` — `replayDecision` for the decision explorer.
 */

export * from "./causalReasoning";
export * from "./decisionEngine";
export * from "./improvementEngine";
export * from "./reinforcement";
