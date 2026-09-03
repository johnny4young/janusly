import { SettingsUsageSection } from '@janusly/web'

/**
 * AI spend broken down by provider and model, with the prompt-cache
 * efficiency underneath. `cachedInputTokens` vs `cacheCreationInputTokens`
 * is what makes the cache section meaningful — reads are cheap, creations are
 * not — so `readSharePercent` is the number operators actually watch.
 */

/** A workspace with the cache working well. */
export function HealthyCacheUse() {
  return (
    <SettingsUsageSection
      providers={[
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          usd: 18.42,
          tokens: 4_820_400,
          inputTokens: 4_120_000,
          cachedInputTokens: 3_460_000,
          cacheCreationInputTokens: 190_000,
          calls: 2_140,
        },
        {
          provider: 'anthropic',
          model: 'claude-haiku-4-5',
          usd: 1.08,
          tokens: 980_200,
          inputTokens: 840_000,
          cachedInputTokens: 610_000,
          cacheCreationInputTokens: 42_000,
          calls: 3_910,
        },
      ]}
      cache={{
        inputTokens: 4_960_000,
        readTokens: 4_070_000,
        creationTokens: 232_000,
        readSharePercent: 82.1,
      }}
    />
  )
}

/** Cache barely helping — mostly cold prompts. */
export function ColdCache() {
  return (
    <SettingsUsageSection
      providers={[
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          usd: 64.9,
          tokens: 6_240_000,
          inputTokens: 5_800_000,
          cachedInputTokens: 310_000,
          cacheCreationInputTokens: 1_240_000,
          calls: 4_020,
        },
      ]}
      cache={{
        inputTokens: 5_800_000,
        readTokens: 310_000,
        creationTokens: 1_240_000,
        readSharePercent: 5.3,
      }}
    />
  )
}

/** Nothing spent yet — the zero state. */
export function NoUsage() {
  return (
    <SettingsUsageSection
      providers={[]}
      cache={{ inputTokens: 0, readTokens: 0, creationTokens: 0, readSharePercent: null }}
    />
  )
}
