import { AiUsageFooter } from '@janusly/web'

/**
 * Per-node AI usage, read from the persisted `RunNode.stateJson.output`.
 * It renders only when that output carries a `usage` object — i.e. an LLM
 * call actually happened — and degrades field by field, so a partial record
 * still shows whatever it does have.
 */

/** A complete record: model, provider, tokens, cost, latency. */
export function FullUsage() {
  return (
    <AiUsageFooter
      stateJson={{
        output: {
          model: 'claude-sonnet-5',
          provider: 'anthropic',
          costUsd: 0.001842,
          latencyMs: 2140,
          usage: { totalTokens: 1284, inputTokens: 940, outputTokens: 344 },
        },
      }}
    />
  )
}

/** No total — the split token counts are shown instead. */
export function SplitTokensOnly() {
  return (
    <AiUsageFooter
      stateJson={{
        output: {
          model: 'claude-haiku-4-5',
          usage: { inputTokens: 512, outputTokens: 96 },
        },
      }}
    />
  )
}

/** Usage recorded at the top level rather than under `output`. */
export function TopLevelUsage() {
  return (
    <AiUsageFooter
      stateJson={{
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        latencyMs: 880,
        usage: { totalTokens: 302 },
      }}
    />
  )
}
