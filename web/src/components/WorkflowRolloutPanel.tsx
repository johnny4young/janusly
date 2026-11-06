/**
 * Inspector deployment control for deterministic baseline/canary traffic.
 *
 * Operators choose an older immutable baseline and the latest saved version as
 * canary. The server owns compatibility, assignment, counters, and automatic
 * rollback; this panel only renders a defensive projection and bounded inputs.
 */

import { GitBranch } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'

import { api, contractApi } from '../api'
import { readWorkflowVersionPage, type WorkflowVersionRow } from '../lib/list-contract'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { useConfirm } from './ConfirmDialog'
import type {
  RecoveryQualificationGate,
} from './WorkflowRecoveryQualification'
import { Button } from '@/components/ui/Button'
import { isRecord } from '../lib/guards'
import type { WorkflowRollout } from '../lib/api-types.generated'
import type { PromoteDraft } from './WorkflowPromoteDialog'
import { isWorkflowRollout } from '../lib/api-guards/components/WorkflowRollout'
import { isPostWorkflowsWorkflowIdRolloutResponse } from '../lib/api-guards/operations/PostWorkflowsWorkflowIdRollout'
import { isPostWorkflowsWorkflowIdRolloutRolloutIdDecisionResponse } from '../lib/api-guards/operations/PostWorkflowsWorkflowIdRolloutRolloutIdDecision'
import { MalformedResponseError } from '../lib/malformed-response'
import './WorkflowRolloutPanel.css'
import { PLATFORM_TAG, useResourceRefresh } from '../lib/query-cache'

const WORKFLOW_ROLLOUT_MUTATION_TAGS = ['workflows', 'rollouts', 'versions'] as const

const WORKFLOW_ROLLOUT_TAGS = [PLATFORM_TAG, 'workflows', 'rollouts', 'versions'] as const

const WorkflowRecoveryQualification = lazy(() => import('./WorkflowRecoveryQualification').then(module => ({
  default: module.WorkflowRecoveryQualification,
})))
const WorkflowRolloutStatus = lazy(() => import('./WorkflowRolloutStatus').then(module => ({
  default: module.WorkflowRolloutStatus,
})))
const WorkflowPromoteDialog = lazy(() => import('./WorkflowPromoteDialog').then(module => ({
  default: module.WorkflowPromoteDialog,
})))

// Form defaults for operator input mirror internal/engine/rollouts.go.
const DEFAULT_DRAFT: PromoteDraft = {
  baselineVersionId: '',
  trafficPercent: 10, // wire-policy: form default.
  minimumSampleSize: 10, // wire-policy: form default.
  minimumSuccessRatePercent: 90, // wire-policy: form default.
}

// wire-policy: a rollout compares a baseline with a newer canary version.
const MIN_ROLLOUT_VERSIONS = 2

// wire-policy: the engine accepts a baseline among the newest 200 versions.
const ROLLOUT_VERSION_WINDOW = 200

const ICON_SIZE = 13 // wire-policy: presentation, not a wire bound.

// Shape, including the status vocabulary, is the generated guard's; the panel
// only ever shows a rollout of the workflow it is scoped to.
function acceptRollout(row: WorkflowRollout, workflowId: string): WorkflowRollout | null {
  return row.workflowId === workflowId ? row : null
}

function successRate(succeeded: number, failed: number): number | null {
  const total = succeeded + failed
  return total === 0 ? null : (succeeded / total) * 100 // wire-policy: ratio to percent, not a wire bound.
}

function rolloutScope(state: ReturnType<typeof useWorkflowStore.getState>): string {
  return JSON.stringify([state.orgId, state.userId, state.currentWorkflowSaved ? state.currentWorkflowId : null])
}

