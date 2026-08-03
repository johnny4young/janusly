/**
 * HealthRing — small SVG donut visualization for the Recovery Center hero.
 *
 * Colour reflects the health band (`healthBand` from `./helpers`): cobalt
 * ≥80, amber 60-79, red <60. The count-up animation honours
 * `prefers-reduced-motion` via the shared hooks in `../../hooks/`.
 *
 * Used by `./RecoveryCenterHero.tsx`.
 */

import { useT } from '../../i18n'
import { useAnimatedNumber } from '../../hooks/useAnimatedNumber'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'
import { healthBand } from './recovery-center-model'

const HEALTH_RING_SIZE = 96
const HEALTH_RING_STROKE = 9
const HEALTH_RING_CIRCUMFERENCE = 2 * Math.PI * ((HEALTH_RING_SIZE - HEALTH_RING_STROKE) / 2)

export function HealthRing({ score }: { score: number | null }) {
  const { t } = useT()
  const band = healthBand(score)
  const reducedMotion = usePrefersReducedMotion()
  const target = score ?? 0
  const animated = useAnimatedNumber(target, 800, reducedMotion)
  const ratio = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100
  const dashoffset = HEALTH_RING_CIRCUMFERENCE * (1 - ratio)
  const radius = (HEALTH_RING_SIZE - HEALTH_RING_STROKE) / 2
  const ariaLabel = score === null
    ? t('recoveryCenter.healthRing.aria.pending')
    : t('recoveryCenter.healthRing.aria.value', { score })
  return (
    <div className="we-recovery-center-ring" data-band={band} aria-label={ariaLabel}>
      <svg width={HEALTH_RING_SIZE} height={HEALTH_RING_SIZE} viewBox={`0 0 ${HEALTH_RING_SIZE} ${HEALTH_RING_SIZE}`} role="img" aria-hidden="true">
        <circle
          cx={HEALTH_RING_SIZE / 2}
          cy={HEALTH_RING_SIZE / 2}
          r={radius}
          className="we-recovery-center-ring__track"
          strokeWidth={HEALTH_RING_STROKE}
          fill="none"
        />
        <circle
          cx={HEALTH_RING_SIZE / 2}
          cy={HEALTH_RING_SIZE / 2}
          r={radius}
          className="we-recovery-center-ring__arc"
          strokeWidth={HEALTH_RING_STROKE}
          fill="none"
          strokeDasharray={HEALTH_RING_CIRCUMFERENCE}
          strokeDashoffset={dashoffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${HEALTH_RING_SIZE / 2} ${HEALTH_RING_SIZE / 2})`}
        />
      </svg>
      <div className="we-recovery-center-ring__label">
        <strong className="we-recovery-center-ring__value">{score === null ? '—' : Math.round(animated)}</strong>
        <small className="we-recovery-center-ring__caption">{t('recoveryCenter.healthRing.caption')}</small>
      </div>
    </div>
  )
}
