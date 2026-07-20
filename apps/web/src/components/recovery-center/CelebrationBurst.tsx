/**
 * Short, decorative recovery-success burst shared by high-value moments.
 *
 * Used by: `RecoveryCenterHero.tsx` and `../recovery-dialog/AppliedBody.tsx`.
 * The component owns no timer: changing `trigger` remounts the particle group,
 * while reduced-motion users receive no decorative DOM at all.
 */

import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'

const PARTICLES = Array.from({ length: 10 }, (_, index) => index)

/** Render one inert CSS particle burst, replaying whenever `trigger` changes. */
export function CelebrationBurst({ trigger }: { trigger: number }) {
  const reducedMotion = usePrefersReducedMotion()
  if (reducedMotion || trigger <= 0) return null

  return (
    <span
      key={trigger}
      className="we-celebration-burst"
      data-testid="celebration-burst"
      data-trigger={trigger}
      aria-hidden="true"
    >
      {PARTICLES.map((particle) => (
        <span key={particle} className="we-celebration-burst__particle" />
      ))}
    </span>
  )
}
