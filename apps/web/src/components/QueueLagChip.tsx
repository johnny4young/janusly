/**
 * Compact workflow-queue pressure status for the Operations header.
 *
 * Used by `OperationsPage.tsx` with the authenticated `/system/queue`
 * snapshot. `null` means telemetry is unavailable; `unavailableReason`
 * distinguishes a successful Redis-null projection from a failed request.
 * It never means an empty queue. The public `/health` route's coarse signal
 * is intentionally not consumed here because live queue values are admin-only.
 */

import { getResolvedLocale, useT } from '../i18n'

export type QueueHealth = {
  waiting: number
  active: number
  oldestWaitingSeconds: number | null
  warnSeconds: number
}

export type QueueUnavailableReason = 'redis' | 'transport'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Runtime guard for the non-versioned infrastructure response. */
export function parseQueueHealth(value: unknown): QueueHealth | null {
  if (!isRecord(value)) return null
  if (!isCount(value.waiting) || !isCount(value.active)) return null
  if (!isCount(value.warnSeconds) || value.warnSeconds < 1) return null
  if (value.oldestWaitingSeconds !== null && !isCount(value.oldestWaitingSeconds)) return null
  if (value.waiting === 0 && value.oldestWaitingSeconds !== null) return null
  return {
    waiting: value.waiting,
    active: value.active,
    oldestWaitingSeconds: value.oldestWaitingSeconds,
    warnSeconds: value.warnSeconds,
  }
}

/** Delayed and unavailable snapshots both deserve the Reliability dot. */
export function queueNeedsAttention(health: QueueHealth | null): boolean {
  return health === null
    || (health.oldestWaitingSeconds !== null
      && health.oldestWaitingSeconds > health.warnSeconds)
}

function QueueLagFrame({
  state,
  message,
  announcement,
  checkedLabel,
}: {
  state: 'clear' | 'processing' | 'delayed'
  | 'unavailable'
  message: string
  announcement: string
  checkedLabel: string | null
}) {
  const { t } = useT()
  return (
    <span
      className={`we-ops-queue-lag-chip we-ops-queue-lag-chip--${state}`}
      data-state={state}
      data-testid="queue-lag-chip"
    >
      <span
        className="we-sr-only"
        role="status"
        aria-label={`${t('operations.queueLag.label')}: ${announcement}`}
      >
        {announcement}
      </span>
      <span
        className="we-ops-queue-lag-chip__state"
      >
        <span className="we-ops-queue-lag-chip__dot" aria-hidden="true" />
        <span>{message}</span>
      </span>
      {checkedLabel && (
        <span className="we-ops-queue-lag-chip__age">· {checkedLabel}</span>
      )}
    </span>
  )
}

export function QueueLagChip({
  health,
  checkedAt,
  unavailableReason = 'redis',
}: {
  health: QueueHealth | null
  checkedAt?: number | null
  unavailableReason?: QueueUnavailableReason
}) {
  const { t } = useT()
  const checkedLabel = typeof checkedAt === 'number'
    ? (t('operations.queueLag.checkedAt', {
        time: new Date(checkedAt).toLocaleTimeString(getResolvedLocale()),
      }))
    : null

  if (health === null) {
    const message = t(unavailableReason === 'redis'
      ? 'operations.queueLag.unavailableRedis'
      : 'operations.queueLag.unavailableTransport')
    return (
      <QueueLagFrame
        state="unavailable"
        message={message}
        announcement={message}
        checkedLabel={checkedLabel}
      />
    )
  }

  if (health.waiting === 0) {
    const message = t('operations.queueLag.clear')
    return (
      <QueueLagFrame
        state="clear"
        message={message}
        announcement={message}
        checkedLabel={checkedLabel}
      />
    )
  }

  const duration = health.oldestWaitingSeconds === null
    ? t('operations.queueLag.agePending')
    : health.oldestWaitingSeconds >= 3_600
      ? t('operations.queueLag.hours', { count: Math.floor(health.oldestWaitingSeconds / 3_600) })
      : health.oldestWaitingSeconds >= 60
        ? t('operations.queueLag.minutes', { count: Math.floor(health.oldestWaitingSeconds / 60) })
        : t('operations.queueLag.seconds', { count: health.oldestWaitingSeconds })
  const delayed = health.oldestWaitingSeconds !== null
    && health.oldestWaitingSeconds > health.warnSeconds
  const message = t(
    delayed
      ? health.active > 0
        ? 'operations.queueLag.delayedActive'
        : 'operations.queueLag.delayedIdle'
      : 'operations.queueLag.processing',
    { count: health.waiting, duration },
  )
  return (
    <QueueLagFrame
      state={delayed ? 'delayed' : 'processing'}
      message={message}
      announcement={t(delayed
        ? health.active > 0
          ? 'operations.queueLag.delayedActiveStatus'
          : 'operations.queueLag.delayedIdleStatus'
        : 'operations.queueLag.processingStatus')}
      checkedLabel={checkedLabel}
    />
  )
}
