import { useEffect, useMemo, useState } from 'react'

import { api, contractApi } from '../api'
import { useT } from '../i18n'
import { isGetUsageCostsResponse } from '../lib/api-guards/operations/GetUsageCosts'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import {
  parseRecoveryHomeSnapshot,
  readRecoveryHomeSection,
} from '../recovery-home-snapshot'
import {
  decodeClustersResponse,
  decodeHeatmap,
  decodeOperatorWins,
  decodeRecoveryLedger,
  decodeRecoveryMetrics,
  decodeRecoveryValidationReport,
} from '../recovery-home-sections'
import { useWorkflowStore } from '../store'
import type { ActiveTab } from '../types'
import { CostDrillSection } from './CostDrillSection'
import { RecoveryValidationSection } from './RecoveryValidationSection'
import { Button } from './ui/Button'
import { ValueDashboardSection } from './ValueDashboardSection'
import { VitalSignsStrip, withSeverityLabels } from './VitalSignsStrip'
import { requestRecoveryDayFocus } from './recovery-day-focus-bus'
import { selectRecoveryTimeMetric } from './recovery-metrics'
import {
  BudgetTile,
  CalibrationHealthTile,
  FailureClustersTile,
} from './recovery-center/RecoveryCenterTiles'
import { RecoveryHeatmap } from './recovery-center/RecoveryHeatmap'
import { useRecoveryKpiTiles } from './recovery-center/recovery-kpi-tiles'
import './ReportsPanel.css'

const REPORT_WINDOWS = [7, 30, 90] as const
const REPORT_TAGS = [PLATFORM_TAG, 'recovery', 'runs', 'dlq'] as const
// The heatmap has no endpoint of its own; the Home read model carries it, with the ledger and wins.
const WHOLE_HISTORY = 0
const READ_MODEL_HEATMAP_DAYS = 90

const loadMetrics = (windowDays: number, signal: AbortSignal) =>
  contractApi('GET /recovery/metrics', `/recovery/metrics?windowDays=${windowDays}`, undefined, { signal })
    .then(decodeRecoveryMetrics)

const loadClusters = (windowDays: number, signal: AbortSignal) =>
  contractApi('GET /dlq/clusters', `/dlq/clusters?windowDays=${windowDays}`, undefined, { signal })
    .then(decodeClustersResponse)

const loadValidation = (windowDays: number, signal: AbortSignal) =>
  api(`/recovery/validation?windowDays=${windowDays}`, { signal })
    .then(decodeRecoveryValidationReport)

const loadHistory = (_windowDays: number, signal: AbortSignal) =>
  contractApi('GET /recovery/home', '/recovery/home', undefined, { signal }).then((payload) => {
    const snapshot = parseRecoveryHomeSnapshot(payload)
    if (!snapshot) return null
    return {
      days: readRecoveryHomeSection(snapshot, 'heatmap', decodeHeatmap)?.days ?? null,
      ledger: readRecoveryHomeSection(snapshot, 'ledger', decodeRecoveryLedger),
      wins: readRecoveryHomeSection(snapshot, 'wins', decodeOperatorWins),
      metrics: readRecoveryHomeSection(snapshot, 'metrics', decodeRecoveryMetrics),
      clusters: readRecoveryHomeSection(snapshot, 'clusters', decodeClustersResponse),
      validation: readRecoveryHomeSection(snapshot, 'validation', decodeRecoveryValidationReport),
    }
  })

const costLoader = (model: string | null) => (windowDays: number, signal: AbortSignal) => {
  const query = new URLSearchParams({ windowDays: String(windowDays), ...(model ? { model } : {}) })
  return contractApi('GET /usage/costs', `/v1/usage/costs?${query}`, undefined, { signal, guard: isGetUsageCostsResponse })
}
const loadCosts = costLoader(null)

/** `undefined` while the first read for this org and window is pending, `null` once it failed.
 *  A refresh replaces the value in place; a new org or window never shows the old one. */
function useReportRead<T>(
  load: (windowDays: number, signal: AbortSignal) => Promise<T | null>,
  enabled: boolean,
  scopeKey: string,
  windowDays: number,
  refresh: number,
): T | null | undefined {
  const scope = `${scopeKey}:${windowDays}`
  const [read, setRead] = useState<{ scope: string; value: T | null } | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    load(windowDays, controller.signal)
      .catch(() => null)
      .then((value) => {
        if (!controller.signal.aborted) setRead({ scope, value })
      })
    return () => controller.abort()
  }, [enabled, load, refresh, scope, windowDays])
  return read?.scope === scope ? read.value : undefined
}

