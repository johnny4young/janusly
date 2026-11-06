import { lazy, Suspense, useRef, useState } from 'react'
import { OnboardingReplayButton } from './OnboardingReplayButton'
import { OnboardingBanner } from './OnboardingBanner'
import { RecoveryCenterHero } from './recovery-center/RecoveryCenterHero'
import { RecoveryLabEntry } from './recovery-center/RecoveryCenterEmptyState'
import { HomeActionWorkspace } from './recovery-center/HomeActionWorkspace'
import { HomeBudgetBanner } from './recovery-center/HomeBudgetBanner'
import { HomeTodayStrip } from './recovery-center/HomeTodayStrip'
import { HomeOperatorField } from './recovery-center/HomeOperatorField'
import { downtimeSeverity, type RecommendedAction } from './recovery-center/recovery-center-model'
import { useT } from '../i18n'
import type { RecoveryCenterController } from './RecoveryCenterPanel'

const HomeInvestigationPanel = lazy(() => import('./recovery-center/HomeInvestigationPanel').then((module) => ({
  default: module.HomeInvestigationPanel,
})))

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
  const [investigating, setInvestigating] = useState<RecommendedAction | null>(null)
  const investigateTrigger = useRef<HTMLElement | null>(null)
  const investigate = (action: RecommendedAction) => {
    investigateTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setInvestigating(action)
  }
  const closeInvestigation = () => {
    setInvestigating(null)
    investigateTrigger.current?.focus()
  }
  const operator = (
    <HomeOperatorField
      openFailures={openDeadLetters}
      onOpenTab={onOpenTab}
      onOpenRun={onOpenRun}
      onOpenRecoveryQueue={onOpenRecoveryQueue}
    />
  )

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
          {operator}
        </>
      ) : <HomeActionWorkspace
        actions={recommendedActions}
        activeRuns={activeRuns}
        activeRunCount={allActiveRuns.length}
        status={operatorBriefStatus}
        warnings={operatorBriefWarnings}
        setup={<OnboardingBanner onOpenTab={onOpenTab} />}
        operator={operator}
        onSelectAction={handleRecommendedAction}
        onInvestigate={investigate}
        onOpenRun={onOpenRun}
        onOpenActivity={onOpenActivity}
      />}

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

      {investigating?.target.runId && (
        <Suspense fallback={null}>
          <HomeInvestigationPanel
            key={investigating.id}
            runId={investigating.target.runId}
            title={investigating.title}
            onClose={closeInvestigation}
            onOpenRun={onOpenRun}
            onOpenRecoveryQueue={onOpenRecoveryQueue}
          />
        </Suspense>
      )}
    </div>
  )
}
