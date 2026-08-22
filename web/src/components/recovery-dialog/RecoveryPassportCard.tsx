/**
 * Deterministic recovery decision card. It explains the facts that govern
 * whether a suggested patch is ready for production; model confidence is
 * shown as one signal but never participates in the verdict calculation.
 */

import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  evaluateRecoveryPassport,
  type RecoverySandboxStatus,
} from '@/lib/recovery-passport'
import { getResolvedLocale, useT } from '../../i18n'
import { resolvePlaybookScorecard } from './playbook-scorecard'
import type { DeadLetter } from '../dead-letter-types'
import type { PatchSuggestion, SuggestionTab } from './types'

export function RecoveryPassportCard({
  dlq,
  suggestion,
  selected,
  actionable,
  sandboxStatus,
  failureSignature,
}: {
  dlq: DeadLetter
  suggestion: PatchSuggestion
  selected: SuggestionTab
  actionable: boolean
  sandboxStatus: RecoverySandboxStatus
  failureSignature: string
}) {
  const { t } = useT()
  const evidence = suggestion.evidence ?? []
  const evaluation = evaluateRecoveryPassport({
    suggestionMode: suggestion.mode,
    actionable,
    safety: selected.safety,
    evidenceCount: evidence.length,
    sandboxStatus,
  })
  const signature = suggestion.recoveryPassport?.failureSignature ?? failureSignature
  const prior = suggestion.recoveryPassport?.priorSameSignatureOutcome ?? null
  // Debounce folds every occurrence of one signature into a single
  // incident, which is linked to just one of the dead letters. Defaulting
  // the siblings to 1 asserted a blast radius the runtime never measured —
  // on the screen whose whole job is to size the impact before acting. An
  // unknown count is shown as unknown.
  const occurrenceCount = dlq.recovery?.occurrenceCount ?? null
  const evidenceKinds = new Set(evidence.map((row) => row.kind)).size
  const confidence = selected.calibratedConfidence ?? selected.confidence
  const VerdictIcon = evaluation.verdict === 'safe_to_apply'
    ? ShieldCheck
    : evaluation.verdict === 'unsafe'
      ? ShieldAlert
      : AlertTriangle

  return (
    <section
      className="we-recovery-passport"
      data-verdict={evaluation.verdict}
      data-testid="recovery-confidence-passport"
      aria-labelledby="recovery-passport-title"
    >
      <header className="we-recovery-passport__header">
        <span className="we-recovery-passport__icon" aria-hidden="true"><VerdictIcon size={17} /></span>
        <div>
          <div className="section-kicker">{t('recoveryDialog.passport.kicker')}</div>
          <strong id="recovery-passport-title">
            {t(`recoveryDialog.passport.verdict.${evaluation.verdict}`)}
          </strong>
        </div>
      </header>

      <dl className="we-recovery-passport__facts">
        <div>
          <dt>{t('recoveryDialog.passport.failure')}</dt>
          <dd>
            <code>{signature}</code>
            {occurrenceCount !== null && ` · ${t('recoveryDialog.passport.occurrences', { count: occurrenceCount })}`}
          </dd>
        </div>
        <div>
          <dt>{t('recoveryDialog.passport.suspectVersion')}</dt>
          <dd>{dlq.suspectVersion
            ? t('recoveryDialog.passport.versionValue', { version: dlq.suspectVersion.version })
            : t('recoveryDialog.passport.none')}</dd>
        </div>
        <div>
          <dt>{t('recoveryDialog.passport.risk')}</dt>
          <dd>{selected.safety
            ? t(selected.safety.writeSide ? 'recoveryDialog.passport.writeSide' : 'recoveryDialog.passport.readSide')
            : t('recoveryDialog.passport.unknown')}</dd>
        </div>
        <div>
          <dt>{t('recoveryDialog.passport.approval')}</dt>
          <dd>{selected.safety?.approvalRequired
            ? t(selected.safety.approvalPresent ? 'recoveryDialog.passport.approvalPresent' : 'recoveryDialog.passport.approvalMissing')
            : t('recoveryDialog.passport.notRequired')}</dd>
        </div>
        <div>
          <dt>{t('recoveryDialog.passport.sandbox')}</dt>
          <dd>{t(`recoveryDialog.passport.sandbox.${sandboxStatus}`)}</dd>
        </div>
        <div>
          <dt>{t('recoveryDialog.passport.evidence')}</dt>
          <dd>{t('recoveryDialog.passport.evidenceValue', { count: evidence.length, kinds: evidenceKinds })}</dd>
        </div>
        <div>
          <dt>{t('recoveryDialog.passport.priorOutcome')}</dt>
          <dd>{prior
            ? t('recoveryDialog.passport.priorOutcomeValue', {
                status: prior.status,
                date: new Date(prior.occurredAt).toLocaleDateString(getResolvedLocale()),
              })
            : t('recoveryDialog.passport.none')}</dd>
        </div>
        <div>
          <dt>{t(suggestion.mode === 'playbook' ? 'recoveryDialog.passport.playbookSignal' : 'recoveryDialog.passport.aiSignal')}</dt>
          <dd>{suggestion.mode === 'playbook' && suggestion.playbook
            ? (() => {
                const scorecard = resolvePlaybookScorecard(suggestion.playbook.successfulUses, suggestion.playbook.regressions)
                return scorecard.ratePercent !== null
                  ? t('recoveryDialog.passport.playbookSignalValueRated', {
                      version: suggestion.playbook.version,
                      percent: scorecard.ratePercent,
                      total: scorecard.total,
                    })
                  : t('recoveryDialog.passport.playbookSignalValue', {
                      version: suggestion.playbook.version,
                      count: suggestion.playbook.successfulUses,
                    })
              })()
            : t('recoveryDialog.passport.aiSignalValue', { confidence })}</dd>
        </div>
      </dl>

      <ul className="we-recovery-passport__factors" aria-label={t('recoveryDialog.passport.factorsAria')}>
        {evaluation.factors.map((factor) => (
          <li key={factor.id} data-status={factor.status}>
            <span className="we-recovery-passport__factor-indicator" aria-hidden="true" />
            <span className="we-recovery-passport__factor-copy">
              <strong>{t(`recoveryDialog.passport.factor.${factor.id}`)}</strong>
              <small>
                {factor.reason
                  ? t(`recoveryDialog.passport.reason.${factor.reason}`)
                  : t('recoveryDialog.passport.factorReady')}
              </small>
            </span>
            <span className="we-pill" data-tone={
              factor.status === 'pass'
                ? 'success'
                : factor.status === 'block'
                  ? 'danger'
                  : 'warning'
            }>
              {t(`recoveryDialog.passport.factorStatus.${factor.status}`)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
