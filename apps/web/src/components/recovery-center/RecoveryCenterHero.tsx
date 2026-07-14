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

import { Award, Clock3, Flame, ListTree } from 'lucide-react'
import { useT } from '../../i18n'
import { HealthRing } from './HealthRing'
import { CelebrationBurst } from './CelebrationBurst'
import { formatDowntime, type DowntimeSeverity, type OperatorWins, type StreakSummary } from './helpers'

export function RecoveryCenterHero({
  salutation,
  subline,
  healthScore,
  openFailures,
  streak,
  longestOpenMs,
  longestOpenSeverity,
  allClear,
  allClearDowntimeMs,
  celebrationTrigger,
  personalWins = null,
  memoryPurgeCountdown = null,
  onOpenMemoryGovernance,
  onOpenQueue,
}: {
  salutation: string
  subline: string
  healthScore: number | null
  openFailures: number
  streak: StreakSummary
  longestOpenMs?: number | null
  longestOpenSeverity?: DowntimeSeverity
  allClear?: boolean
  allClearDowntimeMs?: number | null
  celebrationTrigger?: number
  personalWins?: OperatorWins | null
  memoryPurgeCountdown?: string | null
  onOpenMemoryGovernance?: () => void
  onOpenQueue: () => void
}) {
  const { t } = useT()
  const actionMode = openFailures > 0
  const effectiveAllClear = Boolean(allClear && !actionMode)
  const showStreak = streak.current >= 3
  const allClearDuration = typeof allClearDowntimeMs === 'number' && allClearDowntimeMs > 0
    ? formatDowntime(allClearDowntimeMs)
    : ''
  const allClearSummary = allClearDuration && showStreak
    ? t('recoveryCenter.hero.allClearSubline', { duration: allClearDuration, count: streak.current })
    : allClearDuration
      ? t('recoveryCenter.hero.allClearDurationOnly', { duration: allClearDuration })
      : showStreak
        ? t('recoveryCenter.hero.allClearStreakOnly', { count: streak.current })
        : t('recoveryCenter.hero.allClearFallback')
  return (
    <header className="we-recovery-center-hero" role="banner" data-all-clear={effectiveAllClear ? 'true' : undefined}>
      {effectiveAllClear && <CelebrationBurst trigger={celebrationTrigger ?? 0} />}
      <div className="we-recovery-center-hero__copy">
        <div className="section-kicker">
          {effectiveAllClear ? t('recoveryCenter.hero.allClearKicker') : t('recoveryCenter.kicker')}
        </div>
        {actionMode ? (
          <>
            <h1 className="we-recovery-center-hero__greeting" data-testid="recovery-center-greeting">
              {t('recoveryCenter.hero.recoveryTitle', { count: openFailures })}
            </h1>
            <p className="we-recovery-center-hero__subline">{salutation} {subline}</p>
            {typeof longestOpenMs === 'number' && longestOpenMs >= 0 && (
              <p
                className="we-recovery-center-hero__downtime"
                data-severity={longestOpenSeverity ?? 'ok'}
                data-testid="recovery-center-longest-downtime"
              >
                {t('recoveryCenter.hero.longestDowntime', { duration: formatDowntime(longestOpenMs) })}
              </p>
            )}
            {showStreak && (
              <p
                className="we-recovery-center-hero__streak"
                title={t('recoveryCenter.hero.streakLongest', { count: streak.longest }) as string}
                data-testid="recovery-center-clean-streak"
              >
                <Flame size={14} aria-hidden="true" />
                {t('recoveryCenter.hero.streak', { count: streak.current })}
              </p>
            )}
            <div className="we-recovery-center-hero__actions">
              <button type="button" className="we-btn we-btn--primary" onClick={onOpenQueue} data-testid="recovery-center-open-queue">
                <ListTree size={15} aria-hidden="true" /> {t('recoveryCenter.hero.openQueue')}
              </button>
            </div>
          </>
        ) : effectiveAllClear ? (
          <div className="we-recovery-center-hero__all-clear" role="status" aria-live="polite">
            <h1 className="we-recovery-center-hero__greeting" data-testid="recovery-center-greeting">
              {t('recoveryCenter.hero.allClearTitle')}
            </h1>
            <p className="we-recovery-center-hero__subline" data-testid="recovery-center-all-clear-summary">
              {allClearSummary}
            </p>
          </div>
        ) : (
          <>
            <h1 className="we-recovery-center-hero__greeting" data-testid="recovery-center-greeting">{salutation}</h1>
            <p className="we-recovery-center-hero__subline">{subline}</p>
            {personalWins && personalWins.recovered > 0 && (
              <p className="we-recovery-center-hero__wins" data-testid="recovery-center-personal-wins">
                <Award size={14} aria-hidden="true" />
                {t('recoveryCenter.hero.personalWins', {
                  count: personalWins.recovered,
                  days: personalWins.windowDays,
                })}
              </p>
            )}
            {showStreak && (
              <p
                className="we-recovery-center-hero__streak"
                title={t('recoveryCenter.hero.streakLongest', { count: streak.longest }) as string}
                data-testid="recovery-center-clean-streak"
              >
                <Flame size={14} aria-hidden="true" />
                {t('recoveryCenter.hero.streak', { count: streak.current })}
              </p>
            )}
          </>
        )}
        <p className="we-recovery-center-hero__pitch">{t('recoveryCenter.hero.pitch')}</p>
        {memoryPurgeCountdown && onOpenMemoryGovernance && (
          <div className="we-recovery-center-hero__memory-purge" data-testid="memory-purge-countdown">
            <Clock3 size={16} aria-hidden="true" />
            <div role="status">
              <strong>{t('recoveryCenter.hero.memoryPurgeTitle')}</strong>
              <span>{memoryPurgeCountdown}</span>
            </div>
            <button type="button" className="we-btn we-btn--secondary" onClick={onOpenMemoryGovernance}>
              {t('recoveryCenter.hero.memoryPurgeCta')}
            </button>
          </div>
        )}
      </div>
      <HealthRing score={healthScore} />
    </header>
  )
}
