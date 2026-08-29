import { OperatorTodayTile } from '@janusly/web'
import { recoveryMetrics } from './_fixtures'

/**
 * The "what needs me today" summary on Home. It folds the 30-day recovery
 * metrics together with the two counts an operator can act on right now —
 * open dead letters and human-approval steps that are waiting — and routes to
 * the panel that clears each.
 *
 * Every metric carries its own `severity`, so the tile colours from the data
 * rather than re-deriving a threshold.
 */

/** A healthy workspace still carrying a small backlog. */
export function WithBacklog() {
  return (
    <OperatorTodayTile
      metrics={recoveryMetrics}
      openDeadLetters={12}
      waitingNodes={3}
      onOpenTab={() => {}}
    />
  )
}

/** Nothing waiting — the state the screen is trying to reach. */
export function AllClear() {
  return (
    <OperatorTodayTile
      metrics={{
        ...recoveryMetrics,
        approvalsPending: {
          value: 0,
          display: '0',
          severity: 'healthy',
          rationale: 'No human-approval step is waiting.',
        },
      }}
      openDeadLetters={0}
      waitingNodes={0}
      onOpenTab={() => {}}
    />
  )
}
