import { useT } from '../i18n'
import type { WorkflowIntentBrief } from '../types'

/** Shared presentation keeps a registered example and the authoring brief identical. */
export function BriefFacts({ brief, details = false }: { brief: WorkflowIntentBrief; details?: boolean }) {
  const { t } = useT()
  const facts = details
    ? [['inputs', brief.inputs], ['effects', brief.externalEffects], ['approvals', brief.approvals], ['examples', brief.examples]] as const
    : [['objective', brief.objective], ['trigger', brief.trigger], ['outcome', brief.expectedOutcome], ['failurePolicy', brief.failurePolicy]] as const
  return <dl>{facts.map(([key, value]) => <div key={key}>
    <dt>{t(`aiStudio.brief.${key}`)}</dt><dd>{typeof value === 'string' ? value : value.join(', ') || t('common.none')}</dd>
  </div>)}</dl>
}
