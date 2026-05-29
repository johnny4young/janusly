/**
 * RecoveryCenterHero — the banner at the top of the Recovery Center.
 *
 * When there are open failures the hero leads with the ACTION — an
 * "N runs need recovery" title plus a direct "Open recovery queue" CTA —
 * and demotes the time-of-day greeting to a context line. With nothing to
 * recover it falls back to the calm greeting-first layout. The org-wide
 * HealthRing mounts on the right.
 *
 * The greeting strings are computed by `buildGreeting` in the composer
 * (`../RecoveryCenterPanel.tsx`) and passed down as props so this stays a
 * presentational shell. Used only by the composer.
 */

import { ListTree } from 'lucide-react'
import { useT } from '../../i18n'
import { HealthRing } from './HealthRing'

export function RecoveryCenterHero({
  salutation,
  subline,
  healthScore,
  openFailures,
  onOpenQueue,
}: {
  salutation: string
  subline: string
  healthScore: number | null
  openFailures: number
  onOpenQueue: () => void
}) {
  const { t } = useT()
  const actionMode = openFailures > 0
  return (
    <header className="we-recovery-center-hero" role="banner">
      <div className="we-recovery-center-hero__copy">
        <div className="section-kicker">{t('recoveryCenter.kicker')}</div>
        {actionMode ? (
          <>
            <h1 className="we-recovery-center-hero__greeting" data-testid="recovery-center-greeting">
              {t('recoveryCenter.hero.recoveryTitle', { count: openFailures })}
            </h1>
            <p className="we-recovery-center-hero__subline">{salutation} {subline}</p>
            <div className="we-recovery-center-hero__actions">
              <button type="button" className="we-btn we-btn--primary" onClick={onOpenQueue} data-testid="recovery-center-open-queue">
                <ListTree size={15} aria-hidden="true" /> {t('recoveryCenter.hero.openQueue')}
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="we-recovery-center-hero__greeting" data-testid="recovery-center-greeting">{salutation}</h1>
            <p className="we-recovery-center-hero__subline">{subline}</p>
          </>
        )}
        <p className="we-recovery-center-hero__pitch">{t('recoveryCenter.hero.pitch')}</p>
      </div>
      <HealthRing score={healthScore} />
    </header>
  )
}
