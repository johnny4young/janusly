import { useT } from '../../i18n'
import { BrandMark } from '../BrandMark'
import type { AiStudioModel } from './useAiStudioController'

export function AiStudioHero({ model }: { model: AiStudioModel }) {
  const { t } = useT()
  const { health, briefCompilation, proposal, applied } = model
  const healthLabel = health?.enabled ? t('aiStudio.healthOn') : t('aiStudio.healthOff')
  const healthDetail = health?.enabled
    ? t('aiStudio.healthDetailOn', { model: health.model })
    : t('aiStudio.healthDetailOff')
  const authoringSteps = [
    { label: t('aiStudio.steps.intent'), complete: Boolean(briefCompilation?.complete) },
    { label: t('aiStudio.steps.binding'), complete: Boolean(proposal?.bindings.complete) },
    { label: t('aiStudio.steps.proposal'), complete: Boolean(proposal) },
    { label: t('aiStudio.steps.apply'), complete: applied },
  ]
  return (
    <>
      <section className="ai-studio-hero ai-studio-hero--branded">
        <div>
          <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-fallback'}>
            {healthLabel}
          </span>
          <h2>{t('aiStudio.heroTitle')}</h2>
          <p>{healthDetail}</p>
        </div>
        <BrandMark size={44} />
      </section>

      <ol className="ai-authoring-steps" aria-label={t('aiStudio.steps.aria')}>
        {authoringSteps.map((step, index) => (
          <li
            key={step.label}
            className={step.complete ? 'ai-authoring-step ai-authoring-step--complete' : 'ai-authoring-step'}
          >
            <span aria-hidden="true">{index + 1}</span>
            <strong>{step.label}</strong>
          </li>
        ))}
      </ol>
    </>
  )
}
