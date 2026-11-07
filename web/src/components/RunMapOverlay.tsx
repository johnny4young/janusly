import { createContext, useContext, useEffect, useState, type FocusEvent } from 'react'
import { useReactFlow } from '@xyflow/react'
import { Clock, UserRound } from 'lucide-react'

import { formatCompactDuration } from '../constants'
import { getResolvedLocale, useT } from '../i18n'
import { formatRunCost, formatTokenCount, liveElapsedMs, type RunMap, type RunMapNodeOverlay } from '../run-map'
import type { WorkflowGraphNode } from '../types'
import { Button } from './ui/Button'

export type RunMapActions = {
  pendingNodeId: string | null
  decide: (nodeId: string, decision: 'approve' | 'deny') => void
  openForm: (nodeId: string) => void
  rerun: (nodeId: string) => void
  openRun: (runId: string) => void
}

type NodeAction = {
  id: string
  label: string
  name: string
  variant?: 'primary' | 'danger' | 'ghost'
  decides?: boolean
  run: (actions: RunMapActions) => void
}

/** Present only on the run map; the editor canvas shows the facts without actions. */
export const RunMapActionsContext = createContext<RunMapActions | null>(null)

function useLiveElapsed(overlay: RunMapNodeOverlay): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (overlay.liveSince === null) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [overlay.liveSince])
  return liveElapsedMs(overlay, now)
}

export function RunMapNodeFlags({ overlay }: { overlay: RunMapNodeOverlay }) {
  const { t } = useT()
  if (!overlay.stuck && !overlay.needsYou) return null
  return (
    <div className="workflow-node-flags">
      {overlay.stuck && (
        <span className="we-pill" data-tone="warning" data-testid="workflow-node-stuck">
          <Clock size={11} aria-hidden="true" />
          {t('canvas.runMap.stuck')}
        </span>
      )}
      {overlay.needsYou && (
        <span className="we-pill" data-tone="primary" data-testid="workflow-node-needs-you">
          <UserRound size={11} aria-hidden="true" />
          {t('canvas.runMap.needsYou')}
        </span>
      )}
    </div>
  )
}

