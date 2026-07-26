/**
 * Operator-facing card that surfaces validated auto-healing
 * suggestions awaiting a decision. Mounted inside the DLQ panel
 * alongside the failure-clusters card.
 *
 * Reads `GET /auto-healing/pending` once at mount and on every
 * `platformVersion` bump. Each row shows the cluster signature, the
 * LLM's `approachLabel` chip, confidence, and Apply / Decline
 * buttons. Mutation buttons call `bumpPlatformVersion()` so the rest
 * of the Recovery Center refetches.
 *
 * Empty state has two sub-states:
 *   - tenant flag OFF → "auto-healing is disabled" copy with a hint.
 *   - tenant flag ON, no candidates → "no pending decisions yet" copy.
 *
 * The card silently hides when the user's role lacks
 * `autohealing.read` (the GET returns 403 in that case; we catch +
 * hide instead of rendering an error).
 */

import { useCallback, useEffect, useState } from 'react'
import { useT } from '../i18n'
import { api } from '../api'
import { useWorkflowStore } from '../store'

type PendingRow = {
  id: string
  signature: string
  approachLabel: string | null
  confidence: number | null
  deadLetterId: string
  createdAt: string
}

type PendingResponse = { rows: PendingRow[] }

const APPROACH_LABEL_KEY: Record<string, string> = {
  add_retry: 'autoHealing.approach.add_retry',
  raise_timeout: 'autoHealing.approach.raise_timeout',
  swap_secret_ref: 'autoHealing.approach.swap_secret_ref',
  add_approval: 'autoHealing.approach.add_approval',
  fix_url: 'autoHealing.approach.fix_url',
  other: 'autoHealing.approach.other',
}

export function AutoHealingPendingCard({ canDecide = true }: { canDecide?: boolean }) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const [rows, setRows] = useState<PendingRow[] | null>(null)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const resp = (await api('/auto-healing/pending')) as PendingResponse
      setRows(resp.rows ?? [])
      setError(null)
    } catch (err) {
      // 403 (permission denied) — hide the card silently so non-readers
      // don't see an error banner for a feature they can't use.
      const status = (err as { status?: number }).status
      if (status === 403) {
        setHidden(true)
        return
      }
      setError(err instanceof Error ? err.message : t('autoHealing.error.load'))
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load, platformVersion])

  const decide = async (id: string, accepted: boolean) => {
    if (busy) return
    setBusy(id)
    try {
      await api(`/auto-healing/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        body: JSON.stringify({ accepted }),
        headers: { 'content-type': 'application/json' },
      })
      bumpPlatformVersion()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('autoHealing.error.decide'))
    } finally {
      setBusy(null)
    }
  }

  if (hidden) return null

  return (
    <section className="we-card">
      <div className="section-kicker">{t('autoHealing.card.kicker')}</div>
      <h3 className="we-card__title">{t('autoHealing.card.title')}</h3>
      <p className="we-card__subtitle">{t('autoHealing.card.subtitle')}</p>

      {error && <div className="we-card__error">{error}</div>}

      {rows === null && !error && (
        <div className="we-card__empty">{t('autoHealing.card.loading')}</div>
      )}

      {rows && rows.length === 0 && (
        <div className="we-card__empty">{t('autoHealing.card.empty')}</div>
      )}

      {rows && rows.length > 0 && (
        <ul className="we-card__list">
          {rows.map((row) => {
            const approachKey = row.approachLabel
              ? APPROACH_LABEL_KEY[row.approachLabel] ?? 'autoHealing.approach.other'
              : 'autoHealing.approach.other'
            return (
              <li key={row.id} className="we-card__list-item">
                <div className="we-card__list-item-main">
                  <strong>{row.signature}</strong>
                  <div className="we-card__list-item-meta">
                    <span className="chip">{t(approachKey)}</span>
                    {row.confidence != null && (
                      <span className="chip chip--muted">
                        {t('autoHealing.confidence', { value: row.confidence })}
                      </span>
                    )}
                  </div>
                </div>
                {canDecide && <div className="we-card__list-item-actions">
                  <button
                    type="button"
                    className="small-command small-command--primary"
                    disabled={busy === row.id}
                    onClick={() => void decide(row.id, true)}
                  >
                    {t('autoHealing.action.apply')}
                  </button>
                  <button
                    type="button"
                    className="small-command"
                    disabled={busy === row.id}
                    onClick={() => void decide(row.id, false)}
                  >
                    {t('autoHealing.action.decline')}
                  </button>
                </div>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
