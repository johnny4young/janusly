import { RecoveryCenterTile } from '@janusly/web'

/**
 * The Recovery Center's tile shell. It owns the frame — kicker, title, severity
 * accent, body slot, and an optional footer — and nothing about what goes
 * inside, which is why every tile on that screen is built from it.
 *
 * `severity` is the accent, not a status the tile computes: `warning` and
 * `danger` for work that needs attention, `cobalt` and `cyan` for informational
 * counts, `success` for a cleared queue, `neutral` when nothing should draw the
 * eye. `testId` is required — the Recovery Center's tests address tiles by it.
 */

const Dot = ({ label }: { label: string }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" role="img" aria-label={label}>
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="8" cy="8" r="2" fill="currentColor" />
  </svg>
)

/** The queue tile — a count that needs acting on. */
export function NeedsAttention() {
  return (
    <RecoveryCenterTile
      testId="tile-queue"
      severity="warning"
      kicker="Recovery queue"
      title="12 open failures"
      icon={<Dot label="Queue" />}
      footer={<span>Oldest waiting 4 h 20 m</span>}
    >
      Three signatures account for 9 of them. Billing 503s are the largest
      cluster and already have a replay campaign running.
    </RecoveryCenterTile>
  )
}

/** A cleared queue — the state the screen is trying to reach. */
export function Cleared() {
  return (
    <RecoveryCenterTile
      testId="tile-cleared"
      severity="success"
      kicker="Recovery queue"
      title="Nothing waiting"
      icon={<Dot label="Cleared" />}
    >
      Every dead letter from the last 7 days was replayed or resolved.
    </RecoveryCenterTile>
  )
}

/** An informational count, deliberately quiet. */
export function Informational() {
  return (
    <RecoveryCenterTile
      testId="tile-drills"
      severity="cobalt"
      kicker="Last 30 days"
      title="42 recovery drills"
      icon={<Dot label="Drills" />}
      footer={<span>Median time to recover 7 m 41 s</span>}
    >
      81.6% of drills ended in a recovered run; the rest were accepted as
      partial loss.
    </RecoveryCenterTile>
  )
}