/** Attempts, elapsed time and AI cost for one step, plus what the viewer can do from here. */
export function RunMapNodeFacts({ nodeId, title, overlay }: { nodeId: string; title: string; overlay: RunMapNodeOverlay }) {
  const { t } = useT()
  const actions = useContext(RunMapActionsContext)
  const flow = useReactFlow<WorkflowGraphNode>()
  const elapsed = useLiveElapsed(overlay)
  const locale = getResolvedLocale()
  const { decision, childRunId } = overlay
  const buttons: NodeAction[] = []
  if (decision?.kind === 'tool_approval' || decision?.kind === 'approval') {
    buttons.push({ id: 'approve', label: t('rightPanel.runs.toolApproval.approve'), name: t('canvas.runMap.approveAria', { step: title }), variant: 'primary', decides: true, run: a => a.decide(nodeId, 'approve') })
  }
  if (decision?.kind === 'tool_approval') {
    buttons.push({ id: 'deny', label: t('rightPanel.runs.toolApproval.deny'), name: t('canvas.runMap.denyAria', { step: title }), variant: 'danger', decides: true, run: a => a.decide(nodeId, 'deny') })
  }
  if (decision?.kind === 'human_form') {
    buttons.push({ id: 'form', label: t('canvas.runMap.fillForm'), name: t('canvas.runMap.fillFormAria', { step: title }), variant: 'primary', decides: true, run: a => a.openForm(nodeId) })
  }
  if (overlay.rerun) {
    buttons.push({ id: 'rerun', label: t('canvas.runMap.rerun'), name: t('runWorkspace.rerun.title', { nodeId: title }), run: a => a.rerun(nodeId) })
  }
  if (childRunId) {
    buttons.push({ id: 'child', label: t('canvas.runMap.childRun'), name: t('canvas.runMap.childRunAria', { step: title }), variant: 'ghost', run: a => a.openRun(childRunId) })
  }

  // Keyboard focus can land on a node outside the viewport; pan to it instead
  // of letting the browser scroll the clipped canvas.
  const reveal = (event: FocusEvent<HTMLDivElement>) => {
    const frame = event.currentTarget.closest('.react-flow')
    const box = event.currentTarget.closest('.react-flow__node')?.getBoundingClientRect()
    if (!frame || !box) return
    frame.scrollTop = 0
    frame.scrollLeft = 0
    const view = frame.getBoundingClientRect()
    if (box.left >= view.left && box.right <= view.right && box.top >= view.top && box.bottom <= view.bottom) return
    const node = flow.getNode(nodeId)
    if (!node) return
    void flow.setCenter(
      node.position.x + (node.measured?.width ?? box.width) / 2,
      node.position.y + (node.measured?.height ?? box.height) / 2,
      { zoom: flow.getZoom(), duration: 150 },
    )
  }

  return (
    <>
      <dl className="workflow-node-facts" data-testid="workflow-node-facts">
        {overlay.attempts > 1 && (
          <div>
            <dt className="we-sr-only">{t('canvas.runMap.attempts')}</dt>
            <dd>{t('canvas.runMap.attempt', { count: overlay.attempts })}</dd>
          </div>
        )}
        {elapsed !== null && (
          <div>
            <dt className="we-sr-only">{t('canvas.runMap.time')}</dt>
            <dd data-testid="workflow-node-elapsed">{formatCompactDuration(elapsed)}</dd>
          </div>
        )}
        {(overlay.costUsd > 0 || overlay.tokens > 0) && (
          <div title={t('canvas.runMap.tokensValue', { tokens: formatTokenCount(overlay.tokens, locale) })}>
            <dt className="we-sr-only">{t('canvas.runMap.cost')}</dt>
            <dd data-testid="workflow-node-cost">{formatRunCost(overlay.costUsd, locale)}</dd>
          </div>
        )}
      </dl>
      {actions && buttons.length > 0 && (
        <div className="workflow-node-actions nodrag nopan" onFocus={reveal}>
          {buttons.map(button => (
            <Button
              key={button.id}
              size="sm"
              variant={button.variant}
              className="nodrag nopan"
              disabled={button.decides && actions.pendingNodeId === nodeId}
              aria-label={button.name}
              data-testid={`run-map-${button.id}-${nodeId}`}
              onClick={(event) => {
                event.stopPropagation()
                button.run(actions)
              }}
            >
              {button.label}
            </Button>
          ))}
        </div>
      )}
    </>
  )
}

/** Run totals and the stuck / needs-you counts for the canvas header. */
export function RunMapTotals({ map, overlays }: { map: RunMap; overlays: ReadonlyMap<string, RunMapNodeOverlay> }) {
  const { t } = useT()
  const locale = getResolvedLocale()
  let stuck = 0
  let needsYou = 0
  for (const overlay of overlays.values()) {
    if (overlay.stuck) stuck += 1
    if (overlay.needsYou) needsYou += 1
  }
  return (
    <>
      <dl className="canvas-run-totals" data-testid="run-map-totals">
        <div>
          <dt>{t('canvas.runMap.cost')}</dt>
          <dd>{formatRunCost(map.totals.costUsd, locale)}</dd>
        </div>
        <div>
          <dt>{t('canvas.runMap.tokens')}</dt>
          <dd>{formatTokenCount(map.totals.tokens, locale)}</dd>
        </div>
      </dl>
      <span className="canvas-run-flags" role="status">
        {stuck > 0 && (
          <span className="we-pill" data-tone="warning" data-testid="run-map-stuck-count">
            <Clock size={11} aria-hidden="true" />
            {t('canvas.runMap.stuckCount', { count: stuck })}
          </span>
        )}
        {needsYou > 0 && (
          <span className="we-pill" data-tone="primary" data-testid="run-map-needs-you-count">
            <UserRound size={11} aria-hidden="true" />
            {t('canvas.runMap.needsYouCount', { count: needsYou })}
          </span>
        )}
      </span>
    </>
  )
}
