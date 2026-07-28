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
import { CheckCircle2, CircleAlert, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useT } from '../i18n'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { ValidationEvidenceLevel } from '../types'
import {
  TECHNICAL_AUTONOMY_FACTOR_IDS,
  TECHNICAL_AUTONOMY_FACTOR_REASONS,
  type TechnicalAutonomyFactor,
  type TechnicalRecoveryAutonomyAssessment,
} from '@janusly/shared/src/technical-recovery-autonomy'
import { ValidationEvidencePill } from './ValidationEvidencePill'

type PendingRow = {
  id: string
  signature: string
  approachLabel: string | null
  confidence: number | null
  deadLetterId: string
  validationEvidenceLevel: ValidationEvidenceLevel | null
  createdAt: string
  autonomyAssessment?: unknown
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

const FACTOR_IDS = new Set<string>(TECHNICAL_AUTONOMY_FACTOR_IDS)
const FACTOR_REASONS = new Set<string>(TECHNICAL_AUTONOMY_FACTOR_REASONS)

function isFactorValue(
  value: unknown,
): value is TechnicalAutonomyFactor['actual'] {
  return value == null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
}

function readAutonomyAssessment(
  value: unknown,
): TechnicalRecoveryAutonomyAssessment | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.eligible !== 'boolean'
    || !Array.isArray(record.factors)
    || record.factors.length !== FACTOR_IDS.size
    || !record.factors.every((factor) => {
      if (factor == null || typeof factor !== 'object' || Array.isArray(factor)) {
        return false
      }
      const item = factor as Record<string, unknown>
      return typeof item.id === 'string'
        && FACTOR_IDS.has(item.id)
        && typeof item.passed === 'boolean'
        && typeof item.reason === 'string'
        && FACTOR_REASONS.has(item.reason)
        && isFactorValue(item.actual)
        && isFactorValue(item.required)
    })
  ) {
    return null
  }
  const factorIds = new Set(
    record.factors.map((factor) => (
      factor as Record<string, unknown>
    ).id),
  )
  if (factorIds.size !== FACTOR_IDS.size) return null
  return value as TechnicalRecoveryAutonomyAssessment
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

  const formatAutonomyValue = (
    value: TechnicalAutonomyFactor['actual'],
  ): string => {
    if (value == null) return t('autoHealing.autonomy.value.unavailable')
    if (typeof value === 'boolean') {
      return value
        ? t('autoHealing.autonomy.value.ready')
        : t('autoHealing.autonomy.value.notReady')
    }
    if (typeof value === 'number') return String(value)
    if (value.includes(', ')) {
      return value
        .split(', ')
        .map((item) => formatAutonomyValue(item))
        .join(', ')
    }
    const localizedKey = `autoHealing.autonomy.value.${value}`
    const localized = t(localizedKey)
    return localized === localizedKey ? value : localized
  }

  const autonomyFactorValue = (
    factor: TechnicalAutonomyFactor,
  ): string => {
    const actual = formatAutonomyValue(factor.actual)
    const required = formatAutonomyValue(factor.required)
    if (factor.id === 'prior_recoveries') {
      return t('autoHealing.autonomy.factor.prior_recoveries.value', {
        actual,
        required,
      })
    }
    if (factor.id === 'blast_radius') {
      return t('autoHealing.autonomy.factor.blast_radius.value', {
        actual,
        required,
      })
    }
    if (factor.id === 'rollback' || factor.id === 'effect_receipts') {
      return actual
    }
    return t('autoHealing.autonomy.factor.value', { actual, required })
  }

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
            const riskAcknowledgementKey = evidenceLevel == null
              ? 'autoHealing.evidence.unknownAck'
              : 'autoHealing.evidence.writesSkippedAck'
            const autonomy = readAutonomyAssessment(row.autonomyAssessment)
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
                    {evidenceLevel == null ? (
                      <span className="we-pill" data-tone="warning">
                        {t('autoHealing.evidence.unknown')}
                      </span>
                    ) : (
                      <ValidationEvidencePill
                        level={evidenceLevel}
                        tone={requiresRiskAcknowledgement ? 'warning' : undefined}
                      />
                    )}
                  </div>
                  {autonomy ? (
                    <section
                      className="we-auto-healing-autonomy"
                      data-eligible={autonomy.eligible}
                      aria-label={t('autoHealing.autonomy.aria')}
                    >
                      <div className="we-auto-healing-autonomy__head">
                        <span className="we-auto-healing-autonomy__identity">
                          <span className="we-auto-healing-autonomy__icon">
                            {autonomy.eligible ? (
                              <ShieldCheck size={17} aria-hidden="true" />
                            ) : (
                              <ShieldAlert size={17} aria-hidden="true" />
                            )}
                          </span>
                          <span className="we-auto-healing-autonomy__copy">
                            <strong>{t('autoHealing.autonomy.title')}</strong>
                            <span>
                              {t(
                                autonomy.eligible
                                  ? 'autoHealing.autonomy.eligibleDescription'
                                  : 'autoHealing.autonomy.blockedDescription',
                              )}
                            </span>
                          </span>
                        </span>
                        <span
                          className="we-pill"
                          data-tone={autonomy.eligible ? 'success' : 'warning'}
                        >
                          {t(
                            autonomy.eligible
                              ? 'autoHealing.autonomy.eligible'
                              : 'autoHealing.autonomy.operatorRequired',
                          )}
                        </span>
                      </div>
                      <ul className="we-auto-healing-autonomy__grid">
                        {autonomy.factors.map((factor) => (
                          <li
                            key={factor.id}
                            className="we-auto-healing-autonomy__factor"
                            data-passed={factor.passed}
                          >
                            <span className="we-auto-healing-autonomy__factor-icon">
                              {factor.passed ? (
                                <CheckCircle2 size={15} aria-hidden="true" />
                              ) : (
                                <CircleAlert size={15} aria-hidden="true" />
                              )}
                            </span>
                            <span className="we-auto-healing-autonomy__factor-copy">
                              <strong>
                                {t(`autoHealing.autonomy.factor.${factor.id}`)}
                              </strong>
                              <span className="we-auto-healing-autonomy__factor-value">
                                {autonomyFactorValue(factor)}
                              </span>
                              {!factor.passed && (
                                <span className="we-auto-healing-autonomy__factor-reason">
                                  {t(`autoHealing.autonomy.reason.${factor.reason}`)}
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : (
                    <div
                      className="we-auto-healing-autonomy"
                      data-eligible="false"
                      role="status"
                    >
                      <div className="we-auto-healing-autonomy__head">
                        <span className="we-auto-healing-autonomy__identity">
                          <span className="we-auto-healing-autonomy__icon">
                            <ShieldAlert size={17} aria-hidden="true" />
                          </span>
                          <span className="we-auto-healing-autonomy__copy">
                            <strong>{t('autoHealing.autonomy.title')}</strong>
                            <span>{t('autoHealing.autonomy.unavailable')}</span>
                          </span>
                        </span>
                        <span className="we-pill" data-tone="warning">
                          {t('autoHealing.autonomy.operatorRequired')}
                        </span>
                      </div>
                    </div>
                  )}
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
