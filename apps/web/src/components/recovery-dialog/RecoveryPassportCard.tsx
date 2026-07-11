/**
 * Deterministic recovery decision card. It explains the facts that govern
 * whether a suggested patch is ready for production; model confidence is
 * shown as one signal but never participates in the verdict calculation.
 */

import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react'
import { getResolvedLocale, useT } from '../../i18n'
import type { DeadLetter } from '../DeadLettersPanel'
import { evaluateRecoveryPassport, type RecoverySandboxStatus } from './recovery-passport'
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
  const occurrenceCount = dlq.recovery?.occurrenceCount ?? 1
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
            {t(`recoveryDialog.passport.verdict.${evaluation.verdict}` as never) as string}
          </strong>
        </div>
      </header>

      <dl className="we-recovery-passport__facts">
        <div>
          <dt>{t('recoveryDialog.passport.failure')}</dt>
          <dd><code>{signature}</code> · {t('recoveryDialog.passport.occurrences', { count: occurrenceCount })}</dd>
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
          <dd>{t(`recoveryDialog.passport.sandbox.${sandboxStatus}` as never) as string}</dd>
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
          <dt>{t('recoveryDialog.passport.aiSignal')}</dt>
          <dd>{t('recoveryDialog.passport.aiSignalValue', { confidence })}</dd>
        </div>
      </dl>

      <ul className="we-recovery-passport__reasons" aria-label={t('recoveryDialog.passport.reasonsAria') as string}>
        {evaluation.reasons.map((reason) => (
          <li key={reason}>{t(`recoveryDialog.passport.reason.${reason}` as never) as string}</li>
        ))}
      </ul>
    </section>
  )
}
