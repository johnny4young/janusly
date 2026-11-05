import { useMemo, useState, type ComponentType } from 'react'

import { formatCompactDuration, formatStatusLabel } from '../constants'
import { useT } from '../i18n'
import { projectRunSteps, type RunStep, type StepAttempt } from '../run-steps'
import { isTerminalRunStatus } from '../lib/status'
import type { RunEvent, RunNode, RunSummary } from '../types'
import './RunStepTimeline.css'
import { Button } from './ui/Button'

function attemptSpan(attempt: StepAttempt, endMs: number): number | null {
  return attempt.startedAt === null ? null : Math.max(0, (attempt.finishedAt ?? endMs) - attempt.startedAt)
}

function StepRow({ step, startMs, endMs, onRerun }: { step: RunStep; startMs: number; endMs: number; onRerun?: (nodeId: string) => void }) {
  const { t } = useT()
  const scale = 100 / Math.max(1, endMs - startMs)
  const first = step.attempts[0]?.startedAt ?? null
  const showAttempts = step.attempts.length > 1 || step.attempts.some(item => item.error)
  return (
    <li className="we-run-step" data-testid={`run-step-${step.nodeId}`}>
      <div className="we-run-step__head">
        <code title={step.nodeId}>{step.nodeId}</code>
        <span className="status-pill" data-status={step.status}>{formatStatusLabel(step.status)}</span>
        {step.retries > 0 && (
          <span className="we-pill" data-tone="warning" data-testid={`run-step-retries-${step.nodeId}`}>
            {t('runWorkspace.steps.retries', { count: step.retries })}
          </span>
        )}
        {onRerun && step.status !== 'pending' && step.status !== 'skipped' && (
          <Button size="sm" variant="ghost" data-testid={`run-step-rerun-${step.nodeId}`} onClick={() => onRerun(step.nodeId)}>
            {t('runWorkspace.rerun.title', { nodeId: step.nodeId })}
          </Button>
        )}
      </div>
      <div className="we-run-step__track" aria-hidden="true">
        {step.attempts.map((item, index) => (
          item.startedAt !== null && (
            <span
              key={index}
              className="we-run-step__bar"
              data-outcome={item.outcome}
              style={{
                left: `${(item.startedAt - startMs) * scale}%`,
                width: `${(attemptSpan(item, endMs) ?? 0) * scale}%`,
              }}
            />
          )
        ))}
      </div>
      {first !== null && (
        <span className="we-run-step__duration">
          {formatCompactDuration(Math.max(0, (step.attempts.at(-1)?.finishedAt ?? endMs) - first))}
        </span>
      )}
      {showAttempts && (
        <ul className="we-run-step__attempts">
          {step.attempts.map((item, index) => {
            const span = attemptSpan(item, endMs)
            return (
              <li key={index} data-testid={`run-step-attempt-${step.nodeId}-${item.attempt}`}>
                {[
                  t('rightPanel.runs.nodeAttempt', { count: item.attempt }),
                  item.outcome === 'retried' ? t('runWorkspace.steps.retried') : formatStatusLabel(item.outcome),
                  span === null ? null : formatCompactDuration(span),
                ].filter(Boolean).join(' · ')}
                {item.error && <p title={item.error}>{item.error}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}

/** The Timeline tab: this run's attempts grouped by step on one time scale. */
export function RunStepTimeline({
  events,
  nodes,
  eventsHasMore,
  onLoadOlderEvents,
  run,
  RerunDialog,
}: {
  events: RunEvent[]
  nodes: RunNode[]
  eventsHasMore?: boolean
  onLoadOlderEvents?: () => void | Promise<void>
  run?: RunSummary
  /** Injected so this lazy chunk does not preload everything the run panel needs. */
  RerunDialog?: ComponentType<{ runId: string; nodeId: string; onClose: () => void }>
}) {
  const { t } = useT()
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [rerunNodeId, setRerunNodeId] = useState<string | null>(null)
  const canRerun = RerunDialog && run && !run.replayMode && isTerminalRunStatus(run.status)
  const { steps, startMs, endMs } = useMemo(() => projectRunSteps(events, nodes), [events, nodes])

  return (
    <div className="we-card we-run-steps" data-testid="run-step-timeline">
      {steps.length === 0 ? (
        <p className="helper-text">{t('runWorkspace.steps.empty')}</p>
      ) : (
        <>
          <div className="we-run-steps__axis" aria-hidden="true">
            <span>0</span>
            <span>{formatCompactDuration(endMs - startMs)}</span>
          </div>
          <ol aria-label={t('runWorkspace.steps.aria')}>
            {steps.map(step => <StepRow key={step.nodeId} step={step} startMs={startMs} endMs={endMs} onRerun={canRerun ? setRerunNodeId : undefined} />)}
          </ol>
        </>
      )}
      {eventsHasMore && onLoadOlderEvents && (
        <Button
          size="sm"
          disabled={loadingOlder}
          data-testid="run-steps-load-older"
          onClick={async () => {
            setLoadingOlder(true)
            try {
              await onLoadOlderEvents()
            } finally {
              setLoadingOlder(false)
            }
          }}
        >
          {t(loadingOlder ? 'common.loading' : 'rightPanel.reasoning.loadOlder')}
        </Button>
      )}
      {canRerun && rerunNodeId && (
        <RerunDialog runId={run.id} nodeId={rerunNodeId} onClose={() => setRerunNodeId(null)} />
      )}
    </div>
  )
}
