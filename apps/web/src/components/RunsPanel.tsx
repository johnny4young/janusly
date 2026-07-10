/**
 * Right-side Runs tab body. Renders:
 *  - Metric strip (shared VitalSignsStrip): total / active / done / failed.
 *  - Active-run card with cancel + open-in-Lab + workflow-output details.
 *  - RunExplainChat for the active run ("Ask Janusly", above usage).
 *  - Usage summary card (per-org cost/quota breakdown).
 *  - Paused-nodes action cards (human-form + approval pickers).
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

import { useState } from 'react'
import { Activity, CheckCircle2, CircleX, Download, FlaskConical, GitBranch, ListChecks, Send } from 'lucide-react'
import type { RunNode, RunSummary, WorkflowInputSchemaShape } from '../types'
import { isTerminalRunStatus } from '@janusly/shared/src/status'
import { formatStatusLabel } from '../constants'
import { downloadFromApi } from '../api'
import { useWorkflowStore } from '../store'
import { getResolvedLocale, useT } from '../i18n'
import { DeadLettersPanel } from './DeadLettersPanel'
import { RunExplainChat } from './RunExplainChat'
import { HumanFormDialog } from './HumanFormDialog'
import { ReplayLabDialog } from './ReplayLabDialog'
import { ReplayLabForkDialog } from './ReplayLabForkDialog'
import { ReportDeliveryDialog } from './ReportDeliveryDialog'
import { EmptyView, PanelChrome } from './panel-primitives'
import { UsageSummaryCard } from './UsageSummaryCard'
import { RunStreamChip } from './RunStreamChip'
import { VitalSignsStrip, withSeverityLabels, type VitalSignsTile } from './VitalSignsStrip'
import { useVirtualList } from '../hooks/useVirtualList'

/** Fixed row PITCH (CSS px) for the virtualized run-history list. The history
 *  cards are made uniform-height (the optional "Lab" action reserves its slot),
 *  so a single pitch windows the list correctly. Tuned to the rendered card +
 *  its bottom margin; verify in a real browser when the card layout changes. */
const RUN_ROW_HEIGHT = 226

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
  usage: Record<string, number>
  runNodes: RunNode[]
  activeRunId?: string | null
  onOpenRun: (id: string) => void
  onRefreshPlatform: () => void
  onApproveNode: (nodeId: string) => void
  onSubmitHumanForm: SubmitHumanFormHandler
  onReplayNode: (nodeId: string) => void
  onCancelActiveRun?: () => void | Promise<void>
  onReplayDeadLetter: (id: string) => void
  onResolveDeadLetter: (id: string) => void
}

type SubmitHumanFormResult = string[] | void
type SubmitHumanFormPromise = Promise<
  SubmitHumanFormResult
>
type SubmitHumanFormHandler = (
  nodeId: string,
  input: unknown,
  resumeToken: string,
) => SubmitHumanFormResult | SubmitHumanFormPromise

