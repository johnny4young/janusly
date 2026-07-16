/**
 * Recovery before/after delta card. Mounted inside the Recovery dialog's
 * `applied` step. Surfaces five signals about whether the operator's
 * fix actually worked:
 *
 *   1. **Run counter** — always shown. "Runs against v{N}: 3 — 2✓ 1✗ 0…".
 *   2. **Same-failure check** — re-normalizes new DLQ entries against
 *      the original failure's signature. ✓ 0 occurrences = the operator
 *      can stop watching; ⚠ N occurrences = the fix isn't holding.
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

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ArrowDownRight, ArrowUpRight, Minus, RotateCcw } from 'lucide-react'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { RollbackConfirmDialog } from './RollbackConfirmDialog'
import type { OrgMember, OrgRole, WorkflowDefinition } from '../types'
import { useT } from '../i18n'
import { t as runtimeT } from '../i18n/runtime'

/** Minimum after-side run count for the full delta to render. Mirrors `MIN_RUNS_FOR_DELTA` in the engine. */
const MIN_RUNS_FOR_DELTA = 5
/** Threshold below which the card surfaces the regression-rollback affordance. */
const REGRESSION_THRESHOLD = -3

/**
 * UI gate: hide the Rollback CTA from read-only viewers. Custom roles
 * carry org-defined names like `compliance`; the server is the
 * authoritative gate (it consults `inheritsFrom` rank + effective
 * permission set), so the web only needs to err on the side of
 * showing the CTA for any non-`viewer` non-null role.
 */
function canRollbackWithRole(role: string | null | undefined) {
  return typeof role === 'string' && role !== '' && role !== 'viewer'
}

/** Pre-save snapshot of the workflow's health state, captured at the moment Apply is clicked. */
export type PreSaveBeforeSnapshot = {
  score: number
  status: string
  signals: {
    p95LatencyMs: number | null
    totalRuns: number
    totalCostUsd: number
  }
}

type DeltaResponse = {
  workflowId: string
  afterVersion: number
  windowDays: number
  hasEnoughData: boolean
  before: { score: number; status: string; signals: { p95LatencyMs: number | null; totalRuns: number; totalCostUsd: number } }
  after: { score: number; status: string; signals: { p95LatencyMs: number | null; totalRuns: number; totalCostUsd: number } }
  delta: { score: number; p95LatencyMs: number | null; costPerRunUsd: number | null } | null
  recentRunsAgainstAfter: { totalRuns: number; succeeded: number; failed: number; running: number }
  sameFailureSinceApply: { count: number; sampleDeadLetterIds: string[]; priorSignature: string } | null
  priorVersion: { version: number; versionId: string } | null
}

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

type RollbackVersion = { id: string; version: number; dagJson: WorkflowDefinition }
type RollbackState =
  | { kind: 'idle' }
  | { kind: 'fetching' }
  | { kind: 'open'; current: RollbackVersion; target: RollbackVersion }
  | { kind: 'error'; message: string }

