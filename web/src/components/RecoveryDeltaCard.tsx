/**
 * Recovery before/after delta card. Mounted inside the Recovery dialog's
 * `applied` step. Surfaces five signals about whether the operator's
 * fix actually worked:
 *
 *   1. **Run counter** — always shown. "Runs against v{N}: 3 — 2✓ 1✗ 0…".
 *   2. **Same-failure check** — re-normalizes new DLQ entries against
 *      the original failure's signature. Zero means no recurrence observed,
 *      not proof that the repair succeeded; monitoring remains necessary.
 *   3. **Health pill** — `before.score → after.score` plus a
 *      severity-tinted arrow and a plain-language sentence
 *      ("Health improved 4 points"). Gated on ≥5 runs against v{N} so
 *      tiny samples don't mislead.
 *   4. **p95 latency pill** — same shape, lower = better.
 *   5. **Cost/run pill** — same shape, lower = better. Hides entirely
 *      when both sides are zero (no LLM calls).
 *
 * When the after-side is in regression (`delta.score <= -3`) AND a prior
 * version exists, the card also surfaces a "Roll back to v{N-1}" button
 * that opens `<RollbackConfirmDialog>` after lazy-fetching both versions'
 * dagJson via the existing `/workflows/versions` endpoint.
 *
 * Used by `RecoveryDialog.tsx`'s `AppliedBody` component. Pulls the
 * `platformVersion` cross-panel store hook and refetches whenever a
 * sibling save/replay bumps it — so the card animates as runs accumulate.
 */

