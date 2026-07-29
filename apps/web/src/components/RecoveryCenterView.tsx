import { lazy, Suspense } from 'react'
import { ChevronDown } from 'lucide-react'
import { OnboardingReplayButton } from './OnboardingReplayButton'
import { OnboardingBanner } from './OnboardingBanner'
import { RecoveryCenterHero } from './recovery-center/RecoveryCenterHero'
import { HomeActionWorkspace } from './recovery-center/HomeActionWorkspace'
import { downtimeSeverity } from './recovery-center/recovery-center-model'
import { useT } from '../i18n'
import type { RecoveryCenterController } from './RecoveryCenterPanel'

const HomeInsights = lazy(() => import('./recovery-center/HomeInsights').then((module) => ({
  default: module.HomeInsights,
})))

export function RecoveryCenterView({ model }: { model: RecoveryCenterController }) {
  const { t } = useT()
  const {
    activeRuns, allActiveRuns, allClear, allClearDowntimeOverride, bumpPlatformVersion,
    celebrationTrigger, clusters, dismissIntro, greeting, handleRecommendedAction,
    healthScore, heatmap, heatmapCells, insightsOpen, ledger, longestOpen, memoryPurgeCountdownLabel,
    metrics, metricsError, metricsLoading, metricsStatus, nowMs, onOpenActivity,
    onOpenMemoryGovernance, onOpenRecoveryQueue, onOpenRun, onOpenTab, onStartRecoveryDrill,
    openDeadLetters, openFailureCount, operatorWins, recommendedActions, recoveryClearEligible,
    setInsightsOpen, showOnboarding, streak, validation, waitingNodes,
  } = model

  return (
    <div className="we-recovery-center-panel we-recovery-center-panel--operator">
      <RecoveryCenterHero
        salutation={greeting.salutation}
        subline={greeting.subline}
        healthScore={healthScore}
        openFailures={openFailureCount}
        priorityCount={recommendedActions.length}
        metricsStatus={metricsStatus}
        streak={streak}
        longestOpenMs={longestOpen?.durationMs}
        longestOpenSeverity={downtimeSeverity(longestOpen?.createdAt, nowMs)}
        allClear={allClear && recoveryClearEligible}
        allClearDowntimeMs={allClearDowntimeOverride ?? metrics?.downtimeEndedMs}
        celebrationTrigger={celebrationTrigger}
        personalWins={operatorWins}
        memoryPurgeCountdown={memoryPurgeCountdownLabel}
        onRefreshStatus={bumpPlatformVersion}
        onOpenMemoryGovernance={onOpenMemoryGovernance}
      />

      <HomeActionWorkspace
        actions={recommendedActions}
        activeRuns={activeRuns}
        activeRunCount={allActiveRuns.length}
        onSelectAction={handleRecommendedAction}
        onOpenRun={onOpenRun}
        onOpenActivity={onOpenActivity}
      />

      <OnboardingBanner onOpenTab={onOpenTab} />

      <section className="we-home-insights" data-expanded={insightsOpen}>
        <button
          type="button"
          className="we-home-insights__toggle"
          aria-expanded={insightsOpen}
          aria-controls="we-home-insights-content"
          onClick={() => setInsightsOpen((open) => !open)}
          data-testid="home-insights-toggle"
        >
          <span className="we-home-insights__toggle-copy">
            <strong>{t('home.insights.title')}</strong>
          </span>
          <span className="we-home-insights__toggle-action" aria-hidden="true">
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </button>

        {insightsOpen && (
          <div id="we-home-insights-content">
            <Suspense
              fallback={(
                <p className="helper-text" role="status">
                  {t('common.loading')}
                </p>
              )}
            >
              <HomeInsights
                metrics={metrics}
                openFailureCount={openFailureCount}
                waitingApprovals={waitingNodes.length}
                clusters={clusters}
                heatmap={heatmap}
                heatmapCells={heatmapCells}
                nowMs={nowMs}
                validation={validation}
                ledger={ledger}
                personalWins={operatorWins}
                showRecoveryLab={showOnboarding}
                recentDlqRunId={openDeadLetters[0]?.runId}
                onOpenTab={onOpenTab}
                onOpenRecoveryQueue={onOpenRecoveryQueue}
                onStartRecoveryDrill={onStartRecoveryDrill}
                onDismissRecoveryLab={dismissIntro}
              />
            </Suspense>

            {metricsError && !metricsLoading && (
              <p className="we-recovery-center-error" role="status">
                {t('recoveryCenter.metricsUnavailable', { detail: metricsError })}
              </p>
            )}
          </div>
        )}
      </section>

      <OnboardingReplayButton />
    </div>
  )
}
