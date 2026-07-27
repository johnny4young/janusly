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
import type { ValidationEvidenceLevel } from '../types'

type PendingRow = {
  id: string
  signature: string
  approachLabel: string | null
  confidence: number | null
  deadLetterId: string
  validationEvidenceLevel: ValidationEvidenceLevel | null
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

const EVIDENCE_LABEL_KEY: Record<NonNullable<PendingRow['validationEvidenceLevel']>, string> = {
  static: 'autoHealing.evidence.static',
  writes_skipped: 'autoHealing.evidence.writes_skipped',
  provider_simulated: 'autoHealing.evidence.provider_simulated',
  live_canary: 'autoHealing.evidence.live_canary',
}

export function AutoHealingPendingCard({ canDecide = true }: { canDecide?: boolean }) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const [rows, setRows] = useState<PendingRow[] | null>(null)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [riskAcknowledged, setRiskAcknowledged] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
    setNotice(null)
    try {
      const result = await api(`/auto-healing/${encodeURIComponent(id)}/decide`, {
        method: 'POST',
        body: JSON.stringify({
          accepted,
          acknowledgeValidationRisk: accepted && riskAcknowledged[id] === true,
        }),
        headers: { 'content-type': 'application/json' },
      }) as { status?: 'applied' | 'pending' }
      if (accepted && result.status === 'pending') {
        setNotice(t('autoHealing.publicationPending'))
      }
      bumpPlatformVersion()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('autoHealing.error.decide'))
    } finally {
      setBusy(null)
    }
  }

  if (hidden) return null

  return (
    <section className="we-card" data-testid="auto-healing-pending-card">
      <div className="section-kicker">{t('autoHealing.card.kicker')}</div>
      <h3 className="we-card__title">{t('autoHealing.card.title')}</h3>
      <p className="we-card__subtitle">{t('autoHealing.card.subtitle')}</p>

      {error && <div className="we-card__error">{error}</div>}
      {notice && (
        <div className="we-recovery-warning" role="status" aria-live="polite">
          {notice}
        </div>
      )}

      {rows === null && !error && (
        <div className="we-card__empty">{t('autoHealing.card.loading')}</div>
      )}

      {rows && rows.length === 0 && (
        <div className="we-card__empty">{t('autoHealing.card.empty')}</div>
      )}

      {rows && rows.length > 0 && (
        <ul className="we-auto-healing__list">
          {rows.map((row) => {
            const approachKey = row.approachLabel
              ? APPROACH_LABEL_KEY[row.approachLabel] ?? 'autoHealing.approach.other'
              : 'autoHealing.approach.other'
            const evidenceLevel = row.validationEvidenceLevel
            const requiresRiskAcknowledgement = (
              evidenceLevel == null || evidenceLevel === 'writes_skipped'
            )
            const evidenceLabelKey = evidenceLevel == null
              ? 'autoHealing.evidence.unknown'
              : EVIDENCE_LABEL_KEY[evidenceLevel]
            const riskAcknowledgementKey = evidenceLevel == null
              ? 'autoHealing.evidence.unknownAck'
              : 'autoHealing.evidence.writesSkippedAck'
            return (
              <li key={row.id} className="we-auto-healing__item">
                <div className="we-auto-healing__main">
                  <strong className="we-auto-healing__signature">{row.signature}</strong>
                  <div className="we-auto-healing__meta">
                    <span className="we-pill" data-tone="neutral">{t(approachKey)}</span>
                    {row.confidence != null && (
                      <span className="we-pill" data-tone="neutral">
                        {t('autoHealing.confidence', { value: row.confidence })}
                      </span>
                    )}
                    <span
                      className="we-pill"
                      data-tone={requiresRiskAcknowledgement ? 'warning' : 'neutral'}
                    >
                      {t(evidenceLabelKey)}
                    </span>
                  </div>
                  {requiresRiskAcknowledgement && canDecide && (
                    <label className="we-auto-healing__risk">
                      <input
                        type="checkbox"
                        checked={riskAcknowledged[row.id] === true}
                        onChange={(event) => setRiskAcknowledged((current) => ({
                          ...current,
                          [row.id]: event.target.checked,
                        }))}
                      />
                      <span>{t(riskAcknowledgementKey)}</span>
                    </label>
                  )}
                </div>
                {canDecide && <div className="we-auto-healing__actions">
                  <button
                    type="button"
                    className="small-command small-command--primary"
                    disabled={
                      busy === row.id
                      || (requiresRiskAcknowledgement && riskAcknowledged[row.id] !== true)
                    }
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
