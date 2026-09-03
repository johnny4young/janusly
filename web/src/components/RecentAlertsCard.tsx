/**
 * Recent-alerts feed inside `OperationsPage`. Polls
 * `GET /alerts/recent` on `platformVersion` cadence and renders the last
 * 50 dispatches with per-row severity tint (cobalt = delivered, amber =
 * delivery_failed).
 *
 * Per-row expand reveals `triggerPayload` + `channelResults` as a
 * <details> block; the server already scrubs secret-shaped values
 * (`scrubSecretShapes` inside `composeAlertMessage`) so this is just
 * pretty-printing.
 */

import React, { useEffect, useState } from 'react'
import { LoadingSkeleton } from './LoadingSkeleton'
import { Bell, BellOff } from 'lucide-react'
import { api } from '../api'
import { EmptyState } from './EmptyState'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, useT } from '../i18n'

type AlertDispatch = {
  id: string
  policyId: string
  policyName: string | null
  trigger: string | null
  outcome: 'delivered' | 'delivery_failed'
  dispatchedAt: string
  channelResults: {
    destination: string
    credentialName: string
    ok: boolean
    statusCode?: number | null
    error?: string | null
  }[]
  triggerPayload: Record<string, unknown>
}

function relativeTime(iso: string, locale: string): string {
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return iso
  const deltaSeconds = Math.round((ts - Date.now()) / 1000)
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const absSeconds = Math.abs(deltaSeconds)
  if (absSeconds < 60) return fmt.format(deltaSeconds, 'second')
  const minutes = Math.round(deltaSeconds / 60)
  if (Math.abs(minutes) < 60) return fmt.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return fmt.format(hours, 'hour')
  const days = Math.round(hours / 24)
  return fmt.format(days, 'day')
}

export function RecentAlertsCard(): React.ReactElement {
  const { t } = useT()
  const locale = getResolvedLocale()
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  const [items, setItems] = useState<AlertDispatch[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api('/alerts/recent?limit=50')
      .then((resp) => {
        if (cancelled) return
        const envelope = resp && typeof resp === 'object' && !Array.isArray(resp)
          ? resp as { items?: unknown }
          : undefined
        setItems(Array.isArray(envelope?.items) ? envelope.items as AlertDispatch[] : [])
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          setItems([])
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [platformVersion])

  const cardSeverity: 'warning' | undefined = items.some(
    (item) => item.outcome === 'delivery_failed',
  )
    ? 'warning'
    : undefined

  return (
    <section
      className="we-card we-recent-alerts"
      data-severity={cardSeverity}
      aria-label={t('alerts.recent.title')}
    >
      <div className="we-card__header">
        <h3>
          <Bell size={16} aria-hidden /> {t('alerts.recent.title')}
        </h3>
      </div>
      <div className="we-recent-alerts__list" data-testid="recent-alerts-list">
        {loading && <LoadingSkeleton rows={3} label={t('common.loading')} />}
        {!loading && items.length === 0 && (
          <EmptyState
            icon={<BellOff />}
            kicker={t('emptyState.alerts.kicker')}
            body={t('emptyState.alerts.body')}
            testId="recent-alerts-empty"
          />
        )}
        {!loading &&
          items.map((item) => (
            <div
              key={item.id}
              className={`we-list-row we-list-row--${item.outcome === 'delivered' ? 'healthy' : 'warn'}`}
              data-testid="recent-alert-row"
              data-outcome={item.outcome}
            >
              <div className="we-list-row__main">
                <strong>{item.policyName ?? t('alerts.recent.unknownPolicy')}</strong>
                {item.trigger && (
                  <span className="we-pill" data-tone="neutral">
                    {t(`alerts.triggers.${item.trigger}`)}
                  </span>
                )}
                <span className="we-pill" data-tone="neutral">
                  {t(`alerts.outcomes.${item.outcome}`)}
                </span>
                <span className="we-list-row__hint">{relativeTime(item.dispatchedAt, locale)}</span>
              </div>
              {item.channelResults.length > 0 && (
                <details>
                  <summary>{t('alerts.recent.details')}</summary>
                  <ul>
                    {item.channelResults.map((c, idx) => (
                      <li key={idx}>
                        <strong>{c.destination}</strong>
                        <span>{c.credentialName}</span>
                        <span>
                          {c.ok
                            ? t('alerts.recent.channelDelivered')
                            : t('alerts.recent.channelFailed')}
                        </span>
                        {c.statusCode ? <span>{c.statusCode}</span> : null}
                        {c.error ? <span>{c.error}</span> : null}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
      </div>
    </section>
  )
}
