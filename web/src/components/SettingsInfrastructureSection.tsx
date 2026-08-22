import { useT } from '../i18n'
import {
  QueueLagChip,
  type QueueHealth,
  type QueueUnavailableReason,
} from './QueueLagChip'
import { RunStreamChip } from './RunStreamChip'

type RateLimiterHealth = {
  healthy: boolean
  degradedBuckets: Array<{ bucket: string }>
}

export type WorkerFleet = {
  liveCount: number
  staleCount: number
}

export function SettingsInfrastructureSection({
  rateLimiterHealth,
  queueHealth,
  maintenanceQueueHealth,
  queueCheckedAt,
  queueUnavailableReason,
  maintenanceQueueUnavailableReason,
  workerFleet,
}: {
  rateLimiterHealth: RateLimiterHealth | null
  queueHealth: QueueHealth | null | undefined
  maintenanceQueueHealth: QueueHealth | null | undefined
  queueCheckedAt: number | null
  queueUnavailableReason?: QueueUnavailableReason
  maintenanceQueueUnavailableReason?: QueueUnavailableReason
  workerFleet?: WorkerFleet | null
}) {
  const { t } = useT()
  const rateLimiterTone = rateLimiterHealth === null
    ? 'neutral'
    : rateLimiterHealth.healthy
      ? 'success'
      : 'warning'
  const rateLimiterLabel = rateLimiterHealth === null
    ? t('common.unknown')
    : rateLimiterHealth.healthy
      ? t('vitals.severity.healthy')
      : t('vitals.severity.warn')
  const rateLimiterBody = rateLimiterHealth === null
    ? t('common.unknown')
    : rateLimiterHealth.healthy
      ? t('operations.rateLimiter.healthy')
      : t('operations.rateLimiter.degraded', {
          count: rateLimiterHealth.degradedBuckets.length,
        })

  return (
    <section className="we-card we-infrastructure-card">
      <div className="we-infrastructure-card__queue">
        <strong>{t('runStream.label')}</strong>
        <RunStreamChip showIdle />
      </div>
      <div className="we-infrastructure-card__queue">
        <div>
          <strong>{t('operations.rateLimiter.label')}</strong>
          <span>{rateLimiterBody}</span>
        </div>
        <span className="we-pill" data-tone={rateLimiterTone}>{rateLimiterLabel}</span>
      </div>
      <div className="we-infrastructure-card__queue">
        <strong>{t('operations.queueLag.label')}</strong>
        {queueHealth !== undefined ? (
          <QueueLagChip
            health={queueHealth}
            checkedAt={queueCheckedAt}
            unavailableReason={queueUnavailableReason}
          />
        ) : <span className="we-pill" data-tone="neutral">{t('common.unknown')}</span>}
      </div>
      {workerFleet !== undefined && (
        <div className="we-infrastructure-card__queue" data-testid="worker-fleet-row">
          <div>
            <strong>{t('operations.workerFleet.label')}</strong>
            <span>
              {workerFleet === null
                ? t('common.unknown')
                : t('operations.workerFleet.body', {
                    live: workerFleet.liveCount, stale: workerFleet.staleCount,
                  })}
            </span>
          </div>
          <span
            className="we-pill"
            data-tone={workerFleet === null
              ? 'neutral'
              : workerFleet.liveCount === 0
                ? 'danger'
                : workerFleet.staleCount > 0 ? 'warning' : 'success'}
          >
            {workerFleet === null
              ? t('common.unknown')
              : workerFleet.liveCount === 0
                ? t('vitals.severity.unhealthy')
                : workerFleet.staleCount > 0
                  ? t('vitals.severity.warn')
                  : t('vitals.severity.healthy')}
          </span>
        </div>
      )}
      <div className="we-infrastructure-card__queue">
        <strong>{t('operations.maintenanceQueueLag.label')}</strong>
        {maintenanceQueueHealth !== undefined ? (
          <QueueLagChip
            kind="maintenance"
            health={maintenanceQueueHealth}
            checkedAt={queueCheckedAt}
            unavailableReason={maintenanceQueueUnavailableReason}
          />
        ) : <span className="we-pill" data-tone="neutral">{t('common.unknown')}</span>}
      </div>
    </section>
  )
}
