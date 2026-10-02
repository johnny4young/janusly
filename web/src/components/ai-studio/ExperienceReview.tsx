import type { AuthoringExperienceDecision } from '../../lib/api-types.generated'
import { useT } from '../../i18n'

/** A rules receipt is provenance for review, not approval or outcome evidence. */
export function ExperienceReview({ decision }: { decision: AuthoringExperienceDecision }) {
  const { t } = useT()
  const facts: Array<readonly [string, string]> = [['aiStudio.experience.policy', decision.policyVersion]]
  if (decision.source) facts.push(
    ['aiStudio.experience.source', decision.source.workflowId],
    ['versionHistory.experience.version', t('versionHistory.experience.source', decision.source)],
  )
  if (decision.mode === 'ADAPT') facts.push(['aiStudio.experience.name', decision.edits[0].value])
  return <div className="ai-brief-summary" data-testid="experience-review">
    <strong>{t(`aiStudio.experience.mode.${decision.mode}`)}</strong>
    <p>{t(`aiStudio.experience.reason.${decision.reason}`)}</p>
    <dl>{facts.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}</dl>
    <p>{t('versionHistory.experience.unknown')}</p>
  </div>
}
