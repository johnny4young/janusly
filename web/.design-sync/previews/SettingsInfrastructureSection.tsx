import { SettingsInfrastructureSection } from '@janusly/web'

/**
 * Platform health in one block: the rate limiter, both PostgreSQL-backed
 * queues, and the worker fleet. `queueCheckedAt` is the freshness stamp for
 * the queue readings; the two `*UnavailableReason` props distinguish "the
 * store returned nothing" from "the request failed", which is not the same
 * as an empty queue.
 */

// Fixed stamp so the freshness line does not drift between captures.
const CHECKED_AT = 1787788800000

/** Everything healthy. */
export function AllHealthy() {
  return (
    <SettingsInfrastructureSection
      rateLimiterHealth={{ healthy: true, degradedBuckets: [] }}
      queueHealth={{ waiting: 0, active: 4, oldestWaitingSeconds: null, warnSeconds: 60 }}
      maintenanceQueueHealth={{ waiting: 1, active: 0, oldestWaitingSeconds: 8, warnSeconds: 120 }}
      queueCheckedAt={CHECKED_AT}
      workerFleet={{ status: 'healthy' }}
    />
  )
}

/** Under pressure: degraded buckets, a backed-up queue, a degraded fleet. */
export function Degraded() {
  return (
    <SettingsInfrastructureSection
      rateLimiterHealth={{
        healthy: false,
        degradedBuckets: [{ bucket: 'org:acme:workflow-start' }, { bucket: 'org:acme:ai-calls' }],
      }}
      queueHealth={{ waiting: 128, active: 8, oldestWaitingSeconds: 412, warnSeconds: 60 }}
      maintenanceQueueHealth={{ waiting: 22, active: 1, oldestWaitingSeconds: 190, warnSeconds: 120 }}
      queueCheckedAt={CHECKED_AT}
      workerFleet={{ status: 'degraded' }}
    />
  )
}

/** Queue telemetry unavailable for two different reasons at once. */
export function TelemetryUnavailable() {
  return (
    <SettingsInfrastructureSection
      rateLimiterHealth={{ healthy: true, degradedBuckets: [] }}
      queueHealth={{ waiting: 0, active: 0, oldestWaitingSeconds: null, warnSeconds: 60 }}
      maintenanceQueueHealth={{ waiting: 0, active: 0, oldestWaitingSeconds: null, warnSeconds: 120 }}
      queueCheckedAt={CHECKED_AT}
      queueUnavailableReason="store"
      maintenanceQueueUnavailableReason="transport"
      workerFleet={{ status: 'unhealthy' }}
    />
  )
}
