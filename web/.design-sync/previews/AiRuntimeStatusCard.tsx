import { AiRuntimeStatusCard } from '@janusly/web'

/**
 * Whether the AI runtime is configured, and with what. Janusly runs fully
 * without a provider key — the disabled state is a supported mode, not an
 * error — so this card's job is to say which mode you are in.
 */

/** Configured and enabled — provider, model, and the call budget. */
export function Enabled() {
  return (
    <AiRuntimeStatusCard
      health={{
        enabled: true,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        timeoutMs: 30000,
        maxRetries: 2,
      }}
    />
  )
}

/** No provider key configured. Janusly still runs; AI features stand down. */
export function Disabled() {
  return (
    <AiRuntimeStatusCard
      health={{ enabled: false, model: 'claude-sonnet-5', timeoutMs: 30000, maxRetries: 2 }}
    />
  )
}

/** A tighter budget — short timeout, no retries. */
export function StrictBudget() {
  return (
    <AiRuntimeStatusCard
      health={{
        enabled: true,
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        timeoutMs: 5000,
        maxRetries: 0,
      }}
    />
  )
}
