import { useId, useMemo } from 'react'
import { Activity, CheckCircle2, CircleX, Wrench } from 'lucide-react'

import { formatCompactDuration } from '../constants'
import { useRunMap, useRunMapFailed } from '../hooks/useRunMap'
import { useT } from '../i18n'
import { projectAgentLanes, type LaneStepView } from '../run-map'
import './RunAgentLanes.css'

const TONE_ICON = { tool: Wrench, success: CheckCircle2, error: CircleX, info: Activity } as const

function offsetMs(view: LaneStepView, startMs: number): number | null {
  const at = view.step.at ? Date.parse(view.step.at) : Number.NaN
  return Number.isFinite(at) && Number.isFinite(startMs) ? Math.max(0, at - startMs) : null
}

/** The Agents tab: each agent step's lane of steps and tool calls, from the run map. */
export function RunAgentLanes({ runId }: { runId: string }) {
  const { t } = useT()
  const idPrefix = useId()
  const snapshot = useRunMap(runId)
  const failed = useRunMapFailed(runId)
  const lanes = useMemo(() => projectAgentLanes(snapshot?.map.lanes ?? []), [snapshot])

  if (!snapshot) {
    return failed
      ? <p className="we-card helper-text" role="alert" data-testid="run-agent-lanes-failed">{t('runWorkspace.lanes.loadFailed')}</p>
      : <p className="helper-text">{t('common.loading')}</p>
  }
  if (lanes.length === 0) {
    return <p className="we-card helper-text" data-testid="run-agent-lanes-empty">{t('runWorkspace.lanes.empty')}</p>
  }

  return (
    <div className="we-run-lanes" data-testid="run-agent-lanes">
      {lanes.map((lane, laneIndex) => {
        const headingId = `${idPrefix}-${laneIndex}`
        const times = lane.tracks.flatMap(track => track.steps).map(view => (view.step.at ? Date.parse(view.step.at) : Number.NaN)).filter(Number.isFinite)
        const startMs = times.length > 0 ? Math.min(...times) : Number.NaN
        return (
          <section key={lane.nodeId} className="we-card we-run-lane" aria-labelledby={headingId} data-testid={`run-lane-${lane.nodeId}`}>
            <header className="we-run-lane__head">
              <h3 id={headingId}><code>{lane.nodeId}</code></h3>
              {(lane.kind === 'agent' || lane.kind === 'multi_agent') && (
                <span className="we-pill" data-tone="neutral">{t(`runWorkspace.lanes.kind.${lane.kind}`)}</span>
              )}
              <span className="helper-text">{t('multiAgent.stepCount', { count: lane.stepCount })}</span>
            </header>
            {lane.tracks.map(track => (
              <div key={track.agent ?? ''} className="we-run-lane__track">
                {lane.kind === 'multi_agent' && <h4>{track.agent ?? t('runWorkspace.lanes.team')}</h4>}
                <ol>
                  {track.steps.map(view => {
                    const Icon = TONE_ICON[view.tone]
                    const offset = offsetMs(view, startMs)
                    return (
                      <li key={view.key} className="we-run-lane__step" data-tone={view.tone}>
                        <Icon size={13} aria-hidden="true" />
                        <span>{t(view.label.key, view.label.params)}</span>
                        {offset !== null && <time dateTime={view.step.at ?? undefined}>+{formatCompactDuration(offset)}</time>}
                      </li>
                    )
                  })}
                </ol>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
