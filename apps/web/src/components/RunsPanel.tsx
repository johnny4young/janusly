/**
 * Right-side Runs tab body. Renders:
 *  - Metric strip (shared VitalSignsStrip): total / active / done / failed.
 *  - Active-run card with cancel + open-in-Lab + workflow-output details.
 *  - RunExplainChat for the active run ("Ask Janusly", above usage).
 *  - Usage summary card (per-org cost/quota breakdown).
 *  - Classified paused-node cards with safe resume actions.
 *  - Failed-nodes action cards (per-node retry).
 *  - Fork-eligible nodes action cards (per-node Lab fork).
 *  - DeadLettersPanel.
 *  - History list with Open / Lab / Export / Send actions per row.
 *  - 4 overlay dialogs (HumanForm, ReplayLab, ReplayLabFork, ReportDelivery)
 *    keyed off local state hooks.
 *
 * Used by:
 * - `RightPanel.tsx` (mounted in the runs branch of the dispatcher).
 */

import { useEffect, useState } from 'react'
import { Activity, CheckCircle2, CircleX, Copy, FlaskConical, GitBranch, ListChecks } from 'lucide-react'
import type { RunEvent, RunNode, RunSummary, SavedWorkflow, WorkflowInputSchemaShape } from '../types'
import { isTerminalRunStatus } from '@janusly/shared/src/status'
import { formatCompactDuration, formatStatusLabel, formatNodeDuration } from '../constants'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, useT } from '../i18n'
import { DeadLettersPanel } from './DeadLettersPanel'
import { RunExplainChat } from './RunExplainChat'
import { HumanFormDialog } from './HumanFormDialog'
import { ReplayLabDialog } from './ReplayLabDialog'
import { ReplayLabForkDialog } from './ReplayLabForkDialog'
import { ReportDeliveryDialog } from './ReportDeliveryDialog'
import { PanelChrome } from './panel-primitives'
import { UsageSummaryCard } from './UsageSummaryCard'
import { RunStreamChip } from './RunStreamChip'
import { VitalSignsStrip, withSeverityLabels, type VitalSignsTile } from './VitalSignsStrip'
import { pickErrorMessage } from './recovery-dialog/helpers'
import { getRunFinishedAt, getRunTerminalAt, getRunTriggerInput, getRunWaitingInfo, getRunWorkflowIdentity, type RunWaitKind } from '../run-observability'
import { RunHistoryList } from './RunHistoryList'

type HumanFormWaiting = {
  title?: string
  description?: string
  schema: WorkflowInputSchemaShape
  resumeToken: string
}

function readHumanFormWaiting(node: RunNode): HumanFormWaiting | null {
  const waiting = node.stateJson?.waiting
  if (!waiting || typeof waiting !== 'object' || Array.isArray(waiting)) return null
  const data = waiting as Record<string, unknown>
  if (data.kind !== 'human_form') return null
  if (typeof data.resumeToken !== 'string' || !data.resumeToken) return null
  if (!isWorkflowInputSchemaShape(data.schema)) return null
  return {
    title: typeof data.title === 'string' ? data.title : undefined,
    description: typeof data.description === 'string' ? data.description : undefined,
    schema: data.schema,
    resumeToken: data.resumeToken,
  }
}

function isWorkflowInputSchemaShape(value: unknown): value is WorkflowInputSchemaShape {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const schema = value as Record<string, unknown>
  if (!['string', 'number', 'boolean', 'object', 'array'].includes(String(schema.type))) return false
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) return false
    for (const child of Object.values(schema.properties as Record<string, unknown>)) {
      if (!isWorkflowInputSchemaShape(child)) return false
    }
  }
  if (schema.items !== undefined && !isWorkflowInputSchemaShape(schema.items)) return false
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(item => typeof item === 'string'))) return false
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return false
  return true
}

type RunsPanelProps = {
  runs: RunSummary[]
  workflows: SavedWorkflow[]
  usage: Record<string, number>
  runNodes: RunNode[]
  runEvents?: RunEvent[]
  activeRunId?: string | null
  onOpenRun: (id: string) => void
  onRefreshPlatform: () => void
  onApproveNode: (nodeId: string) => void
  onSubmitHumanForm: SubmitHumanFormHandler
  onReplayNode: (nodeId: string) => void
  onCancelActiveRun?: () => void | Promise<void>
  onReplayDeadLetter: (id: string, createdAtIso?: string) => boolean | Promise<boolean> | undefined
  onResolveDeadLetter: (id: string) => boolean | Promise<boolean> | undefined
}

