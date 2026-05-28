/**
 * RecoveryCenterHero — the greeting banner at the top of the Recovery
 * Center: kicker + time-of-day salutation + posture subline + product
 * pitch, with the org-wide HealthRing mounted on the right.
 *
 * The greeting strings are computed by `buildGreeting` in the composer
 * (`../RecoveryCenterPanel.tsx`) and passed down as props so this stays a
 * presentational shell. Used only by the composer.
 */

import { useT } from '../../i18n'
import { HealthRing } from './HealthRing'

export function RecoveryCenterHero({
  salutation,
  subline,
  healthScore,
}: {
  salutation: string
  subline: string
  healthScore: number | null
}) {
  const { t } = useT()
  return (
    <header className="we-recovery-center-hero" role="banner">
      <div className="we-recovery-center-hero__copy">
        <div className="section-kicker">{t('recoveryCenter.kicker')}</div>
        <h1 className="we-recovery-center-hero__greeting" data-testid="recovery-center-greeting">{salutation}</h1>
        <p className="we-recovery-center-hero__subline">{subline}</p>
        <p className="we-recovery-center-hero__pitch">{t('recoveryCenter.hero.pitch')}</p>
      </div>
      <HealthRing score={healthScore} />
    </header>
  )
}
