/**
 * Recovery Center tile family.
 *
 * All tiles share the `RecoveryCenterTile` shell (header + body + optional
 * footer link) and the `AllClearState` empty-state, so co-locating them in
 * one file is cleaner than eight micro-files. Each tile takes its data as
 * props from the composer (`../RecoveryCenterPanel.tsx`) — no tile
 * re-fetches what the panel already holds, except `BudgetTile`, which owns
 * its own `/billing/budget` fetch (a distinct endpoint the panel doesn't
 * read).
 *
 * Pure presentational logic lives in `./helpers.ts` (`readWorkflowName`,
 * `readErrorSignature`, `humanizeAge`, `clusterCategoryLabel`,
 * `clusterOwnerLabel`, `budgetBand`).
 *
 * Used by `../RecoveryCenterPanel.tsx`.
 */

import React, { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Check,
  CheckSquare,
  ChevronRight,
  CircleCheck,
  Coins,
  Compass,
  Eye,
  Gauge,
  Inbox,
  Layers,
  PlayCircle,
  ShieldAlert,
  Sparkles,
  Users,
} from 'lucide-react'
import type { ActiveTab, RunNode, RunSummary } from '../../types'
import { api } from '../../api'
import { useWorkflowStore } from '../../store'
import { useT } from '../../i18n'
import { requestOperationsSection } from '../operations-section-bus'
import type { DeadLetter } from '../DeadLettersPanel'
import {
  budgetBand,
  clusterCategoryLabel,
  clusterOwnerLabel,
  humanizeAge,
  readErrorSignature,
  readWorkflowName,
  type BudgetEnvelope,
  type FailureCluster,
  type RecommendedAction,
  type RecommendedActionId,
  type RecommendedActionSeverity,
  type RecoveryMetrics,
} from './helpers'

// ─────────────────────────────────────────────────────────────────────────
// RecoveryCenterTile — the shared shell every tile renders into.
// ─────────────────────────────────────────────────────────────────────────

