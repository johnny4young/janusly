import { QueueLagChip } from '@janusly/web'

/**
 * Compact queue-pressure readout for Operations. `warnSeconds` is the
 * threshold the oldest waiting job is measured against, so the same numbers
 * read as healthy or delayed depending on it. `null` health means telemetry
 * is unavailable — `unavailableReason` says whether the queue store returned
 * nothing or the request itself failed. It never means an empty queue.
 */

/** Healthy: nothing waiting, work in flight. */
export function Healthy() {
  return (
    <QueueLagChip health={{ waiting: 0, active: 3, oldestWaitingSeconds: null, warnSeconds: 60 }} />
  )
}

/** Backing up: the oldest job has waited past the warn threshold. */
export function Delayed() {
  return (
    <QueueLagChip health={{ waiting: 42, active: 8, oldestWaitingSeconds: 214, warnSeconds: 60 }} />
  )
}

/** The maintenance queue, which is reported separately from workflows. */
export function MaintenanceQueue() {
  return (
    <QueueLagChip
      kind="maintenance"
      health={{ waiting: 5, active: 1, oldestWaitingSeconds: 12, warnSeconds: 120 }}
    />
  )
}

/** Telemetry unavailable because the queue store returned no projection. */
export function UnavailableStore() {
  return <QueueLagChip health={null} unavailableReason="store" />
}

/** Telemetry unavailable because the request never landed. */
export function UnavailableTransport() {
  return <QueueLagChip health={null} unavailableReason="transport" />
}
