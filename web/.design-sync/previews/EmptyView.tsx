import { EmptyView } from '@janusly/web'
import { KeyRound, Wrench } from 'lucide-react'

/**
 * The panel-family empty slot. A thin adapter over `EmptyState` — `title`
 * maps to EmptyState's `kicker` — so the Templates / Tools / Credentials /
 * Reasoning / Runs panels all share one empty look.
 */

/** With a next step, as the Tools panel offers it. */
export function WithAction() {
  return (
    <EmptyView
      icon={<Wrench size={20} />}
      title="No tools connected"
      body="Connect a tool to let workflows call it during a run."
      cta={{ label: 'Browse tools', onClick: () => {} }}
    />
  )
}

/** Informational only — nothing for the operator to do here yet. */
export function WithoutAction() {
  return (
    <EmptyView
      icon={<KeyRound size={20} />}
      title="No credentials stored"
      body="Credentials added here are encrypted at rest and never shown again."
    />
  )
}