export function RunsPanel({
  runs,
  usage,
  runNodes,
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
  // Window the run-history list so a large org's history (capped 100/200 by the
  // API) doesn't mount hundreds of multi-button cards on every platformVersion
  // bump. No resetScrollKey — the list refetches on each bump (a new `runs`
  // reference with identical content), and resetting scroll there would jump the
  // operator to the top on every tick. Mirrors DeadLettersPanel's windowing.
  const {
    containerRef: runListRef,
    visibleItems: visibleRuns,
    totalHeight: runListTotalHeight,
    startOffset: runListStartOffset,
  } = useVirtualList({ items: runs, rowHeight: RUN_ROW_HEIGHT })
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
        <section className="panel-card">
          <div className="split-row">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <strong>{t('rightPanel.runs.activeRun')}</strong>
              <RunStreamChip />
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
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
          <p className="helper-text">
            {activeRun
              ? (isActiveRunCancellable
                ? t('rightPanel.runs.activeRunStatusCancellable', { status: activeRun.status })
                : t('rightPanel.runs.activeRunStatusFinished', { status: activeRun.status }))
              : t('rightPanel.runs.activeRunLoading')}
          </p>
          {activeRun?.status === 'succeeded' && activeRun.outputJson && Object.keys(activeRun.outputJson).length > 0 && (
            <details data-testid="workflow-output" style={{ marginTop: 12 }}>
              <summary>{t('rightPanel.runs.workflowOutput')}</summary>
              <pre className="code-field" style={{ marginTop: 8, padding: 8 }}>
                {JSON.stringify(activeRun.outputJson, null, 2)}
              </pre>
            </details>
          )}
        </section>
      )}

      <RunExplainChat runId={activeRunId} />

      <UsageSummaryCard usage={usage} onRefreshPlatform={onRefreshPlatform} />

      {waitingNodes.length > 0 && (
        <section className="panel-card action-card">
          <div>
            <strong>{t('rightPanel.runs.pausedTitle')}</strong>
            <p className="helper-text">{t('rightPanel.runs.pausedDescription')}</p>
          </div>
          {waitingNodes.map(node => {
            const form = readHumanFormWaiting(node)
            if (form) {
              return (
                <button
                  key={node.nodeId}
                  className="small-command small-command--primary"
                  onClick={() => {
                    setHumanFormErrors([])
                    setActiveHumanFormNodeId(node.nodeId)
                  }}
                >
                  {t('rightPanel.runs.fillForm', { nodeId: node.nodeId })}
                </button>
              )
            }
            return (
              <button key={node.nodeId} className="small-command" onClick={() => onApproveNode(node.nodeId)}>
                {t('rightPanel.runs.resume', { nodeId: node.nodeId })}
              </button>
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
          {failedNodes.map(node => (
            <button key={node.nodeId} className="small-command" onClick={() => onReplayNode(node.nodeId)}>
              {t('rightPanel.runs.retry', { nodeId: node.nodeId })}
            </button>
          ))}
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

      <div className="panel-list">
        <div className="section-kicker">{t('rightPanel.runs.historyKicker')}</div>
        {runs.length === 0 && <EmptyView icon={<Activity size={22} />} title={t('rightPanel.runs.historyEmpty.title') as string} body={t('rightPanel.runs.historyEmpty.body') as string} />}
        {runs.length > 0 && (
          <div ref={runListRef} className="we-virtual-list" data-testid="runs-history-virtual-list">
            <div style={{ height: runListTotalHeight, position: 'relative' }}>
              <div style={{ transform: `translateY(${runListStartOffset}px)` }}>
                {visibleRuns.map(({ item: run }) => {
                  const showLabAction = !run.replayMode && isTerminalRunStatus(run.status)
                  return (
                    <div key={run.id} className="list-card we-run-history-card" role="group">
                      <button type="button" className="list-card-row" onClick={() => onOpenRun(run.id)}>
                        <div className="split-row" style={{ width: '100%' }}>
                          <strong>{run.id.slice(0, 8)}…</strong>
                          <span className="status-pill" data-status={run.status}>{formatStatusLabel(run.status)}</span>
                        </div>
                        <span>{run.createdAt ? new Date(run.createdAt).toLocaleString(getResolvedLocale()) : (t('rightPanel.runs.runFallback') as string)}</span>
                        <span className="list-card-action">{t('rightPanel.runs.openTimeline')}</span>
                      </button>
                      {/* The Lab action reserves its slot even when not applicable so
                          every card is the same height — the virtual window needs a
                          fixed row pitch. Hidden + non-interactive when the run isn't
                          lab-eligible (non-terminal or already a replay). */}
                      <button
                        type="button"
                        className="small-command we-replay-lab-history-button"
                        onClick={showLabAction ? () => setLabSourceRun(run) : undefined}
                        disabled={!showLabAction}
                        aria-hidden={showLabAction ? undefined : true}
                        tabIndex={showLabAction ? undefined : -1}
                        style={showLabAction ? undefined : { visibility: 'hidden' }}
                        data-testid={showLabAction ? `history-replay-in-lab-${run.id}` : undefined}
                        aria-label={t('rightPanel.runs.replayInLabAria', { id: run.id }) as string}
                      >
                        <FlaskConical size={12} aria-hidden="true" /> {t('rightPanel.runs.lab')}
                      </button>
                      <button
                        type="button"
                        className="small-command we-run-history-export-button"
                        onClick={async () => {
                          try {
                            await downloadFromApi(`/reports/run-explain?runId=${encodeURIComponent(run.id)}`)
                            addToast(t('rightPanel.runs.exportSuccess') as string, 'success')
                          } catch (err) {
                            const message = err instanceof Error ? err.message : (t('rightPanel.runs.exportFailed') as string)
                            addToast(message, 'error')
                          }
                        }}
                        data-testid={`history-export-${run.id}`}
                        aria-label={t('rightPanel.runs.exportAria', { id: run.id }) as string}
                      >
                        <Download size={12} aria-hidden="true" /> {t('rightPanel.runs.export')}
                      </button>
                      <button
                        type="button"
                        className="small-command we-run-history-send-button"
                        onClick={() => setDeliveryRun(run)}
                        data-testid={`history-send-${run.id}`}
                        aria-label={t('rightPanel.runs.sendAria', { id: run.id }) as string}
                      >
                        <Send size={12} aria-hidden="true" /> {t('rightPanel.runs.send')}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

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
