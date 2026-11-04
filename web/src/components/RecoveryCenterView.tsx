import { OnboardingReplayButton } from './OnboardingReplayButton'
import { OnboardingBanner } from './OnboardingBanner'
import { RecoveryCenterHero } from './recovery-center/RecoveryCenterHero'
import { RecoveryLabEntry } from './recovery-center/RecoveryCenterEmptyState'
import { HomeActionWorkspace } from './recovery-center/HomeActionWorkspace'
import { HomeBudgetBanner } from './recovery-center/HomeBudgetBanner'
import { HomeTodayStrip } from './recovery-center/HomeTodayStrip'
import { RecoveryCenterComposer } from './recovery-center/RecoveryCenterComposer'
import { downtimeSeverity } from './recovery-center/recovery-center-model'
import { useT } from '../i18n'
import type { RecoveryCenterController } from './RecoveryCenterPanel'

export function RecoveryCenterView({ model }: { model: RecoveryCenterController }) {
  const { t } = useT()
  const {
    activeRuns, allActiveRuns, allClear, allClearDowntimeOverride, approvalsPending, bumpPlatformVersion,
    celebrationTrigger, dismissIntro, greeting, handleRecommendedAction,
    healthScore, longestOpen, memoryPurgeCountdownLabel,
    metrics, metricsError, metricsLoading, metricsStatus, nowMs, onOpenActivity,
    onOpenMemoryGovernance, onOpenRecoveryQueue, onOpenRun, onOpenTab, onStartRecoveryDrill,
    openDeadLetters, openFailureCount, operatorBriefStatus, operatorBriefWarnings, operatorWins,
    recommendedActions, recoveryClearEligible, runsToday, showOnboarding, streak,
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
        successRateDisplay={metrics?.successRate.display}
        onOpenRuns={() => onOpenTab('runs')}
        onOpenRecoveryQueue={() => onOpenRecoveryQueue()}
        onRefreshStatus={bumpPlatformVersion}
        onOpenMemoryGovernance={onOpenMemoryGovernance}
      />

      <HomeBudgetBanner onOpenTab={onOpenTab} />

      {showOnboarding ? (
        <>
          <RecoveryLabEntry
            onOpenStudio={() => onOpenTab('ai-studio')}
            onOpenRecipes={() => onOpenTab('templates')}
            onStartDrill={onStartRecoveryDrill}
            onDismiss={dismissIntro}
          />
          <OnboardingBanner onOpenTab={onOpenTab} />
        </>
      ) : <HomeActionWorkspace
        actions={recommendedActions}
        activeRuns={activeRuns}
        activeRunCount={allActiveRuns.length}
        status={operatorBriefStatus}
        warnings={operatorBriefWarnings}
        setup={<OnboardingBanner onOpenTab={onOpenTab} />}
        onSelectAction={handleRecommendedAction}
        onOpenRun={onOpenRun}
        onOpenActivity={onOpenActivity}
      />}

      <RecoveryCenterComposer onOpenTab={onOpenTab} recentDlqRunId={openDeadLetters[0]?.runId} />

      <HomeTodayStrip
        runsToday={runsToday}
        openFailures={openFailureCount}
        approvals={approvalsPending}
        onOpenRecoveryQueue={() => onOpenRecoveryQueue()}
        onOpenRuns={() => onOpenTab('runs')}
        onOpenReports={() => onOpenTab('reports')}
      />

      {metricsError && !metricsLoading && (
        <p className="we-recovery-center-error" role="status">
          {t('recoveryCenter.metricsUnavailable', { detail: metricsError })}
        </p>
      )}

      <OnboardingReplayButton />
    </div>
  )
}