export function RecoveryCenterTile({
  title,
  kicker,
  severity,
  icon,
  footer,
  children,
  testId,
}: {
  title: string
  kicker: string
  severity?: RecommendedActionSeverity | 'neutral'
  icon: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
  testId: string
}) {
  return (
    <section
      className="we-recovery-center-tile"
      data-severity={severity ?? 'neutral'}
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
    >
      <header className="we-recovery-center-tile__head">
        <span className="we-recovery-center-tile__icon" aria-hidden="true">{icon}</span>
        <div className="we-recovery-center-tile__heading">
          <div className="section-kicker">{kicker}</div>
          <h2 id={`${testId}-title`}>{title}</h2>
        </div>
      </header>
      <div className="we-recovery-center-tile__body">
        {children}
      </div>
      {footer && <footer className="we-recovery-center-tile__footer">{footer}</footer>}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// AllClearState — shared "everything is OK" empty-state component.
// Stylized with a soft success ring + check glyph + reassuring copy.
// Used inside each tile when there's no work for the operator.
// ─────────────────────────────────────────────────────────────────────────

function AllClearState({ message, testId }: { message: string; testId?: string }) {
  const { t } = useT()
  return (
    <div className="we-recovery-allclear" data-testid={testId}>
      <span className="we-recovery-allclear__ring" aria-hidden="true">
        <CircleCheck size={18} />
      </span>
      <div className="we-recovery-allclear__copy">
        <strong>{t('recoveryCenter.allClear.title')}</strong>
        <span>{message}</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// OperatorTodayTile — mini stats grid mirroring the right rail of
// `ui_kits/studio/home-operator.html` (Runs / Success / Spend / MTTR).
// ─────────────────────────────────────────────────────────────────────────

export function OperatorTodayTile({
  metrics,
  openDeadLetters,
  waitingNodes,
  onOpenTab,
}: {
  metrics: RecoveryMetrics | null
  openDeadLetters: number
  waitingNodes: number
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.today.title')}
      kicker={t('recoveryCenter.tile.today.kicker')}
      severity="cobalt"
      icon={<BarChart3 size={18} aria-hidden="true" />}
      testId="recovery-center-tile-today"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('operations')}
        >
          {t('recoveryCenter.tile.today.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      <div className="we-operator-mini">
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.runs')}</div>
          <div className="we-operator-mini__val">{metrics?.terminalRuns ?? 0}</div>
          <div className="we-operator-mini__delta">{t('recoveryCenter.tile.today.windowDays', { days: metrics?.windowDays ?? 30 })}</div>
        </div>
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.success')}</div>
          <div className="we-operator-mini__val">{metrics?.successRate.display ?? '—'}</div>
          <div className="we-operator-mini__delta" data-severity={metrics?.successRate.severity ?? 'neutral'}>{metrics?.successRate.severity ?? '—'}</div>
        </div>
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.failures')}</div>
          <div className="we-operator-mini__val">{openDeadLetters}</div>
          <div className="we-operator-mini__delta" data-severity={openDeadLetters === 0 ? 'success' : 'danger'}>{openDeadLetters === 0 ? t('recoveryCenter.tile.today.clean') : t('recoveryCenter.tile.today.pending')}</div>
        </div>
        <div className="we-operator-mini__cell">
          <div className="we-operator-mini__lbl">{t('recoveryCenter.tile.today.mttr')}</div>
          <div className="we-operator-mini__val">{metrics?.mttr.display ?? '—'}</div>
          <div className="we-operator-mini__delta">{t('recoveryCenter.tile.today.pending')} {waitingNodes}</div>
        </div>
      </div>
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// RecoveryQueueTile — top open dead-letters.
// ─────────────────────────────────────────────────────────────────────────

export function RecoveryQueueTile({
  deadLetters,
  runs,
  nowMs,
  onOpenRun,
  onOpenTab,
}: {
  deadLetters: DeadLetter[]
  runs: RunSummary[]
  nowMs: number | null
  onOpenRun: (runId: string) => void | Promise<void>
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const top = deadLetters.slice(0, 3)
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.queue.title')}
      kicker={t('recoveryCenter.tile.queue.kicker')}
      severity={deadLetters.length === 0 ? 'success' : 'warning'}
      icon={<Inbox size={18} aria-hidden="true" />}
      testId="recovery-center-tile-queue"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('runs')}
          data-testid="recovery-center-queue-open-all"
        >
          {t('recoveryCenter.tile.queue.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {top.length === 0 ? (
        <AllClearState
          message={t('recoveryCenter.tile.queue.empty')}
          testId="recovery-center-queue-allclear"
        />
      ) : (
        <ul className="we-recovery-center-rows">
          {top.map((dlq) => {
            const workflowName = readWorkflowName(dlq, runs)
            const signature = readErrorSignature(dlq.errorJson)
            const age = humanizeAge(dlq.createdAt, nowMs)
            return (
              <li key={dlq.id}>
                <button
                  type="button"
                  className="we-recovery-center-row"
                  onClick={() => {
                    void onOpenRun(dlq.runId)
                    onOpenTab('runs')
                  }}
                  data-testid={`recovery-center-queue-row-${dlq.id}`}
                >
                  <span className="we-recovery-center-row__title">{workflowName}</span>
                  <span className="we-recovery-center-row__meta">
                    <code className="we-recovery-center-row__node">{dlq.nodeId}</code>
                    <span className="we-recovery-center-row__pill" data-severity="warning">{signature}</span>
                  </span>
                  <span className="we-recovery-center-row__age">{age}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// FailureClustersTile — normalized recurring failure signatures.
// ─────────────────────────────────────────────────────────────────────────

export function FailureClustersTile({
  clusters,
  totalSamples,
  onOpenTab,
}: {
  clusters: FailureCluster[]
  totalSamples: number
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.clusters.title')}
      kicker={t('recoveryCenter.tile.clusters.kicker', { count: totalSamples })}
      severity={clusters.length === 0 ? 'success' : 'cobalt'}
      icon={<Eye size={18} aria-hidden="true" />}
      testId="recovery-center-tile-clusters"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('operations')}
          data-testid="recovery-center-clusters-open-all"
        >
          {t('recoveryCenter.tile.clusters.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {clusters.length === 0 ? (
        <AllClearState
          message={t('recoveryCenter.tile.clusters.empty')}
          testId="recovery-center-clusters-allclear"
        />
      ) : (
        <ul className="we-recovery-watch">
          {clusters.map((cluster) => {
            const state = cluster.frequency >= 2 ? 'ready' : 'monitoring'
            const stateLabel = state === 'ready'
              ? t('recoveryCenter.tile.clusters.statePatchReady')
              : t('recoveryCenter.tile.clusters.stateMonitoring')
            return (
              <li key={cluster.signature}>
                <div className="we-recovery-watch-row" data-testid={`recovery-center-watch-row-${cluster.signature}`}>
                  <span className="we-recovery-watch-row__sig">{cluster.signature}</span>
                  <div className="we-recovery-watch-row__body">
                    <span className={`mode-pill we-cluster-pill--${cluster.category}`}>{clusterCategoryLabel(cluster.category)}</span>
                    <small>{t('recoveryCenter.tile.clusters.frequency', { count: cluster.frequency })} · {clusterOwnerLabel(cluster.suggestedOwner)}</small>
                  </div>
                  <span className={`we-recovery-watch-row__state we-recovery-watch-row__state--${state}`}>{stateLabel}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// PendingApprovalsTile — waiting approval / human-form nodes.
// ─────────────────────────────────────────────────────────────────────────

export function PendingApprovalsTile({
  waitingNodes,
  runs,
  onOpenRun,
  onOpenTab,
  onApproveNode,
}: {
  waitingNodes: RunNode[]
  runs: RunSummary[]
  onOpenRun: (runId: string) => void | Promise<void>
  onOpenTab: (tab: ActiveTab) => void
  onApproveNode: (nodeId: string) => void | Promise<void>
}) {
  const { t } = useT()
  const top = waitingNodes.slice(0, 3)
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.approvals.title')}
      kicker={t('recoveryCenter.tile.approvals.kicker')}
      severity={waitingNodes.length === 0 ? 'success' : 'warning'}
      icon={<CheckSquare size={18} aria-hidden="true" />}
      testId="recovery-center-tile-approvals"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => onOpenTab('runs')}
          data-testid="recovery-center-approvals-open-all"
        >
          {t('recoveryCenter.tile.approvals.openAll')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {top.length === 0 ? (
        <AllClearState
          message={t('recoveryCenter.tile.approvals.empty')}
          testId="recovery-center-approvals-allclear"
        />
      ) : (
        <ul className="we-recovery-signoff">
          {top.map((node) => {
            const waiting = (node.stateJson as { waiting?: { kind?: string; title?: string } } | undefined)?.waiting
            const kind = waiting?.kind ?? 'approval'
            const title = waiting?.title
              ?? (kind === 'human_form' ? t('recoveryCenter.tile.approvals.formTitle') : t('recoveryCenter.tile.approvals.approvalTitle'))
            const matchingRun = runs.find((entry) => entry.workflowVersionId && entry.status === 'paused')
            const runId = matchingRun?.id
            return (
              <li key={node.nodeId} className="we-recovery-signoff-row" data-testid={`recovery-center-approvals-row-${node.nodeId}`}>
                <span className="we-recovery-signoff-row__ic" aria-hidden="true">
                  <ShieldAlert size={14} />
                </span>
                <div className="we-recovery-signoff-row__body">
                  <strong>{title}</strong>
                  <p>
                    <code>{node.nodeId}</code>
                    <span> · {kind === 'human_form' ? t('recoveryCenter.tile.approvals.kindForm') : t('recoveryCenter.tile.approvals.kindApproval')} · {t('recoveryCenter.tile.approvals.waiting')}</span>
                  </p>
                  <div className="we-recovery-signoff-row__acts">
                    {kind === 'approval' && (
                      <button
                        type="button"
                        className="command-button command-button-primary command-button-compact"
                        onClick={() => onApproveNode(node.nodeId)}
                      >
                        <Check size={14} aria-hidden="true" />
                        <span>{t('recoveryCenter.tile.approvals.apply')}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="command-button command-button-compact"
                      onClick={() => {
                        if (runId) void onOpenRun(runId)
                        onOpenTab('runs')
                      }}
                    >
                      {t('recoveryCenter.tile.approvals.hold')}
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// RecommendedActionsTile — renders the deterministic action list from
// `computeRecommendedActions` (logic lives in `./helpers.ts`).
// ─────────────────────────────────────────────────────────────────────────

export function RecommendedActionsTile({
  actions,
  onOpenTab,
}: {
  actions: RecommendedAction[]
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const iconByAction: Record<RecommendedActionId, React.ReactNode> = {
    resolve_approvals: <Users size={16} aria-hidden="true" />,
    recover_cluster: <Layers size={16} aria-hidden="true" />,
    triage_failures: <AlertTriangle size={16} aria-hidden="true" />,
    review_workflow_risk: <Gauge size={16} aria-hidden="true" />,
    run_getting_started: <PlayCircle size={16} aria-hidden="true" />,
    healthy_try_studio: <Sparkles size={16} aria-hidden="true" />,
  }
  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.tile.actions.title')}
      kicker={t('recoveryCenter.tile.actions.kicker')}
      severity={actions[0]?.severity ?? 'cobalt'}
      icon={<Compass size={18} aria-hidden="true" />}
      testId="recovery-center-tile-actions"
    >
      <ol className="we-recovery-center-actions">
        {actions.map((action) => (
          <li key={action.id} data-severity={action.severity} data-testid={`recovery-center-action-${action.id}`}>
            <span className="we-recovery-center-actions__icon" aria-hidden="true">
              {iconByAction[action.id]}
            </span>
            <div className="we-recovery-center-actions__copy">
              <strong>{action.title}</strong>
              <small>{action.body}</small>
            </div>
            <button
              type="button"
              className="command-button command-button-primary"
              onClick={() => onOpenTab(action.ctaTab)}
              data-testid={`recovery-center-action-cta-${action.id}`}
            >
              {action.ctaLabel}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
    </RecoveryCenterTile>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// BudgetTile — MTD AI spend bar. Owns its own `/billing/budget` fetch (a
// distinct endpoint from the panel's `/recovery/metrics`).
// ─────────────────────────────────────────────────────────────────────────

export function BudgetTile({ onOpenTab }: { onOpenTab: (tab: ActiveTab) => void }) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const [envelope, setEnvelope] = useState<BudgetEnvelope | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api('/billing/budget')
      .then((payload) => {
        if (cancelled) return
        setEnvelope(payload as BudgetEnvelope)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : t('recoveryCenter.budget.unavailableFallback'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [platformVersion, t])

  const band = budgetBand(envelope)
  // `budgetBand` already returns the exact tile-severity union — no remap.
  const tileSeverity = band
  const limit = envelope?.monthlyUsdLimit ?? null
  const spent = envelope?.monthlyUsdSpent ?? 0
  const hasBudget = limit !== null && limit > 0
  const ratio = hasBudget ? Math.min(1, spent / (limit ?? 1)) : 0
  const formatMoney = (value: number) => value.toFixed(2)

  return (
    <RecoveryCenterTile
      title={t('recoveryCenter.budget.title')}
      kicker={hasBudget ? t('recoveryCenter.budget.kickerUsed', { percent: (ratio * 100).toFixed(0) }) : t('recoveryCenter.budget.kickerNotConfigured')}
      severity={tileSeverity}
      icon={<Coins size={18} aria-hidden="true" />}
      testId="recovery-center-tile-budget"
      footer={(
        <button
          type="button"
          className="we-recovery-center-tile__link"
          onClick={() => {
            requestOperationsSection('reliability')
            onOpenTab('operations')
          }}
          data-testid="recovery-center-budget-open-settings"
        >
          {hasBudget ? t('recoveryCenter.budget.openSettings') : t('recoveryCenter.budget.setBudget')} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    >
      {loading && <p className="we-recovery-center-tile__empty">{t('recoveryCenter.budget.loading')}</p>}
      {error && (
        <p className="we-recovery-center-tile__empty" role="status">{t('recoveryCenter.budget.unavailable', { detail: error })}</p>
      )}
      {!loading && !error && !hasBudget && (
        <p className="we-recovery-center-tile__empty">
          {t('recoveryCenter.budget.notConfiguredBody')}
        </p>
      )}
      {!loading && !error && hasBudget && (
        <div className="we-recovery-center-budget" data-testid="recovery-center-budget-bar" data-band={band}>
          <div className="we-recovery-center-budget__row">
            <span className="we-recovery-center-budget__label">{t('recoveryCenter.budget.mtdLabel')}</span>
            <span className="we-recovery-center-budget__value">{t('recoveryCenter.budget.mtdValue', { spent: formatMoney(spent), limit: formatMoney(limit ?? 0) })}</span>
          </div>
          <div className="we-recovery-center-budget__bar" role="presentation" aria-hidden="true">
            <span className="we-recovery-center-budget__bar-rail" />
            <span
              className={`we-recovery-center-budget__bar-fill we-recovery-center-budget__bar-fill--${band}`}
              style={{ width: `${Math.max(2, ratio * 100)}%` }}
            />
          </div>
          <div className="we-recovery-center-budget__meta">
            <span>{t('recoveryCenter.budget.policyLabel')} <code>{envelope?.policy ?? 'warn'}</code></span>
            {envelope?.warningThresholdCrossed && (
              <span className="we-recovery-center-budget__pill" data-severity={band}>{t('recoveryCenter.budget.overWarning')}</span>
            )}
          </div>
        </div>
      )}
    </RecoveryCenterTile>
  )
}
