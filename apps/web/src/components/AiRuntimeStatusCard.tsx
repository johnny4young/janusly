import { useT } from '../i18n'
import type { AiHealth } from '../types'

export function AiRuntimeStatusCard({ health }: { health: AiHealth | null }) {
  const { t } = useT()
  const ready = health?.enabled === true
  const unavailable = health === null
  return (
    <section className="we-card" aria-labelledby="ai-runtime-heading">
      <div className="we-card__header">
        <strong id="ai-runtime-heading">{t('operations.section.ai.label')}</strong>
        <span className="we-pill" data-tone={ready ? 'success' : 'neutral'}>
          {t(unavailable
            ? 'badges.health.unavailable'
            : ready
              ? 'aiCopilot.healthOn'
              : 'aiCopilot.healthOff')}
        </span>
      </div>
      {!unavailable && (
        <p className="helper-text">
          {ready
            ? t('aiCopilot.healthDetailOn', { model: health.model })
            : t('aiCopilot.healthDetailOff')}
        </p>
      )}
    </section>
  )
}