export function RecoveryDeltaCard({
  workflowId,
  afterVersion,
  priorFailureSignature,
  preSaveBeforeSnapshot,
}: RecoveryDeltaCardProps) {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const session = useWorkflowStore((state) => state.session)
  const userId = useWorkflowStore((state) => state.userId)
  const orgId = useWorkflowStore((state) => state.orgId)
  const [state, setState] = useState<FetchState>({ kind: 'loading' })
  const [rollback, setRollback] = useState<RollbackState>({ kind: 'idle' })
  const [effectiveRole, setEffectiveRole] = useState<OrgRole | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    const params = new URLSearchParams({
      workflowId,
      afterVersion: String(afterVersion),
    })
    if (priorFailureSignature) params.set('priorFailureSignature', priorFailureSignature)
    api(`/workflows/health/delta?${params.toString()}`)
      .then((data) => {
        if (cancelled) return
        setState({ kind: 'ready', data: data as DeltaResponse })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : (t('recoveryDelta.errorLoad')),
        })
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, afterVersion, priorFailureSignature, platformVersion, retryNonce])

  useEffect(() => {
    let cancelled = false

    const loadEffectiveRole = async () => {
      if (!userId) {
        setEffectiveRole(null)
        return
      }

      try {
        const data = await api('/members')
        if (cancelled) return
        const members = Array.isArray(data) ? (data as OrgMember[]) : []
        const member = members.find((row) => row.userId === userId)
        // Mirrors VersionHistoryPanel and backend dev-header behaviour:
        // fresh local checkouts without org_members fall back to admin, but
        // a persisted viewer row must hide rollback affordances.
        setEffectiveRole(member?.role ?? (!session ? 'admin' : null))
      } catch {
        if (!cancelled) setEffectiveRole(null)
      }
    }

    void loadEffectiveRole()
    return () => {
      cancelled = true
    }
  }, [orgId, platformVersion, session, userId])

  const onOpenRollback = useCallback(async (priorVersionNumber: number) => {
    setRollback({ kind: 'fetching' })
    try {
      const versions = await api(`/workflows/versions?workflowId=${encodeURIComponent(workflowId)}`) as Array<RollbackVersion>
      const current = versions.find((v) => v.version === afterVersion)
      const target = versions.find((v) => v.version === priorVersionNumber)
      if (!current || !target) {
        setRollback({ kind: 'error', message: t('recoveryDelta.errorBothVersions') })
        return
      }
      // Defense-in-depth: the `RollbackConfirmDialog` consumes the
      // `dagJson` field of both versions to render the diff. If the
      // /workflows/versions response shape ever drifts (e.g. column
      // renamed) the soft cast above wouldn't catch it — guard here so
      // the operator sees a usable error instead of a blank diff.
      if (!current.dagJson || !target.dagJson) {
        setRollback({ kind: 'error', message: t('recoveryDelta.errorIncomplete') })
        return
      }
      setRollback({ kind: 'open', current, target })
    } catch (error) {
      setRollback({
        kind: 'error',
        message: error instanceof Error ? error.message : (t('recoveryDelta.errorVersions')),
      })
    }
  }, [workflowId, afterVersion, t])

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
        <button
          type="button"
          className="we-recovery-delta-link"
          onClick={() => setRetryNonce((n) => n + 1)}
        >
          {t('recoveryDelta.retry')}
        </button>
      </div>
    )
  }

  const { data } = state
  const showRegressionAffordance = data.hasEnoughData
    && data.delta != null
    && data.delta.score <= REGRESSION_THRESHOLD
    && data.priorVersion != null
    && canRollbackWithRole(effectiveRole)

  return (
    <>
      <div className="we-recovery-delta-card" aria-label={t('recoveryDelta.aria')}>
        {priorFailureSignature ? (
          <div className="we-recovery-delta-card__head">
            <span className="we-recovery-delta-card__title">{t('recoveryDelta.headTitle')}</span>
            <span className="we-recovery-delta-card__id">{t('recoveryDelta.headSignature', { signature: priorFailureSignature })}</span>
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
            <HealthPill before={data.before.score} after={data.after.score} delta={data.delta.score} />
            {data.delta.p95LatencyMs != null
              && data.before.signals.p95LatencyMs != null
              && data.after.signals.p95LatencyMs != null ? (
                <LatencyPill
                  beforeMs={data.before.signals.p95LatencyMs}
                  afterMs={data.after.signals.p95LatencyMs}
                  deltaMs={data.delta.p95LatencyMs}
                />
              ) : null}
            {data.delta.costPerRunUsd != null
              && (data.before.signals.totalCostUsd > 0 || data.after.signals.totalCostUsd > 0) ? (
                <CostPill
                  beforeRuns={data.before.signals.totalRuns}
                  beforeCost={data.before.signals.totalCostUsd}
                  afterRuns={data.after.signals.totalRuns}
                  afterCost={data.after.signals.totalCostUsd}
                  deltaPerRun={data.delta.costPerRunUsd}
                />
              ) : null}
          </div>
        ) : (
          <GatheringRow
            currentRuns={data.recentRunsAgainstAfter.totalRuns}
            afterVersion={afterVersion}
            threshold={MIN_RUNS_FOR_DELTA}
          />
        )}

        {showRegressionAffordance && data.priorVersion ? (
          <button
            type="button"
            className="we-recovery-delta-rollback"
            onClick={() => onOpenRollback(data.priorVersion!.version)}
            disabled={rollback.kind === 'fetching'}
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span>{rollback.kind === 'fetching' ? t('recoveryDelta.loadingVersions') : (t('recoveryDelta.rollbackTo', { version: data.priorVersion.version }))}</span>
          </button>
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
          onClose={() => setRollback({ kind: 'idle' })}
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
    return <div className="we-recovery-delta-skeleton">{runtimeT('recoveryDelta.skeletonLoading', { version: afterVersion }) as string}</div>
  }
  // For afterVersion=1 there is no prior version to label, so drop the
  // "(v0)" parenthetical — versions are 1-based.
  const label = afterVersion > 1
    ? (runtimeT('recoveryDelta.beforeApplyVersion', { prior: afterVersion - 1 }) as string)
    : (runtimeT('recoveryDelta.beforeApply') as string)
  const detail = snapshot.signals.p95LatencyMs != null
    ? (runtimeT('recoveryDelta.beforeHealthLatency', { score: snapshot.score, latency: formatMs(snapshot.signals.p95LatencyMs) }) as string)
    : (runtimeT('recoveryDelta.beforeHealth', { score: snapshot.score }) as string)
  return (
    <div className="we-recovery-delta-skeleton">
      <span className="we-recovery-delta-skeleton__label">{label}</span>
      <span className="we-recovery-delta-skeleton__value">{detail}</span>
      <span className="we-recovery-delta-skeleton__hint">{runtimeT('recoveryDelta.skeletonHint') as string}</span>
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
  if (counts.totalRuns === 0 && counts.running === 0) {
    return (
      <div className="we-recovery-delta-pill we-recovery-delta-pill--counter" data-testid="recovery-delta-counter">
        <span className="we-recovery-delta-pill__value">{runtimeT('recoveryDelta.noRunsYet', { version: afterVersion }) as string}</span>
        <span className="we-recovery-delta-pill__sentence">{runtimeT('recoveryDelta.noRunsHint') as string}</span>
      </div>
    )
  }
  // Pre-format the value/sentence as single strings so React renders them
  // as single text nodes (Testing-Library `getByText` doesn't reach across
  // sibling text nodes from a JSX template literal mix).
  const valueText = counts.running > 0
    ? (runtimeT('recoveryDelta.runsValueRunning', { version: afterVersion, total: counts.totalRuns, running: counts.running }) as string)
    : (runtimeT('recoveryDelta.runsValue', { version: afterVersion, total: counts.totalRuns }) as string)
  const sentenceText = counts.running > 0
    ? (runtimeT('recoveryDelta.runsSentenceRunning', { succeeded: counts.succeeded, failed: counts.failed, running: counts.running }) as string)
    : (runtimeT('recoveryDelta.runsSentence', { succeeded: counts.succeeded, failed: counts.failed }) as string)
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
  if (count === 0) {
    return (
      <div className="we-recovery-delta-pill we-recovery-delta-pill--same-failure we-recovery-delta-pill--success" data-testid="recovery-delta-same-failure">
        <span className="we-recovery-delta-pill__value">{runtimeT('recoveryDelta.sameFailureZero') as string}</span>
        <span className="we-recovery-delta-pill__sentence">{runtimeT('recoveryDelta.sameFailureZeroSentence') as string}</span>
      </div>
    )
  }
  const link = sampleDeadLetterIds.length > 0
    ? `?dlqFocus=${encodeURIComponent(sampleDeadLetterIds[0]!)}`
    : null
  const valueText = runtimeT('recoveryDelta.sameFailureValue', { count }) as string
  return (
    <div className="we-recovery-delta-pill we-recovery-delta-pill--same-failure we-recovery-delta-pill--danger" data-testid="recovery-delta-same-failure">
      <span className="we-recovery-delta-pill__value">{valueText}</span>
      <span className="we-recovery-delta-pill__sentence">
        {runtimeT('recoveryDelta.sameFailureSentence') as string}
        {link ? (
          <>
            {' '}
            <a href={link} className="we-recovery-delta-failure-link">{runtimeT('recoveryDelta.viewDlq') as string}</a>
          </>
        ) : null}
      </span>
    </div>
  )
}

function HealthPill({ before, after, delta }: { before: number; after: number; delta: number }) {
  const sentence = delta > 0
    ? (runtimeT('recoveryDelta.healthImproved', { count: delta }) as string)
    : delta < 0
      ? (runtimeT('recoveryDelta.healthDropped', { count: Math.abs(delta) }) as string)
      : (runtimeT('recoveryDelta.healthUnchanged') as string)
  return (
    <div className={`we-recovery-delta-pill ${tintForHealth(delta)}`}>
      <span className="we-recovery-delta-pill__value">
        {before} <ArrowGlyph delta={delta} /> {after}
      </span>
      <span className="we-recovery-delta-pill__sentence">{sentence}</span>
    </div>
  )
}

function LatencyPill({ beforeMs, afterMs, deltaMs }: { beforeMs: number; afterMs: number; deltaMs: number }) {
  const ratio = beforeMs > 0 ? Math.abs(deltaMs) / beforeMs : 0
  const pct = Math.round(ratio * 100)
  const sentence = deltaMs < 0
    ? (runtimeT('recoveryDelta.faster', { pct }) as string)
    : deltaMs > 0
      ? (runtimeT('recoveryDelta.slower', { pct }) as string)
      : (runtimeT('recoveryDelta.sameSpeed') as string)
  // Lower is better — flip the tint mapping so a NEGATIVE delta is success-tinted.
  return (
    <div className={`we-recovery-delta-pill ${tintForLowerIsBetter(deltaMs)}`}>
      <span className="we-recovery-delta-pill__value">
        {formatMs(beforeMs)} <ArrowGlyph delta={-deltaMs} /> {formatMs(afterMs)}
      </span>
      <span className="we-recovery-delta-pill__sentence">{sentence}</span>
    </div>
  )
}

function CostPill({
  beforeRuns,
  beforeCost,
  afterRuns,
  afterCost,
  deltaPerRun,
}: {
  beforeRuns: number
  beforeCost: number
  afterRuns: number
  afterCost: number
  deltaPerRun: number
}) {
  const beforePerRun = beforeRuns > 0 ? beforeCost / beforeRuns : 0
  const afterPerRun = afterRuns > 0 ? afterCost / afterRuns : 0
  const sentence = deltaPerRun < 0
    ? (runtimeT('recoveryDelta.cheaper', { usd: formatUsd(Math.abs(deltaPerRun)) }) as string)
    : deltaPerRun > 0
      ? (runtimeT('recoveryDelta.moreExpensive', { usd: formatUsd(deltaPerRun) }) as string)
      : (runtimeT('recoveryDelta.sameCost') as string)
  return (
    <div className={`we-recovery-delta-pill ${tintForLowerIsBetter(deltaPerRun)}`}>
      <span className="we-recovery-delta-pill__value">
        {formatUsd(beforePerRun)} <ArrowGlyph delta={-deltaPerRun} /> {formatUsd(afterPerRun)}
      </span>
      <span className="we-recovery-delta-pill__sentence">{sentence}</span>
    </div>
  )
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
  const pct = Math.min(100, Math.round((currentRuns / threshold) * 100))
  const label = runtimeT('recoveryDelta.gathering', { current: currentRuns, threshold, version: afterVersion }) as string
  return (
    <div className="we-recovery-delta-gathering">
      <div className="we-recovery-delta-gathering__label">{label}</div>
      <div
        className="we-recovery-delta-progress"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="we-recovery-delta-progress__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function ArrowGlyph({ delta }: { delta: number }) {
  // delta convention: positive = "up" (health-style — bigger is better);
  // callers that mean "lower is better" (latency, cost) negate before
  // passing in so the same glyph rule applies everywhere.
  if (delta > 0) {
    return <ArrowUpRight size={14} aria-hidden="true" className="we-recovery-delta-arrow we-recovery-delta-arrow--up" />
  }
  if (delta < 0) {
    return <ArrowDownRight size={14} aria-hidden="true" className="we-recovery-delta-arrow we-recovery-delta-arrow--down" />
  }
  return <Minus size={14} aria-hidden="true" className="we-recovery-delta-arrow we-recovery-delta-arrow--neutral" />
}

function tintForHealth(delta: number): string {
  if (delta >= 5) return 'we-recovery-delta-pill--success-strong'
  if (delta > 0) return 'we-recovery-delta-pill--success'
  if (delta <= -5) return 'we-recovery-delta-pill--danger-strong'
  if (delta < 0) return 'we-recovery-delta-pill--danger'
  return 'we-recovery-delta-pill--neutral'
}

function tintForLowerIsBetter(delta: number): string {
  // Lower = better, so flip the sign before delegating to tintForHealth.
  return tintForHealth(-delta)
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
