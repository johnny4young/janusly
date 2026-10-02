import type { AuthoringExperienceDecision } from '../../lib/api-types.generated'
import { useT } from '../../i18n'

/** A rules receipt is provenance for review, not approval or outcome evidence. */
export function ExperienceReview({ decision }: { decision: AuthoringExperienceDecision }) {
  const { t } = useT()
  return <div className="ai-brief-summary" data-testid="experience-review">
    <strong>{t(`aiStudio.experience.mode.${decision.mode}`)}</strong>
    <p>{t(`aiStudio.experience.reason.${decision.reason}`)}</p>
    <dl>
      <div><dt>{t('aiStudio.experience.policy')}</dt><dd>{decision.policyVersion}</dd></div>
      {decision.source && <>
        <div><dt>{t('aiStudio.experience.source')}</dt><dd>{decision.source.workflowId}</dd></div>
        <div><dt>{t('versionHistory.experience.version')}</dt><dd>{t('versionHistory.experience.source', decision.source)}</dd></div>
      </>}
      {decision.mode === 'ADAPT' && <div><dt>{t('aiStudio.experience.name')}</dt><dd>{decision.edits[0].value}</dd></div>}
    </dl>
    <p>{t('versionHistory.experience.unknown')}</p>
  </div>
}
