/**
 * Visual badge surfaced inside `DeadLettersPanel` rows: owner avatar +
 * severity pill (cobalt p4 → red p1) + status chip + SLA timer color
 * band. Operator-clickable: parent passes `onOpen()` to wire the drawer.
 *
 * Renders nothing when `item` is null — DLQ rows without a recovery
 * item (legacy tenants with `recovery.autoCreateItems: false`) keep
 * the unbadged row shape without an owner / severity chip.
 */

import React from 'react'
import { Clock, User } from 'lucide-react'
import type {
  RecoveryItemSeverity,
  RecoveryItemStatus,
} from '@janusly/shared/src/recovery-item'
import { getResolvedLocale, useT } from '../i18n'

export type RecoveryItemBadgeData = {
  id: string
  owner: string | null
  severity: RecoveryItemSeverity
  status: RecoveryItemStatus
  slaTargetAtIso: string
}

type Props = {
  item: RecoveryItemBadgeData | null
  onOpen?: () => void
}

const SEVERITY_TONE: Record<RecoveryItemSeverity, string> = {
  p1: 'red',
  p2: 'amber',
  p3: 'cobalt',
  p4: 'neutral',
}

function slaTone(slaTargetAtIso: string, status: RecoveryItemStatus): 'green' | 'amber' | 'red' | 'neutral' {
  if (status === 'resolved') return 'neutral'
  const target = new Date(slaTargetAtIso).getTime()
  if (Number.isNaN(target)) return 'neutral'
  const now = Date.now()
  if (now >= target) return 'red'
  const remaining = target - now
  // Tone bands are pragmatic — operators care about "do I have time".
  // 1h or less left → red, 4h or less → amber, otherwise green.
  if (remaining <= 60 * 60 * 1_000) return 'red'
  if (remaining <= 4 * 60 * 60 * 1_000) return 'amber'
  return 'green'
}

function formatRemaining(slaTargetAtIso: string, status: RecoveryItemStatus): string {
  if (status === 'resolved') return ''
  const target = new Date(slaTargetAtIso).getTime()
  if (Number.isNaN(target)) return ''
  const delta = target - Date.now()
  const minutes = Math.round(delta / 60_000)
  const absMinutes = Math.abs(minutes)
  const rtf = new Intl.RelativeTimeFormat(getResolvedLocale(), { numeric: 'always', style: 'narrow' })
  if (absMinutes < 60) return rtf.format(minutes, 'minute')
  if (absMinutes < 60 * 24) return rtf.format(Math.round(minutes / 60), 'hour')
  return rtf.format(Math.round(minutes / 60 / 24), 'day')
}

export function RecoveryItemBadge({ item, onOpen }: Props): React.ReactElement | null {
  const { t } = useT()
  if (!item) return null
  const severityTone = SEVERITY_TONE[item.severity]
  const slaToneClass = slaTone(item.slaTargetAtIso, item.status)
  const remaining = formatRemaining(item.slaTargetAtIso, item.status)

  return (
    <button
      type="button"
      className="we-recovery-item-badge"
      data-testid="recovery-item-badge"
      data-severity={item.severity}
      data-status={item.status}
      onClick={onOpen}
      aria-label={t('recoveryItems.badge.open', { severity: item.severity, status: item.status })}
    >
      <span
        className={`we-pill we-pill--${severityTone}`}
        data-testid="recovery-item-severity"
      >
        {t(`recoveryItems.severity.${item.severity}`)}
      </span>
      <span
        className="we-pill we-pill--neutral"
        data-testid="recovery-item-status"
      >
        {t(`recoveryItems.status.${item.status}`)}
      </span>
      {item.owner && (
        <span className="we-recovery-item-badge__owner" title={item.owner}>
          <User size={12} aria-hidden /> {item.owner}
        </span>
      )}
      {remaining && (
        <span
          className={`we-recovery-item-badge__sla we-recovery-item-badge__sla--${slaToneClass}`}
          data-testid="recovery-item-sla"
          data-tone={slaToneClass}
        >
          <Clock size={12} aria-hidden /> {remaining}
        </span>
      )}
    </button>
  )
}
