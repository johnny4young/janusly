/**
 * RecoveryCenterHero — the compact operational header at the top of Home.
 *
 * Home always leads with the operator greeting. Priority work lives in the
 * adjacent action inbox, while this header owns one concise workspace-health
 * summary and the transient all-clear acknowledgement.
 *
 * The greeting strings are computed by `buildGreeting` in the composer
 * (`../RecoveryCenterPanel.tsx`) and passed down as props so this stays a
 * presentational shell. Used only by the composer.
 */

import { Award, Clock3, Flame } from 'lucide-react'
import { useT } from '../../i18n'
import { HealthRing } from './HealthRing'
import { CelebrationBurst } from './CelebrationBurst'
import { formatDowntime, type DowntimeSeverity, type OperatorWins, type StreakSummary } from './recovery-center-model'

export function RecoveryCenterHero({
  salutation,
  subline,
  healthScore,
  openFailures,
  priorityCount,
  metricsStatus,
  streak,
  longestOpenMs,
  longestOpenSeverity,
  allClear,
  allClearDowntimeMs,
  celebrationTrigger,
  personalWins = null,
  memoryPurgeCountdown = null,
  onRefreshStatus,
  onOpenMemoryGovernance,
}: {
  salutation: string
  subline: string
  healthScore: number | null
  openFailures: number
  priorityCount: number
  metricsStatus: 'loading' | 'available' | 'unavailable'
  streak: StreakSummary
  longestOpenMs?: number | null
  longestOpenSeverity?: DowntimeSeverity
  allClear?: boolean
  allClearDowntimeMs?: number | null
  celebrationTrigger?: number
  personalWins?: OperatorWins | null
  memoryPurgeCountdown?: string | null
  onRefreshStatus?: () => void
  onOpenMemoryGovernance?: () => void
}) {
  const { t } = useT()
  const effectiveAllClear = Boolean(allClear && openFailures === 0)
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
  const healthTitle = metricsStatus === 'loading'
    ? t('common.loading')
    : metricsStatus === 'unavailable'
      ? t('home.health.unavailable')
      : priorityCount > 0
        ? t('home.health.attention')
        : t('home.health.clear')
  return (
    <header
      className="we-recovery-center-hero we-home-header"
      role="banner"
      data-all-clear={effectiveAllClear ? 'true' : undefined}
    >
      {effectiveAllClear && <CelebrationBurst trigger={celebrationTrigger ?? 0} />}
      <div className="we-recovery-center-hero__copy">
        <div className="section-kicker">
          {effectiveAllClear ? t('recoveryCenter.hero.allClearKicker') : t('sidebar.nav.home.label')}
        </div>
        {effectiveAllClear ? (
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
            {typeof longestOpenMs === 'number' && longestOpenMs >= 0 && openFailures > 0 && (
              <p
                className="we-recovery-center-hero__downtime"
                data-severity={longestOpenSeverity ?? 'ok'}
                data-testid="recovery-center-longest-downtime"
              >
                {t('recoveryCenter.hero.longestDowntime', { duration: formatDowntime(longestOpenMs) })}
              </p>
            )}
            {priorityCount === 0 && personalWins && personalWins.recovered > 0 && (
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
                title={t('recoveryCenter.hero.streakLongest', { count: streak.longest })}
                data-testid="recovery-center-clean-streak"
              >
                <Flame size={14} aria-hidden="true" />
                {t('recoveryCenter.hero.streak', { count: streak.current })}
              </p>
            )}
          </>
        )}
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
      <div className="we-home-health-summary" data-testid="home-health-summary">
        <HealthRing score={healthScore} />
        <div>
          <strong>{healthTitle}</strong>
          {metricsStatus === 'unavailable' && onRefreshStatus && (
            <button type="button" className="we-btn we-btn--ghost we-btn--sm" onClick={onRefreshStatus}>
              {t('common.retry')}
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