export function ReportsPanel({
  canReadDeadLetters,
  canReadReports,
  canReadRuns,
  onOpenTab,
  onOpenRun,
}: {
  canReadDeadLetters: boolean
  canReadReports: boolean
  canReadRuns: boolean
  onOpenTab: (tab: ActiveTab) => void
  onOpenRun: (runId: string) => void
}) {
  const { t } = useT()
  const orgId = useWorkflowStore((state) => state.orgId) ?? 'default'
  const invalidation = useInvalidationNonce(REPORT_TAGS)
  const [retries, setRetries] = useState(0)
  const refresh = invalidation + retries
  const [windowDays, setWindowDays] = useState<number>(30)
  const [nowMs] = useState(() => Date.now())
  // Tied to the org and window it was picked in, so it never outlives them.
  const costScope = `${orgId}:${windowDays}`
  const [costSelection, setCostSelection] = useState<{ scope: string; model: string } | null>(null)
  const costModel = costSelection?.scope === costScope ? costSelection.model : null

  const windowedMetrics = useReportRead(loadMetrics, canReadDeadLetters, orgId, windowDays, refresh)
  const windowedClusters = useReportRead(loadClusters, canReadDeadLetters, orgId, windowDays, refresh)
  const windowedValidation = useReportRead(loadValidation, canReadReports, orgId, windowDays, refresh)
  const history = useReportRead(loadHistory, true, orgId, WHOLE_HISTORY, refresh)
  const loadModelCosts = useMemo(() => costLoader(costModel), [costModel])
  const costs = useReportRead(loadCosts, canReadRuns, orgId, windowDays, refresh)
  const modelCosts = useReportRead(loadModelCosts, canReadRuns && costModel !== null, `${orgId}:${costModel}`, windowDays, refresh)
  // The focused routes need dlq.read and reports.read; recovery.read alone gets
  // the read model's fixed 30-day projections of the same reports.
  const metrics = canReadDeadLetters ? windowedMetrics : history?.metrics
  const clusters = canReadDeadLetters ? windowedClusters : history?.clusters
  const validation = canReadReports ? windowedValidation : history?.validation

  const openDay = (day: string) => {
    requestRecoveryDayFocus(day, 'recover')
    onOpenTab('recover')
  }
  const kpis = useRecoveryKpiTiles(metrics ?? null, onOpenTab, openDay)
  const recoveryTime = metrics ? selectRecoveryTimeMetric(metrics) : null
  const failed = metrics === null || clusters === null || validation === null
    || history === null || history?.days === null
    || costs === null || (costModel !== null && modelCosts === null)

  return (
    <div className="we-reports" data-testid="reports-panel">
      {canReadDeadLetters && (
        <div
          className="we-reports__windows"
          role="group"
          aria-label={t('activity.reports.windowAria')}
        >
          {REPORT_WINDOWS.map((days) => (
            <Button
              key={days}
              size="sm"
              aria-pressed={days === windowDays}
              data-testid={`reports-window-${days}`}
              onClick={() => setWindowDays(days)}
            >
              {t('workflowSlo.windowOption', { days })}
            </Button>
          ))}
        </div>
      )}

      {failed && (
        <div className="we-recovery-center-error we-reports__error" role="status" data-testid="reports-unavailable">
          <span>{t('activity.reports.unavailable')}</span>
          <Button size="sm" data-testid="reports-retry" onClick={() => setRetries((count) => count + 1)}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      {metrics && (
        <VitalSignsStrip
          tiles={withSeverityLabels([kpis.verifiedRecovery, kpis.firstAction, kpis.replay, kpis.durability, kpis.sla, kpis.runs], t)}
          ariaLabel={t('recoveryCenter.metricStripAria')}
          testId="reports-metric-strip"
        />
      )}

      {history?.days && (
        <RecoveryHeatmap
          days={history.days}
          windowDays={canReadDeadLetters ? windowDays : READ_MODEL_HEATMAP_DAYS}
          nowMs={nowMs}
          onSelectDay={openDay}
        />
      )}

      {clusters && (
        <FailureClustersTile
          clusters={[...clusters.clusters].sort((a, b) => b.frequency - a.frequency)}
          totalSamples={clusters.totalSamples}
          onOpenTab={onOpenTab}
        />
      )}

      {canReadRuns && (
        <CostDrillSection
          costs={costs}
          stepsRead={costModel === null ? costs : modelCosts}
          selectedModel={costModel}
          onSelectModel={(model) => setCostSelection(model === null ? null : { scope: costScope, model })}
          onOpenRun={onOpenRun}
        />
      )}

      <div className="we-reports__tiles">
        <CalibrationHealthTile />
        <BudgetTile title={t('activity.reports.aiSpend')} onOpenTab={onOpenTab} />
      </div>

      <RecoveryValidationSection report={validation} canExport={canReadReports} />

      {metrics && (
        <ValueDashboardSection
          recoveryTimeMs={recoveryTime?.value ?? null}
          recoveryTimeDisplay={recoveryTime?.display ?? '—'}
          clustersResolved={metrics.clustersResolved}
          valueEstimate={metrics.valueEstimate}
          windowDays={metrics.windowDays}
          downtimeEndedMs={metrics.downtimeEndedMs}
          ledger={history?.ledger}
          personalWins={history?.wins}
          terminalRunsZero={metrics.terminalRuns === 0}
          canExport={canReadReports}
        />
      )}
    </div>
  )
}
