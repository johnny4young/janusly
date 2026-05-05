/**
 * `@janusly/ai` barrel — re-exports the run explainer and the
 * provider-neutral LLM abstraction.
 *
 * Used by:
 * - `apps/api/src/index.ts` — `/ai/*` routes import `explainRun` +
 *   `getLlmClient`.
 * - `packages/engine/src/agent-planner.ts` + `node-registry.ts` — both
 *   import `getLlmClient` so the engine never names a vendor.
 *
 * The provider abstraction is the single chokepoint for every
 * AI call in Janusly; see `./llm-client.ts` for the registry pattern that
 * makes adding a provider a four-field record entry.
 */

export * from "./runExplainer";
export * from "./patch-workflow";
export {
  createLlmClient,
  getLlmClient,
  resolveLlmConfig,
  _resetLlmClientForTests,
  _registerProviderForTests,
  _unregisterProviderForTests,
  type LlmClient,
  type LlmGenerateTextInput,
  type LlmGenerateTextResult,
  type LlmGenerateObjectInput,
  type LlmGenerateObjectResult,
  type ProviderSpec,
  type ResolvedLlmConfig,
} from "./llm-client";
export {
  setUsageRecorder,
  getUsageRecorder,
  _resetUsageRecorderForTests,
  type UsageRecord,
  type UsageRecorder,
} from "./usage-recorder";
export {
  computeCostUsd,
  getModelPrice,
  type ModelPrice,
} from "./pricing";