type SubmitHumanFormResult = string[] | undefined
type SubmitHumanFormPromise = Promise<
  SubmitHumanFormResult
>
type SubmitHumanFormHandler = (
  nodeId: string,
  input: unknown,
  resumeToken: string,
) => SubmitHumanFormResult | SubmitHumanFormPromise

function waitKindLabelKey(kind: RunWaitKind): string {
  return `rightPanel.runs.waitKind.${kind}`
}

function waitActionLabelKey(kind: RunWaitKind): string {
  if (kind === 'approval') return 'rightPanel.runs.approveAndResume'
  if (kind === 'timer') return 'rightPanel.runs.resumeNow'
  if (kind === 'webhook') return 'rightPanel.runs.resumeManually'
  return 'rightPanel.runs.resume'
}

function canResumeWaitingKind(kind: RunWaitKind): boolean {
  // A child-run completion is the only safe resume signal for subworkflow
  // waits. Manually advancing the parent would violate the join boundary.
  return kind !== 'subworkflow'
}

export function RunsPanel({
  runs,
  workflows,
  usage,
  runNodes,
  runEvents = [],
  activeRunId,
  onOpenRun,
  onRefreshPlatform,
  onApproveNode,
  onSubmitHumanForm,
  onReplayNode,
  onCancelActiveRun,
  onReplayDeadLetter,
  onResolveDeadLetter,
}: RunsPanelProps) {
  const { t } = useT()
  const waitingNodes = runNodes.filter(node => node.status === 'waiting')
  const failedNodes = runNodes.filter(node => node.status === 'failed')
  const completedRuns = runs.filter(run => run.status === 'succeeded').length
  const activeRuns = runs.filter(run => run.status === 'running' || run.status === 'queued').length
  const failedRuns = runs.filter(run => run.status === 'failed').length
  const [activeHumanFormNodeId, setActiveHumanFormNodeId] = useState<string | null>(null)
  const [humanFormErrors, setHumanFormErrors] = useState<string[]>([])
  const [humanFormSubmitting, setHumanFormSubmitting] = useState(false)
  const addToast = useWorkflowStore(state => state.addToast)
  const setActiveTab = useWorkflowStore(state => state.setActiveTab)
  // Replay Lab source — set when the operator clicks "Open in Lab" from
  // the active-run card or a history row. The dialog mounts overlay-style
  // while non-null and the source run id stays around as state until the
  // operator dismisses the dialog.
  const [labSourceRun, setLabSourceRun] = useState<RunSummary | null>(null)
  // Replay Lab Fork target node id — set when the operator clicks a
  // per-node "Fork at <nodeId>" button. The dialog mounts overlay-style
  // against the active run; on success it switches the active run id
  // to the new fork run and unmounts.
  const [forkTargetNodeId, setForkTargetNodeId] = useState<string | null>(null)
  // Report-delivery source — set when the operator clicks "Send" next
  // to the Export action. Dialog mounts overlay-style while non-null.
  const [deliveryRun, setDeliveryRun] = useState<RunSummary | null>(null)
  const activeHumanFormNode = activeHumanFormNodeId
    ? waitingNodes.find(node => node.nodeId === activeHumanFormNodeId) ?? null
    : null
  const activeHumanForm = activeHumanFormNode ? readHumanFormWaiting(activeHumanFormNode) : null

  // Cancellable when the active run is in a non-terminal status.
  const activeRun = activeRunId ? runs.find(run => run.id === activeRunId) : null
  const activeRunTraceId = activeRun?.traceId ?? null
  const activeRunIdentity = activeRun ? getRunWorkflowIdentity(activeRun) : null
  const activeRunInput = activeRun ? getRunTriggerInput(activeRun) : undefined
  const activeRunFinishedAt = getRunTerminalAt(runEvents) ?? getRunFinishedAt(runNodes)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const shouldTickClock = Boolean(activeRun && !isTerminalRunStatus(activeRun.status)) || waitingNodes.length > 0
  useEffect(() => {
    if (!shouldTickClock) return
    setClockNow(Date.now())
    const interval = window.setInterval(() => setClockNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [shouldTickClock])

  const startedAtMs = activeRun?.createdAt ? Date.parse(activeRun.createdAt) : Number.NaN
  const finishedAtMs = activeRunFinishedAt ? Date.parse(activeRunFinishedAt) : Number.NaN
  const activeRunDuration = Number.isFinite(startedAtMs)
    ? formatCompactDuration(Math.max(0, (Number.isFinite(finishedAtMs) && activeRun && isTerminalRunStatus(activeRun.status) ? finishedAtMs : clockNow) - startedAtMs))
    : null
  const isActiveRunCancellable = Boolean(
    activeRunId && onCancelActiveRun && (!activeRun || !isTerminalRunStatus(activeRun.status)),
  )

  // Fork-eligible nodes: only terminal node states (succeeded / failed)
  // are forkable, and only when the source run itself is terminal and
  // NOT already a sandbox replay. The server enforces both invariants
  // too — this UI gate just hides the action so the operator doesn't
  // click into a guaranteed 4xx.
  const forkableNodes = (activeRun && !activeRun.replayMode && isTerminalRunStatus(activeRun.status))
    ? runNodes.filter(node => node.status === 'succeeded' || node.status === 'failed')
    : []

  // Unified metric recipe (shared `VitalSignsStrip`): Total neutral, Active
  // info, Done healthy, Failed danger — and the Failed tile graduates to a
  // clickable shortcut into the Recovery Center (home) whenever there's
  // something to recover, so "16 failed" stops being a dead number.
  const runMetricTiles: VitalSignsTile[] = [
    {
      icon: <ListChecks size={15} aria-hidden="true" />,
      label: t('rightPanel.runs.metric.total') as string,
      display: String(runs.length),
      severity: 'neutral',
      numericValue: runs.length,
      rationale: t('rightPanel.runs.metric.totalSub') as string,
      testId: 'runs-metric-total',
    },
    {
      icon: <Activity size={15} aria-hidden="true" />,
      label: t('rightPanel.runs.metric.active') as string,
      display: String(activeRuns),
      severity: 'info',
      numericValue: activeRuns,
      rationale: t('rightPanel.runs.metric.activeSub') as string,
      testId: 'runs-metric-active',
    },
    {
      icon: <CheckCircle2 size={15} aria-hidden="true" />,
      label: t('rightPanel.runs.metric.done') as string,
      display: String(completedRuns),
      severity: 'healthy',
      numericValue: completedRuns,
      rationale: t('rightPanel.runs.metric.doneSub') as string,
      testId: 'runs-metric-done',
    },
    {
      icon: <CircleX size={15} aria-hidden="true" />,
      label: t('rightPanel.runs.metric.failed') as string,
      display: String(failedRuns),
      severity: failedRuns > 0 ? 'unhealthy' : 'healthy',
      numericValue: failedRuns,
      rationale: failedRuns > 0
        ? (t('rightPanel.runs.metric.failedOpen') as string)
        : (t('rightPanel.runs.metric.failedClear') as string),
      onClick: failedRuns > 0 ? () => setActiveTab('home') : undefined,
      ariaLabel: failedRuns > 0 ? (t('rightPanel.runs.metric.failedAria') as string) : undefined,
      testId: 'runs-metric-failed',
    },
  ]

  return (
    <PanelChrome title={t('rightPanel.runs.title') as string} description={t('rightPanel.runs.description') as string} icon={<Activity size={18} />}>
      <VitalSignsStrip
        tiles={withSeverityLabels(runMetricTiles, t)}
        ariaLabel={t('rightPanel.runs.summaryAria') as string}
        testId="runs-metric-strip"
      />

      {activeRunId && (
        <section className="panel-card we-run-overview" data-testid="run-overview">
          <div className="split-row we-run-overview__header">
            <span className="we-run-overview__title">
              <strong>{activeRunIdentity?.name ?? activeRunIdentity?.id ?? t('rightPanel.runs.activeRun')}</strong>
              {activeRun && <span className="status-pill" data-status={activeRun.status}>{formatStatusLabel(activeRun.status)}</span>}
              <RunStreamChip />
            </span>
            <div className="we-run-overview__actions">
              <button
                type="button"
                className="small-command"
                onClick={() => setActiveTab('reasoning')}
              >
                <Activity size={12} aria-hidden="true" /> {t('rightPanel.runs.viewTimeline')}
              </button>
              {activeRun && !activeRun.replayMode && isTerminalRunStatus(activeRun.status) && (
                <button
                  type="button"
                  className="small-command"
                  onClick={() => setLabSourceRun(activeRun)}
                  data-testid="active-run-replay-in-lab"
                >
                  <FlaskConical size={12} aria-hidden="true" /> {t('rightPanel.runs.openInLab')}
                </button>
              )}
              <button
                type="button"
                className="small-command"
                onClick={() => onCancelActiveRun?.()}
                disabled={!isActiveRunCancellable}
              >
                {t('rightPanel.runs.cancelRun')}
              </button>
            </div>
          </div>
          <dl className="we-run-overview__facts">
            <div>
              <dt>{t('rightPanel.runs.runId')}</dt>
              <dd><code title={activeRunId}>{activeRunId.slice(0, 12)}…</code></dd>
            </div>
            {activeRun?.workflowVersionId && (
              <div>
                <dt>{t('rightPanel.runs.versionRef')}</dt>
                <dd><code title={activeRun.workflowVersionId}>{activeRun.workflowVersionId.slice(0, 12)}…</code></dd>
              </div>
            )}
            <div>
              <dt>{t('rightPanel.runs.startedAt')}</dt>
              <dd>{activeRun?.createdAt ? new Date(activeRun.createdAt).toLocaleString(getResolvedLocale()) : '—'}</dd>
            </div>
            <div>
              <dt>{t('rightPanel.runs.duration')}</dt>
              <dd>{activeRunDuration ?? '—'}</dd>
            </div>
            {activeRunTraceId && (
              <div className="we-run-overview__trace">
                <dt>{t('rightPanel.runs.traceId')}</dt>
                <dd>
                  <code title={activeRunTraceId}>{activeRunTraceId.slice(0, 12)}…</code>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('rightPanel.runs.copyTrace') as string}
                    title={t('rightPanel.runs.copyTrace') as string}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(activeRunTraceId)
                        addToast(t('rightPanel.runs.traceCopied') as string, 'success')
                      } catch {
                        addToast(t('rightPanel.runs.traceCopyFailed') as string, 'error')
                      }
                    }}
                  >
                    <Copy size={13} aria-hidden="true" />
                  </button>
                </dd>
              </div>
            )}
          </dl>
          <p className="helper-text we-run-overview__status-copy">
            {activeRun
              ? (isActiveRunCancellable
                ? t('rightPanel.runs.activeRunStatusCancellable', { status: formatStatusLabel(activeRun.status) })
                : t('rightPanel.runs.activeRunStatusFinished', { status: formatStatusLabel(activeRun.status) }))
              : t('rightPanel.runs.activeRunLoading')}
          </p>
          {activeRunInput !== undefined && (
            <details data-testid="run-trigger-input" className="we-run-overview__payload">
              <summary>{t('rightPanel.runs.triggerInput')}</summary>
              <pre className="code-field">{JSON.stringify(activeRunInput, null, 2)}</pre>
            </details>
          )}
          {activeRun?.status === 'succeeded' && activeRun.outputJson && Object.keys(activeRun.outputJson).length > 0 && (
            <details data-testid="workflow-output" className="we-run-overview__payload">
              <summary>{t('rightPanel.runs.workflowOutput')}</summary>
              <pre className="code-field">
                {JSON.stringify(activeRun.outputJson, null, 2)}
              </pre>
            </details>
          )}
        </section>
      )}

      <RunExplainChat runId={activeRunId} />

      <UsageSummaryCard usage={usage} onRefreshPlatform={onRefreshPlatform} />

      {waitingNodes.length > 0 && (
        <section className="panel-card action-card" data-testid="waiting-steps">
          <div>
            <strong>{t('rightPanel.runs.pausedTitle')}</strong>
            <p className="helper-text">{t('rightPanel.runs.pausedDescription')}</p>
          </div>
          {waitingNodes.map(node => {
            const form = readHumanFormWaiting(node)
            const waiting = getRunWaitingInfo(node)
            const waitingSinceMs = waiting.waitingSince ? Date.parse(waiting.waitingSince) : Number.NaN
            const wakeAtMs = waiting.wakeAt ? Date.parse(waiting.wakeAt) : Number.NaN
            const deadlineAtMs = waiting.deadlineAt ? Date.parse(waiting.deadlineAt) : Number.NaN
            const waitDuration = Number.isFinite(waitingSinceMs) ? formatCompactDuration(Math.max(0, clockNow - waitingSinceMs)) : null
            const wakeDuration = Number.isFinite(wakeAtMs) ? formatCompactDuration(Math.max(0, wakeAtMs - clockNow)) : null
            const deadlineDuration = Number.isFinite(deadlineAtMs) ? formatCompactDuration(Math.max(0, deadlineAtMs - clockNow)) : null
            const approvalOwnerCopy = waiting.assignee
              ? waiting.timeoutState === 'escalated'
                ? t('rightPanel.runs.approvalEscalated', {
                  previous: waiting.escalatedFrom ?? t('rightPanel.runs.unassigned'),
                  assignee: waiting.assignee,
                })
                : t('rightPanel.runs.approvalAssignee', { assignee: waiting.assignee })
              : null
            return (
              <article key={node.nodeId} className="we-wait-card" data-wait-kind={waiting.kind} data-testid={`waiting-step-${node.nodeId}`}>
                <div className="split-row">
                  <span className="we-pill" data-tone={waiting.kind}>{t(waitKindLabelKey(waiting.kind))}</span>
                  <code>{node.nodeId}</code>
                </div>
                <div>
                  <strong>{waiting.title ?? t('rightPanel.runs.waitingStep', { nodeId: node.nodeId })}</strong>
                  {waiting.description && <p className="helper-text">{waiting.description}</p>}
                </div>
                {(waitDuration || wakeDuration || deadlineDuration || waiting.assignee || waiting.kind === 'approval') && (
                  <div className="we-wait-card__timing">
                    {waitDuration && <span>{t('rightPanel.runs.waitingFor', { duration: waitDuration })}</span>}
                    {wakeDuration && (
                      <span>{wakeAtMs <= clockNow
                        ? t('rightPanel.runs.wakeDue')
                        : t('rightPanel.runs.wakesIn', { duration: wakeDuration })}</span>
                    )}
                    {approvalOwnerCopy && (
                      <span data-testid={`waiting-owner-${node.nodeId}`}>{approvalOwnerCopy}</span>
                    )}
                    {waiting.kind === 'approval' && (
                      <span
                        className="we-sr-only"
                        data-testid={`waiting-owner-announcement-${node.nodeId}`}
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        {waiting.timeoutState === 'escalated' ? approvalOwnerCopy : ''}
                      </span>
                    )}
                    {deadlineDuration && waiting.timeoutState !== 'escalated' && (
                      <span>{deadlineAtMs <= clockNow
                        ? t('rightPanel.runs.approvalDeadlineDue')
                        : t('rightPanel.runs.approvalDeadlineIn', { duration: deadlineDuration })}</span>
                    )}
                    {waiting.onTimeout === 'escalate' && waiting.escalateTo && waiting.timeoutState !== 'escalated' && (
                      <span>{t('rightPanel.runs.approvalEscalatesTo', { assignee: waiting.escalateTo })}</span>
                    )}
                  </div>
                )}
                {form ? (
                <button
                  className="small-command small-command--primary"
                  onClick={() => {
                    setHumanFormErrors([])
                    setActiveHumanFormNodeId(node.nodeId)
                  }}
                >
                  {t('rightPanel.runs.fillForm', { nodeId: node.nodeId })}
                </button>
                ) : canResumeWaitingKind(waiting.kind) ? (
                  <button className="small-command" onClick={() => onApproveNode(node.nodeId)}>
                    {t(waitActionLabelKey(waiting.kind), { nodeId: node.nodeId })}
                  </button>
                ) : (
                  <span className="helper-text">{t('rightPanel.runs.waitAutomatic')}</span>
                )}
              </article>
            )
          })}
        </section>
      )}

      {activeHumanFormNode && activeHumanForm && (
        <HumanFormDialog
          title={activeHumanForm.title}
          description={activeHumanForm.description}
          schema={activeHumanForm.schema}
          serverErrors={humanFormErrors}
          submitting={humanFormSubmitting}
          onCancel={() => {
            setActiveHumanFormNodeId(null)
            setHumanFormErrors([])
          }}
          onSubmit={async (input) => {
            setHumanFormSubmitting(true)
            setHumanFormErrors([])
            try {
              const result = await onSubmitHumanForm(activeHumanFormNode.nodeId, input, activeHumanForm.resumeToken)
              if (Array.isArray(result) && result.length > 0) {
                setHumanFormErrors(result)
                return
              }
              setActiveHumanFormNodeId(null)
            } finally {
              setHumanFormSubmitting(false)
            }
          }}
        />
      )}

      {failedNodes.length > 0 && (
        <section className="panel-card action-card">
          <div>
            <strong>{t('rightPanel.runs.attentionTitle')}</strong>
            <p className="helper-text">{t('rightPanel.runs.attentionDescription')}</p>
          </div>
          {failedNodes.map(node => {
            const errorMessage = pickErrorMessage(node.errorJson)
            const duration = formatNodeDuration(node.startedAt, node.finishedAt)
            const meta: string[] = []
            if (typeof node.attempts === 'number' && node.attempts > 0) {
              meta.push(t('rightPanel.runs.nodeAttempt', { count: node.attempts }) as string)
            }
            if (duration) meta.push(duration)
            return (
              <div key={node.nodeId} className="we-failed-node" data-testid={`failed-node-${node.nodeId}`}>
                <div className="split-row">
                  <code className="we-failed-node__id">{node.nodeId}</code>
                  {meta.length > 0 && (
                    <span className="helper-text we-failed-node__meta">{meta.join(' · ')}</span>
                  )}
                </div>
                {errorMessage && (
                  <p className="we-failed-node__error" title={errorMessage}>{errorMessage}</p>
                )}
                <button className="small-command" onClick={() => onReplayNode(node.nodeId)}>
                  {t('rightPanel.runs.retry', { nodeId: node.nodeId })}
                </button>
              </div>
            )
          })}
        </section>
      )}

      {forkableNodes.length > 0 && (
        <section className="panel-card action-card">
          <div>
            <strong>{t('replayLab.fork.sectionKicker')}</strong>
            <p className="helper-text">{t('replayLab.fork.sectionDescription')}</p>
          </div>
          {forkableNodes.map(node => (
            <button
              key={node.nodeId}
              type="button"
              className="small-command"
              onClick={() => setForkTargetNodeId(node.nodeId)}
              data-testid={`fork-in-lab-${node.nodeId}`}
            >
              <GitBranch size={12} aria-hidden="true" />
              {' '}
              {node.status === 'succeeded'
                ? t('replayLab.fork.buttonStatusSucceeded', { nodeId: node.nodeId })
                : t('replayLab.fork.buttonStatusFailed', { nodeId: node.nodeId })}
            </button>
          ))}
        </section>
      )}

      <DeadLettersPanel
        onRefresh={onRefreshPlatform}
        onReplay={onReplayDeadLetter}
        onResolve={onResolveDeadLetter}
      />

      <RunHistoryList
        runs={runs}
        workflows={workflows}
        onOpenRun={onOpenRun}
        onOpenLab={setLabSourceRun}
        onSend={setDeliveryRun}
      />

      {labSourceRun && (
        <ReplayLabDialog
          sourceRun={{
            id: labSourceRun.id,
            status: labSourceRun.status,
            workflowVersionId: labSourceRun.workflowVersionId,
            createdAt: labSourceRun.createdAt ?? null,
          }}
          onClose={() => setLabSourceRun(null)}
        />
      )}

      {forkTargetNodeId && activeRun && (
        <ReplayLabForkDialog
          sourceRun={{
            id: activeRun.id,
            status: activeRun.status,
            createdAt: activeRun.createdAt ?? null,
          }}
          forkNodeId={forkTargetNodeId}
          onClose={() => setForkTargetNodeId(null)}
        />
      )}

      {deliveryRun && (
        <ReportDeliveryDialog
          sourceRun={{
            id: deliveryRun.id,
            status: deliveryRun.status,
          }}
          onClose={() => setDeliveryRun(null)}
        />
      )}
    </PanelChrome>
  )
}