import { useEffect, useRef, useState } from 'react'
import { currentCanvasAuthority, ownCanvas } from '../lib/canvas-authority'
import { isRecoveryDelta, type RecoveryDelta as DeltaResponse, type HealthSnapshot as PreSaveBeforeSnapshot } from '../lib/health-delta'
export type { HealthSnapshot as PreSaveBeforeSnapshot } from '../lib/health-delta'
import { AlertCircle, ArrowDownRight, ArrowUpRight, Minus, RotateCcw } from 'lucide-react'
import { api } from '../api'
import { formatRoute } from '../lib/route'
import { Button } from './ui/Button'
import { readWorkflowVersionPage, type WorkflowVersionRow } from '../lib/list-contract'
import { useWorkflowStore } from '../store'
import { RollbackConfirmDialog } from './RollbackConfirmDialog'
import { useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'
import { sessionCan } from '../identity-context'
import './RecoveryDeltaCard.css'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'

const RECOVERY_DELTA_TAGS = [PLATFORM_TAG, 'workflows', 'recovery', 'dlq', 'runs'] as const

/** Minimum after-side run count for the full delta to render. Mirrors `MIN_RUNS_FOR_DELTA` in the engine. */
const MIN_RUNS_FOR_DELTA = 5
/** Threshold below which the card surfaces the regression-rollback affordance. */
const REGRESSION_THRESHOLD = -3

type RecoveryDeltaCardProps = {
  workflowId: string
  afterVersion: number
  priorFailureSignature: string | null
  preSaveBeforeSnapshot: PreSaveBeforeSnapshot | null
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: DeltaResponse }
  | { kind: 'error'; message: string }

type RollbackVersion = WorkflowVersionRow
type RollbackState =
  | { kind: 'idle' }
  | { kind: 'fetching' }
  | { kind: 'open'; current: RollbackVersion; target: RollbackVersion }
  | { kind: 'error'; message: string }

export function RecoveryDeltaCard(props: RecoveryDeltaCardProps) {
  const authority = useWorkflowStore(currentCanvasAuthority)
  const refresh = useInvalidationNonce(RECOVERY_DELTA_TAGS)
  const context = JSON.stringify([authority, props.workflowId, props.afterVersion, props.priorFailureSignature])
  const [initialContext] = useState(context)
  const canRead = sessionCan(useWorkflowStore.getState().identityContext, 'workflows.read')
  return canRead ? <ScopedRecoveryDeltaCard key={`${context}:${refresh}`} {...props}
    preSaveBeforeSnapshot={context === initialContext ? props.preSaveBeforeSnapshot : null} /> : null
}

function ScopedRecoveryDeltaCard({ workflowId, afterVersion, priorFailureSignature, preSaveBeforeSnapshot }: RecoveryDeltaCardProps) {
  const { t } = useT()
  const { identityContext, currentWorkflowId } = useWorkflowStore.getState()
  const owner = useRef<AbortController | null>(null)
  const fetchingVersions = useRef(false)
  const rollbackTrigger = useRef<HTMLButtonElement>(null)
  const [state, setState] = useState<FetchState>({ kind: 'loading' })
  const [rollback, setRollback] = useState<RollbackState>({ kind: 'idle' })
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    const controller = ownCanvas(() => setRetryNonce(n => n + 1))
    owner.current = controller
    fetchingVersions.current = false
    setState({ kind: 'loading' })
    setRollback({ kind: 'idle' })
    const params = new URLSearchParams({
      workflowId,
      afterVersion: String(afterVersion),
    })
    if (priorFailureSignature) params.set('priorFailureSignature', priorFailureSignature)
    api(`/workflows/health/delta?${params.toString()}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return
        if (!isRecoveryDelta(data, workflowId, afterVersion, priorFailureSignature)) throw new Error(runtimeT('api.error.malformedResponse'))
        setState({ kind: 'ready', data })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : runtimeT('recoveryDelta.errorLoad'),
        })
      })
    return () => controller.abort()
  }, [workflowId, afterVersion, priorFailureSignature, retryNonce])

  const onOpenRollback = async () => {
    const controller = owner.current
    const prior = state.kind === 'ready' ? state.data.priorVersion : null
    if (!controller || controller.signal.aborted || fetchingVersions.current || !prior
      || currentWorkflowId !== workflowId || !sessionCan(identityContext, 'workflows.write')) return
    fetchingVersions.current = true
    setRollback({ kind: 'fetching' })
    try {
      const exact = (version: number) =>
        readWorkflowVersionPage(workflowId, { version }, controller.signal)
      const [[current], [target]] = await Promise.all([exact(afterVersion), exact(prior.version)])
      if (controller.signal.aborted) return
      if (!current || !target || target.id !== prior.versionId) {
        setRollback({ kind: 'error', message: t('recoveryDelta.errorBothVersions') })
        return
      }
      setRollback({ kind: 'open', current, target })
    } catch (error) {
      if (controller.signal.aborted) return
      setRollback({
        kind: 'error',
        message: error instanceof Error ? error.message : t('recoveryDelta.errorBothVersions'),
      })
    } finally {
      if (!controller.signal.aborted) fetchingVersions.current = false
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="we-recovery-delta-card" aria-live="polite">
        <BeforeOnlySkeleton snapshot={preSaveBeforeSnapshot} afterVersion={afterVersion} />
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="we-recovery-delta-card we-recovery-delta-card--error" role="alert">
        <span className="we-recovery-delta-error-msg">
          <AlertCircle size={14} aria-hidden="true" /> {t('recoveryDelta.errorMessage', { detail: state.message })}
        </span>
        <Button size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  const { data } = state
  const showRegressionAffordance = data.hasEnoughData
    && data.delta != null
    && data.delta.score <= REGRESSION_THRESHOLD
    && data.priorVersion != null
    && currentWorkflowId === workflowId
    && sessionCan(identityContext, 'workflows.write')

  return (
    <>
      <div className="we-recovery-delta-card" aria-label={t('recoveryDelta.aria')}>
        {priorFailureSignature ? (
          <div className="we-recovery-delta-card__head">
            <strong>{t('recoveryDelta.headTitle')}</strong>
            <span className="we-recovery-delta-card__id">{priorFailureSignature}</span>
          </div>
        ) : null}
        <RunCounterPill
          afterVersion={afterVersion}
          counts={data.recentRunsAgainstAfter}
        />

        {data.sameFailureSinceApply ? (
          <SameFailurePill
            count={data.sameFailureSinceApply.count}
            sampleDeadLetterIds={data.sameFailureSinceApply.sampleDeadLetterIds}
          />
        ) : null}

        {data.hasEnoughData && data.delta ? (
          <div className="we-recovery-delta-pills">
            <MetricPill metric="health" before={data.before.score} after={data.after.score} delta={data.delta.score} />
            {data.delta.p95LatencyMs != null
              && data.before.signals.p95LatencyMs != null
              && data.after.signals.p95LatencyMs != null ? (
                <MetricPill metric="latency"
                  before={data.before.signals.p95LatencyMs}
                  after={data.after.signals.p95LatencyMs}
                  delta={data.delta.p95LatencyMs}
                />
              ) : null}
            {data.delta.costPerRunUsd != null
              && (data.before.signals.totalCostUsd > 0 || data.after.signals.totalCostUsd > 0) ? (
                <MetricPill metric="cost"
                  before={costPerRun(data.before)} after={costPerRun(data.after)}
                  delta={data.delta.costPerRunUsd}
                />
              ) : null}
          </div>
        ) : (
          <GatheringRow
            currentRuns={data.after.signals.totalRuns}
            afterVersion={afterVersion}
            threshold={MIN_RUNS_FOR_DELTA}
          />
        )}

        {showRegressionAffordance && data.priorVersion ? (
          <Button ref={rollbackTrigger} size="sm" variant="danger" className="we-recovery-delta-rollback" leadingIcon={<RotateCcw size={14} aria-hidden="true" />}
            onClick={onOpenRollback} loading={rollback.kind === 'fetching'} loadingLabel={t('recoveryDelta.loadingVersions')}>
            {t('recoveryDelta.rollbackTo', { version: data.priorVersion.version })}
          </Button>
        ) : null}

        {rollback.kind === 'error' ? (
          <div className="we-recovery-delta-error-msg" role="alert">
            <AlertCircle size={14} aria-hidden="true" /> {rollback.message}
          </div>
        ) : null}
      </div>

      {rollback.kind === 'open' ? (
        <RollbackConfirmDialog
          workflowId={workflowId}
          current={rollback.current}
          target={rollback.target}
          onClose={() => { setRollback({ kind: 'idle' }); rollbackTrigger.current?.focus() }}
        />
      ) : null}
    </>
  )
}

function BeforeOnlySkeleton({
  snapshot,
  afterVersion,
}: {
  snapshot: PreSaveBeforeSnapshot | null
  afterVersion: number
}) {
  if (!snapshot) {
    return <div className="we-recovery-delta-skeleton">{runtimeT('recoveryDelta.skeletonLoading', { version: afterVersion })}</div>
  }
  // For afterVersion=1 there is no prior version to label, so drop the
  // "(v0)" parenthetical — versions are 1-based.
  const label = afterVersion > 1
    ? (runtimeT('recoveryDelta.beforeApplyVersion', { prior: afterVersion - 1 }))
    : (runtimeT('recoveryDelta.beforeApply'))
  const detail = snapshot.signals.p95LatencyMs != null
    ? (runtimeT('recoveryDelta.beforeHealthLatency', { score: snapshot.score, latency: formatMs(snapshot.signals.p95LatencyMs) }))
    : (runtimeT('recoveryDelta.beforeHealth', { score: snapshot.score }))
  return (
    <div className="we-recovery-delta-skeleton">
      <span className="we-recovery-delta-skeleton__label">{label}</span>
      <span>{detail}</span>
      <em>{runtimeT('recoveryDelta.skeletonHint')}</em>
    </div>
  )
}

function RunCounterPill({
  afterVersion,
  counts,
}: {
  afterVersion: number
  counts: DeltaResponse['recentRunsAgainstAfter']
}) {
  const empty = counts.totalRuns === 0
  const valueText = empty ? runtimeT('recoveryDelta.noRunsYet', { version: afterVersion }) : counts.running > 0
    ? (runtimeT('recoveryDelta.runsValueRunning', { version: afterVersion, total: counts.totalRuns, running: counts.running }))
    : (runtimeT('recoveryDelta.runsValue', { version: afterVersion, total: counts.totalRuns }))
  const sentenceText = empty ? runtimeT('recoveryDelta.noRunsHint') : counts.running > 0
    ? (runtimeT('recoveryDelta.runsSentenceRunning', { succeeded: counts.succeeded, failed: counts.failed, running: counts.running }))
    : (runtimeT('recoveryDelta.runsSentence', { succeeded: counts.succeeded, failed: counts.failed }))
  return (
    <div className="we-recovery-delta-pill we-recovery-delta-pill--counter" data-testid="recovery-delta-counter">
      <span className="we-recovery-delta-pill__value">{valueText}</span>
      <span className="we-recovery-delta-pill__sentence">{sentenceText}</span>
    </div>
  )
}

function SameFailurePill({
  count,
  sampleDeadLetterIds,
}: {
  count: number
  sampleDeadLetterIds: string[]
}) {
  const link = sampleDeadLetterIds.length > 0
    ? formatRoute({ tab: 'runs', deadLetterId: sampleDeadLetterIds[0]! })
    : null
  const valueText = count === 0 ? runtimeT('recoveryDelta.sameFailureZero') : runtimeT('recoveryDelta.sameFailureValue', { count })
  return (
    <div className={`we-recovery-delta-pill we-recovery-delta-pill--${count === 0 ? 'neutral' : 'danger'}`} data-testid="recovery-delta-same-failure">
      <span className="we-recovery-delta-pill__value">{valueText}</span>
      <span className="we-recovery-delta-pill__sentence">
        {runtimeT(count === 0 ? 'recoveryDelta.sameFailureZeroSentence' : 'recoveryDelta.sameFailureSentence')}
        {link ? (
          <>
            {' '}
            <a href={link} className="we-recovery-delta-failure-link">{runtimeT('recoveryDelta.viewDlq')}</a>
          </>
        ) : null}
      </span>
    </div>
  )
}

const METRIC_COPY = {
  health: ['healthImproved', 'healthDropped', 'healthUnchanged'],
  latency: ['faster', 'slower', 'sameSpeed'],
  cost: ['cheaper', 'moreExpensive', 'sameCost'],
} as const

/** Compare all metrics with the same semantics: positive direction means better. */
function MetricPill({ metric, before, after, delta }: {
  metric: keyof typeof METRIC_COPY; before: number; after: number; delta: number
}) {
  const direction = metric === 'health' ? delta : -delta
  const keys = METRIC_COPY[metric]
  const key = keys[direction > 0 ? 0 : direction < 0 ? 1 : 2]
  const format = metric === 'latency' ? formatMs : metric === 'cost' ? formatUsd : (value: number) => value
  const sentence = runtimeT(`recoveryDelta.${key}`, {
    count: Math.abs(delta),
    pct: before > 0 ? Math.round(Math.abs(delta) / before * 100) : 0,
    usd: formatUsd(Math.abs(delta)),
  })
  return <div className={`we-recovery-delta-pill ${tintForHealth(direction)}`}>
    <span className="we-recovery-delta-pill__value">{format(before)} <ArrowGlyph delta={direction} /> {format(after)}</span>
    <span className="we-recovery-delta-pill__sentence">{sentence}</span>
  </div>
}

function costPerRun(snapshot: PreSaveBeforeSnapshot): number {
  return snapshot.signals.totalRuns > 0 ? snapshot.signals.totalCostUsd / snapshot.signals.totalRuns : 0
}

function GatheringRow({
  currentRuns,
  afterVersion,
  threshold,
}: {
  currentRuns: number
  afterVersion: number
  threshold: number
}) {
  const label = runtimeT('recoveryDelta.gathering', { current: currentRuns, threshold, version: afterVersion })
  return (
    <div className="we-recovery-delta-gathering">
      <small>{label}</small>
      <progress className="we-recovery-delta-progress" value={currentRuns} max={threshold} aria-label={label} />
    </div>
  )
}

function ArrowGlyph({ delta }: { delta: number }) {
  const Icon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus
  return <Icon size={14} aria-hidden="true" className="we-recovery-delta-arrow" />
}

function tintForHealth(delta: number): string {
  if (delta >= 5) return 'we-recovery-delta-pill--success-strong'
  if (delta > 0) return 'we-recovery-delta-pill--success'
  if (delta <= -5) return 'we-recovery-delta-pill--danger-strong'
  if (delta < 0) return 'we-recovery-delta-pill--danger'
  return 'we-recovery-delta-pill--neutral'
}

function formatMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  return `${Math.round(ms)}ms`
}

function formatUsd(amount: number): string {
  if (amount === 0) return '$0.000'
  if (Math.abs(amount) < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(3)}`
}
