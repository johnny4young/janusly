import { useEffect, useState } from 'react'
import type { RecoveryItemDrawerData } from '../RecoveryItemDrawer'
import { api } from '../../api'
import { getResolvedLocale, useT } from '../../i18n'
import { Button } from '../ui/Button'

type OccurrenceChild = { id: string; deadLetterId: string; occurredAt: string }

/** Compact relative-time label (narrow, locale-aware) for occurrence timestamps. */
function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime()
  if (Number.isNaN(ts)) return ''
  const deltaMin = Math.round((ts - Date.now()) / 60_000)
  const abs = Math.abs(deltaMin)
  const rtf = new Intl.RelativeTimeFormat(getResolvedLocale(), { numeric: 'auto', style: 'narrow' })
  if (abs < 60) return rtf.format(deltaMin, 'minute')
  if (abs < 60 * 24) return rtf.format(Math.round(deltaMin / 60), 'hour')
  return rtf.format(Math.round(deltaMin / 60 / 24), 'day')
}

// The storm drawer: how often this item recurred, with the child dead
// letters fetched lazily on first expand so the round trip only happens
// for storms the operator chooses to inspect.
export function RecoveryOccurrences({ item }: { item: RecoveryItemDrawerData }) {
  const { t } = useT()
  // Child-occurrence drawer (debounce). Lazy-fetched on first expand so the
  // network round-trip only happens for storms the operator chooses to inspect.
  const [occurrencesOpen, setOccurrencesOpen] = useState(false)
  const [children, setChildren] = useState<OccurrenceChild[] | null>(null)
  const [childrenError, setChildrenError] = useState(false)

  useEffect(() => {
    if (!occurrencesOpen || children !== null) return
    let cancelled = false
    api(`/recovery/items/${item.id}/children`)
      .then((resp) => {
        const envelope = resp && typeof resp === 'object' && !Array.isArray(resp)
          ? resp as { children?: unknown }
          : undefined
        if (!cancelled) setChildren(Array.isArray(envelope?.children) ? envelope.children as OccurrenceChild[] : [])
      })
      .catch(() => {
        if (!cancelled) setChildrenError(true)
      })
    return () => {
      cancelled = true
    }
  }, [occurrencesOpen, children, item.id])
  if (item.occurrenceCount <= 1) return null
  return (
        <div className="we-recovery-occurrences" data-testid="recovery-item-occurrences-section">
          <div className="we-recovery-occurrences__summary">
            <span className="we-pill" data-tone="warning" data-testid="recovery-item-occurrences-badge">
              {t('recoveryItems.occurrences.badge', { count: item.occurrenceCount })}
            </span>
            <span className="we-recovery-occurrences__lastseen">
              {t('recoveryItems.occurrences.lastSeen', { when: formatRelativeTime(item.lastOccurredAtIso) })}
            </span>
            <Button variant="ghost" size="sm"
              type="button"

              onClick={() => setOccurrencesOpen((v) => !v)}
              aria-expanded={occurrencesOpen}
              aria-busy={occurrencesOpen && children === null && !childrenError}
              data-testid="recovery-item-occurrences-toggle"
            >
              {t(occurrencesOpen ? 'recoveryItems.occurrences.hide' : 'recoveryItems.occurrences.show')}
            </Button>
          </div>
          {occurrencesOpen && (
            <div
              className="we-recovery-occurrences__list"
              data-testid="recovery-item-occurrences-list"
              aria-live="polite"
            >
              {childrenError ? (
                <p className="we-recovery-occurrences__empty">{t('recoveryItems.occurrences.loadError')}</p>
              ) : children === null ? (
                <p className="we-recovery-occurrences__empty">{t('common.loading')}</p>
              ) : children.length === 0 ? (
                <p className="we-recovery-occurrences__empty">{t('recoveryItems.occurrences.empty')}</p>
              ) : (
                <ul>
                  {children.map((c) => (
                    <li
                      key={c.id}
                      className="we-recovery-occurrences__entry"
                      aria-label={
                        t('recoveryItems.occurrences.entryAria', {
                          id: c.deadLetterId,
                          when: formatRelativeTime(c.occurredAt),
                        })
                      }
                    >
                      <code>{c.deadLetterId}</code>
                      <span>{new Date(c.occurredAt).toLocaleString(getResolvedLocale())}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
  )
}
