import { Check } from 'lucide-react'
import { useT } from '../../i18n'
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
  const currentIndex = authoringSteps.findIndex((step) => !step.complete)
  return (
    <section className="ai-studio-hero">
      <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-fallback'}>
        {healthLabel}
      </span>
      <h2>{t('aiStudio.heroTitle')}</h2>
      <p>{healthDetail}</p>
      <ol className="ai-authoring-steps" aria-label={t('aiStudio.steps.aria')} data-testid="ai-authoring-steps">
        {authoringSteps.map((step, index) => (
          <li
            key={step.label}
            className="ai-authoring-step"
            data-complete={step.complete || undefined}
            aria-current={index === currentIndex ? 'step' : undefined}
          >
            <span aria-hidden="true">{step.complete ? <Check size={12} /> : index + 1}</span>
            <strong>{step.label}</strong>
          </li>
        ))}
      </ol>
    </section>
  )
}
