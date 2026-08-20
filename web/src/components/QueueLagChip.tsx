/**
 * Compact workflow or maintenance queue pressure for Operations.
 *
 * Used by `OperationsPage.tsx` with the authenticated `/system/queue`
 * snapshot. `null` means telemetry is unavailable; `unavailableReason`
 * distinguishes a successful null queue-store projection from a failed request.
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

export type QueueHealthOverview = {
  workflow: QueueHealth | null
  maintenance: QueueHealth | null | undefined
}

export type QueueUnavailableReason = 'store' | 'transport'

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

/** Parse the additive admin shape while remaining compatible with older APIs. */
export function parseQueueHealthOverview(value: unknown): QueueHealthOverview {
  const workflow = parseQueueHealth(value)
  const maintenance = isRecord(value) && 'maintenance' in value
    ? parseQueueHealth(value.maintenance)
    : undefined
  return { workflow, maintenance }
}

/** Delayed and unavailable snapshots both deserve the Infrastructure dot. */
export function queueNeedsAttention(health: QueueHealth | null): boolean {
  return health === null
    || (health.oldestWaitingSeconds !== null
      && health.oldestWaitingSeconds > health.warnSeconds)
}

function QueueLagFrame({
  kind,
  state,
  message,
  announcement,
  checkedLabel,
}: {
  kind: 'workflow' | 'maintenance'
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
      data-testid={kind === 'workflow' ? 'queue-lag-chip' : 'maintenance-queue-lag-chip'}
    >
      <span
        className="we-sr-only"
        role="status"
        aria-label={`${t(kind === 'workflow'
          ? 'operations.queueLag.label'
          : 'operations.maintenanceQueueLag.label')}: ${announcement}`}
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
  unavailableReason = 'store',
  kind = 'workflow',
}: {
  health: QueueHealth | null
  checkedAt?: number | null
  unavailableReason?: QueueUnavailableReason
  kind?: 'workflow' | 'maintenance'
}) {
  const { t } = useT()
  const keys = kind === 'workflow'
    ? {
        clear: 'operations.queueLag.clear' as const,
        processingStatus: 'operations.queueLag.processingStatus' as const,
        delayedActiveStatus: 'operations.queueLag.delayedActiveStatus' as const,
        delayedIdleStatus: 'operations.queueLag.delayedIdleStatus' as const,
        processing: 'operations.queueLag.processing' as const,
        delayedActive: 'operations.queueLag.delayedActive' as const,
        delayedIdle: 'operations.queueLag.delayedIdle' as const,
        unavailableStore: 'operations.queueLag.unavailableStore' as const,
        unavailableTransport: 'operations.queueLag.unavailableTransport' as const,
      }
    : {
        clear: 'operations.maintenanceQueueLag.clear' as const,
        processingStatus: 'operations.maintenanceQueueLag.processingStatus' as const,
        delayedActiveStatus: 'operations.maintenanceQueueLag.delayedActiveStatus' as const,
        delayedIdleStatus: 'operations.maintenanceQueueLag.delayedIdleStatus' as const,
        processing: 'operations.maintenanceQueueLag.processing' as const,
        delayedActive: 'operations.maintenanceQueueLag.delayedActive' as const,
        delayedIdle: 'operations.maintenanceQueueLag.delayedIdle' as const,
        unavailableStore: 'operations.maintenanceQueueLag.unavailableStore' as const,
        unavailableTransport: 'operations.maintenanceQueueLag.unavailableTransport' as const,
      }
  const checkedLabel = typeof checkedAt === 'number'
    ? (t('operations.queueLag.checkedAt', {
        time: new Date(checkedAt).toLocaleTimeString(getResolvedLocale()),
      }))
    : null

  if (health === null) {
    const message = t(unavailableReason === 'store'
      ? keys.unavailableStore
      : keys.unavailableTransport)
    return (
      <QueueLagFrame
        kind={kind}
        state="unavailable"
        message={message}
        announcement={message}
        checkedLabel={checkedLabel}
      />
    )
  }

  if (health.waiting === 0) {
    const message = t(keys.clear)
    return (
      <QueueLagFrame
        kind={kind}
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
        ? keys.delayedActive
        : keys.delayedIdle
      : keys.processing,
    { count: health.waiting, duration },
  )
  return (
    <QueueLagFrame
      kind={kind}
      state={delayed ? 'delayed' : 'processing'}
      message={message}
      announcement={t(delayed
        ? health.active > 0
          ? keys.delayedActiveStatus
          : keys.delayedIdleStatus
        : keys.processingStatus)}
      checkedLabel={checkedLabel}
    />
  )
}
