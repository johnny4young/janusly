import { SettingsOverview } from '@janusly/web'

/**
 * The Settings landing page: a searchable index of every settings section,
 * with the workspace's connection count and AI runtime posture folded into
 * the cards that own them.
 *
 * `permissions` filters which sections appear, and the strings are
 * **dot-separated** (`members.read`, `credentials.read`, …) — the colon form
 * matches nothing and leaves the index empty.
 */

const fullAccess = [
  'recovery.read',
  'workflows.read',
  'runs.read',
  'members.read',
  'credentials.read',
  'packs.read',
  'evals.read',
  'ai.write',
]

/** A configured workspace: connections counted, AI connected. */
export function Configured() {
  return (
    <SettingsOverview
      permissions={fullAccess}
      connectionCount={7}
      aiHealth={{
        enabled: true,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        timeoutMs: 30000,
        maxRetries: 2,
      }}
      onOpenSection={() => {}}
      onOpenTab={() => {}}
    />
  )
}

/** No provider key — Janusly runs, and the AI card says so instead of erroring. */
export function AiDisabled() {
  return (
    <SettingsOverview
      permissions={fullAccess}
      connectionCount={0}
      aiHealth={{ enabled: false, model: 'claude-sonnet-5', timeoutMs: 30000, maxRetries: 2 }}
      onOpenSection={() => {}}
      onOpenTab={() => {}}
    />
  )
}