export function WorkflowRolloutPanel({ readOnly = false }: { readOnly?: boolean } = {}) {
  const scope = useWorkflowStore(rolloutScope)
  const workflowId = useWorkflowStore(state => state.currentWorkflowSaved ? state.currentWorkflowId : undefined)
  return workflowId ? <ScopedRollout key={`${scope}:${readOnly}`} workflowId={workflowId} scope={scope} readOnly={readOnly} /> : null
}

function ScopedRollout({ workflowId, scope, readOnly }: { workflowId: string; scope: string; readOnly: boolean }) {
  const { t } = useT()
  const confirm = useConfirm()
  const owner = useRef<AbortController | null>(null)
  // Writes live as long as this scope, so a same-scope refresh cannot abort one in flight.
  const writer = useRef<AbortController | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const current = useCallback((request: AbortController | null): request is AbortController =>
    request !== null && !request.signal.aborted && rolloutScope(useWorkflowStore.getState()) === scope, [scope])
  const rolloutPath = `/workflows/${encodeURIComponent(workflowId)}/rollout`
  const [refreshNonce, refresh] = useResourceRefresh(WORKFLOW_ROLLOUT_TAGS)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const addToast = useWorkflowStore(state => state.addToast)
  const [versions, setVersions] = useState<WorkflowVersionRow[]>([])
  const [rollout, setRollout] = useState<WorkflowRollout | null>(null)
  const [draft, setDraft] = useState<PromoteDraft>(DEFAULT_DRAFT)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [qualificationGate, setQualificationGate] = useState<RecoveryQualificationGate | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading')
  const loading = loadState === 'loading'
  const loadError = loadState === 'error'
  const [mutating, setMutating] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    writer.current = controller
    return () => { controller.abort() }
  }, [])

  useEffect(() => {
    const request = new AbortController()
    owner.current = request
    setVersions([])
    setRollout(null)
    setQualificationGate(null)
    setPromoteOpen(false)
    setLoadState('loading')
    Promise.all([
      readWorkflowVersionPage(workflowId, { limit: ROLLOUT_VERSION_WINDOW }, request.signal),
      // The rollout read shares a mux pattern that keeps it out of the manifest; its row has the component guard.
      api(rolloutPath, { signal: request.signal }),
    ]).then(([versionsPayload, rolloutPayload]) => {
      if (!current(request)) return
      const row = isRecord(rolloutPayload) ? rolloutPayload.rollout : undefined
      const nextRollout = isWorkflowRollout(row) ? acceptRollout(row, workflowId) : null
      if (row !== null && !nextRollout) throw new Error(t('workflowRollout.invalidResponse'))
      const nextVersions = [...versionsPayload].sort((left, right) => right.version - left.version)
      setLoadState('ready')
      setVersions(nextVersions)
      setRollout(nextRollout)
      setDraft(current => ({
        ...current,
        baselineVersionId: nextVersions.some(version => version.id === current.baselineVersionId)
          ? current.baselineVersionId
          : (nextVersions[1]?.id ?? ''),
      }))
    }).catch(error => {
      if (!current(request)) return
      setLoadState('error')
      addToast(error instanceof MalformedResponseError
        ? t('workflowRollout.invalidResponse')
        : tApiError(error) || t('workflowRollout.loadFailed'), 'error')
    })
    return () => { request.abort() }
  }, [addToast, current, refreshNonce, rolloutPath, t, workflowId])

  const latest = versions[0]
  const baseline = versions.find(version => version.id === rollout?.baselineVersionId)
  const canary = versions.find(version => version.id === rollout?.canaryVersionId)
  const rolloutControlsLatest = Boolean(rollout && latest?.id === rollout.canaryVersionId)
  const qualificationBaselineVersionId = rollout && rolloutControlsLatest
    ? rollout.baselineVersionId
    : draft.baselineVersionId
  const qualificationCandidateVersionId = rollout && rolloutControlsLatest
    ? rollout.canaryVersionId
    : latest?.id
  const canaryRate = rollout
    ? successRate(rollout.canarySucceeded, rollout.canaryFailed)
    : null

  // Mirrors the engine's assignment: outside the canary share, only a promoted canary replaces baseline.
  const production = rollout && rolloutControlsLatest ? (rollout.status === 'promoted' ? canary : baseline) : latest
  const canPromote = !readOnly && !loading && versions.length >= MIN_ROLLOUT_VERSIONS
    && (!rollout || !rolloutControlsLatest)
  const canStart = !readOnly && !loading && !loadError && !mutating && Boolean(latest && draft.baselineVersionId
    && qualificationGate && !qualificationGate.loading
    && qualificationGate.baselineVersionId === draft.baselineVersionId && qualificationGate.candidateVersionId === latest.id
    && (!qualificationGate.required || qualificationGate.status === 'passed'))

  const mutate = async (request: AbortController, send: () => Promise<{ rollout: WorkflowRollout }>, success: string,
    accepts: (value: WorkflowRollout) => boolean): Promise<boolean> => {
    setMutating(true)
    try {
      const payload = await send()
      if (!current(request)) return false
      const updated = acceptRollout(payload.rollout, workflowId)
      if (!updated || !accepts(updated)) throw new Error(t('workflowRollout.invalidResponse'))
      setRollout(updated)
      setPromoteOpen(false)
      addToast(t(success), 'success')
      bumpPlatformVersion(WORKFLOW_ROLLOUT_MUTATION_TAGS)
      return true
    } catch (error) {
      if (!current(request)) return false
      addToast(error instanceof MalformedResponseError
        ? t('workflowRollout.invalidResponse')
        : tApiError(error) || t('workflowRollout.decisionFailed'), 'error')
      return false
    } finally {
      if (current(request)) setMutating(false)
    }
  }

  const createRollout = async () => {
    const write = writer.current
    if (!current(owner.current) || !current(write) || !canStart || !latest) return
    const body = { ...draft, canaryVersionId: latest.id }
    const started = await mutate(write, () => contractApi('POST /workflows/{workflowId}/rollout', rolloutPath, body,
      { signal: write.signal, guard: isPostWorkflowsWorkflowIdRolloutResponse }), 'workflowRollout.started',
    value => value.baselineVersionId === body.baselineVersionId && value.canaryVersionId === body.canaryVersionId)
    // The dialog and its trigger are gone, so focus lands on the new stage.
    if (started) requestAnimationFrame(() => stageRef.current?.focus())
  }

  const decide = async (decision: 'promote' | 'rollback') => {
    const request = owner.current
    if (!current(request) || readOnly || loading || loadError || mutating || !rollout || rollout.status !== 'active') return
    const accepted = await confirm({
      title: t(decision === 'promote' ? 'workflowRollout.promoteTitle' : 'workflowRollout.rollbackTitle'),
      body: t(decision === 'promote' ? 'workflowRollout.promoteConfirm' : 'workflowRollout.rollbackConfirm'),
      confirmLabel: t(decision === 'promote' ? 'workflowRollout.promote' : 'workflowRollout.rollback'),
      tone: decision === 'rollback' ? 'danger' : 'default',
    })
    const write = writer.current
    if (!accepted || !current(request) || !current(write)) return
    await mutate(write, () => contractApi('POST /workflows/{workflowId}/rollout/{rolloutId}/{decision}',
      `${rolloutPath}/${encodeURIComponent(rollout.id)}/${decision}`, {},
      { signal: write.signal, guard: isPostWorkflowsWorkflowIdRolloutRolloutIdDecisionResponse }),
    decision === 'promote' ? 'workflowRollout.promoted' : 'workflowRollout.rolledBack', value => value.id === rollout.id)
  }

  const qualification = !loading && versions.length >= MIN_ROLLOUT_VERSIONS
    && qualificationBaselineVersionId && qualificationCandidateVersionId ? (
    <Suspense fallback={<p className="helper-text" role="status">{t('workflowRollout.qualification.loading')}</p>}>
      <WorkflowRecoveryQualification
        key={`${refreshNonce}:${qualificationBaselineVersionId}:${qualificationCandidateVersionId}`}
        workflowId={workflowId}
        baselineVersionId={qualificationBaselineVersionId}
        candidateVersionId={qualificationCandidateVersionId}
        readOnly={readOnly}
        onGateChange={setQualificationGate}
      />
    </Suspense>
  ) : null

  return (
    <section className="we-card we-rollout-panel" aria-labelledby="workflow-rollout-title" data-testid="workflow-rollout-panel">
      <div className="we-card__header">
        <div>
          <p className="eyebrow"><GitBranch size={ICON_SIZE} aria-hidden="true" /> {t('workflowRollout.eyebrow')}</p>
          <h3 id="workflow-rollout-title">{t('workflowRollout.title')}</h3>
        </div>
        {rollout && rolloutControlsLatest && (
          <span className="we-pill" data-tone={rollout.status === 'active' ? 'warning' : rollout.status === 'promoted' ? 'success' : 'danger'}>
            {t(`workflowRollout.status.${rollout.status}`)}
          </span>
        )}
      </div>
      <p className="helper-text">{t('workflowRollout.description')}</p>

      {loading && <p className="helper-text" role="status">{t('workflowRollout.loading')}</p>}

      {!loading && latest && (
        <div ref={stageRef} tabIndex={-1} className="we-rollout-panel__metrics" data-testid="workflow-stage">
          <div><span>{t('workflowRollout.stage.latest')}</span><strong>v{latest.version}</strong></div>
          <div><span>{t('workflowRollout.stage.production')}</span><strong>{production ? `v${production.version}` : '—'}</strong></div>
        </div>
      )}

      {!loading && rollout && rolloutControlsLatest && (
        <Suspense fallback={<p className="helper-text" role="status">{t('workflowRollout.loading')}</p>}>
          <WorkflowRolloutStatus
            status={rollout.status}
            trafficPercent={rollout.trafficPercent}
            minimumSampleSize={rollout.minimumSampleSize}
            minimumSuccessRatePercent={rollout.minimumSuccessRatePercent}
            baselineVersion={baseline?.version}
            canaryVersion={canary?.version}
            baselineRuns={rollout.baselineSucceeded + rollout.baselineFailed}
            canaryRuns={rollout.canarySucceeded + rollout.canaryFailed}
            canarySuccessRate={canaryRate}
            readOnly={readOnly}
            mutating={mutating}
            onDecide={decision => { void decide(decision) }}
          />
        </Suspense>
      )}

      {loadError && <div role="alert"><p>{t('workflowRollout.loadFailed')}</p>
        <Button onClick={refresh}>{t('common.retry')}</Button></div>}

      {!loading && !loadError && versions.length < MIN_ROLLOUT_VERSIONS && (
        <p className="we-rollout-panel__empty">{t('workflowRollout.needsVersions')}</p>
      )}

      {canPromote && latest && (
        <Button variant="primary" onClick={() => setPromoteOpen(true)} data-testid="workflow-promote-open">
          {t('workflowRollout.promoteOpen', { version: latest.version })}
        </Button>
      )}

      {/* The comparison gates the start, so it moves into the dialog while an operator can promote. */}
      {!canPromote && qualification}

      {canPromote && promoteOpen && (
        <Suspense fallback={<p className="helper-text" role="status">{t('common.working')}</p>}>
          <WorkflowPromoteDialog
            versions={versions}
            draft={draft}
            onDraft={setDraft}
            qualification={qualification}
            blocked={Boolean(qualificationGate?.required && qualificationGate.status !== 'passed')}
            canStart={canStart}
            mutating={mutating}
            onStart={() => { void createRollout() }}
            onClose={() => setPromoteOpen(false)}
          />
        </Suspense>
      )}
    </section>
  )
}
