/**
 * Inspector deployment control for deterministic baseline/canary traffic.
 *
 * Operators choose an older immutable baseline and the latest saved version as
 * canary. The server owns compatibility, assignment, counters, and automatic
 * rollback; this panel only renders a defensive projection and bounded inputs.
 */

import { GitBranch } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../api'
import { readWorkflowVersionPage } from '../lib/list-contract'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { useConfirm } from './ConfirmDialog'
import type {
  RecoveryQualificationGate,
} from './WorkflowRecoveryQualification'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/Form'
import { asRecord } from '../lib/guards'
import './WorkflowRolloutPanel.css'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'

const WORKFLOW_ROLLOUT_MUTATION_TAGS = ['workflows', 'rollouts', 'versions'] as const

const WORKFLOW_ROLLOUT_TAGS = [PLATFORM_TAG, 'workflows', 'rollouts', 'versions'] as const

const WorkflowRecoveryQualification = lazy(() => import('./WorkflowRecoveryQualification').then(module => ({
  default: module.WorkflowRecoveryQualification,
})))
const WorkflowRolloutStatus = lazy(() => import('./WorkflowRolloutStatus').then(module => ({
  default: module.WorkflowRolloutStatus,
})))

type VersionRow = { id: string; version: number }
type RolloutStatus = 'active' | 'promoted' | 'rolled_back' | 'cancelled'
type WorkflowRollout = {
  id: string
  workflowId: string
  baselineVersionId: string
  canaryVersionId: string
  trafficPercent: number
  minimumSampleSize: number
  minimumSuccessRatePercent: number
  status: RolloutStatus
  baselineSucceeded: number
  baselineFailed: number
  canarySucceeded: number
  canaryFailed: number
}

type Draft = {
  baselineVersionId: string
  trafficPercent: number
  minimumSampleSize: number
  minimumSuccessRatePercent: number
}

const DEFAULT_DRAFT: Draft = {
  baselineVersionId: '',
  trafficPercent: 10,
  minimumSampleSize: 10,
  minimumSuccessRatePercent: 90,
}

function boundedInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null
}

function parseRollout(payload: unknown): WorkflowRollout | null {
  const envelope = asRecord(payload)
  if (envelope?.rollout === null) return null
  const row = asRecord(envelope?.rollout)
  if (!row) return null
  const status = row.status
  if (status !== 'active' && status !== 'promoted' && status !== 'rolled_back' && status !== 'cancelled') return null
  const strings = ['id', 'workflowId', 'baselineVersionId', 'canaryVersionId', 'createdAt', 'updatedAt'] as const
  if (strings.some(key => typeof row[key] !== 'string' || row[key].length === 0)) return null
  const trafficPercent = boundedInteger(row.trafficPercent, 1, 50)
  const minimumSampleSize = boundedInteger(row.minimumSampleSize, 5, 100)
  const minimumSuccessRatePercent = boundedInteger(row.minimumSuccessRatePercent, 1, 100)
  const counters = ['baselineSucceeded', 'baselineFailed', 'canarySucceeded', 'canaryFailed'] as const
  const values = counters.map(key => boundedInteger(row[key], 0))
  if (trafficPercent === null || minimumSampleSize === null || minimumSuccessRatePercent === null || values.some(value => value === null)) return null
  return {
    id: row.id as string,
    workflowId: row.workflowId as string,
    baselineVersionId: row.baselineVersionId as string,
    canaryVersionId: row.canaryVersionId as string,
    trafficPercent,
    minimumSampleSize,
    minimumSuccessRatePercent,
    status,
    baselineSucceeded: values[0]!,
    baselineFailed: values[1]!,
    canarySucceeded: values[2]!,
    canaryFailed: values[3]!,
  }
}

function successRate(succeeded: number, failed: number): number | null {
  const total = succeeded + failed
  return total === 0 ? null : (succeeded / total) * 100
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
  const current = useCallback((request: AbortController | null): request is AbortController =>
    request !== null && !request.signal.aborted && rolloutScope(useWorkflowStore.getState()) === scope, [scope])
  const rolloutPath = `/workflows/${encodeURIComponent(workflowId)}/rollout`
  const platformVersion = useInvalidationNonce(WORKFLOW_ROLLOUT_TAGS)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const addToast = useWorkflowStore(state => state.addToast)
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [rollout, setRollout] = useState<WorkflowRollout | null>(null)
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT)
  const [qualificationGate, setQualificationGate] = useState<RecoveryQualificationGate | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading')
  const loading = loadState === 'loading'
  const loadError = loadState === 'error'
  const [retry, setRetry] = useState(0)
  const [mutating, setMutating] = useState(false)

  useEffect(() => {
    const request = new AbortController()
    owner.current = request
    setVersions([])
    setRollout(null)
    setQualificationGate(null)
    setMutating(false)
    setLoadState('loading')
    Promise.all([
      readWorkflowVersionPage(workflowId, {}, request.signal),
      api(rolloutPath, { signal: request.signal }),
    ]).then(([versionsPayload, rolloutPayload]) => {
      if (!current(request)) return
      const nextRollout = parseRollout(rolloutPayload)
      if ((!nextRollout && asRecord(rolloutPayload)?.rollout !== null)
        || (nextRollout && nextRollout.workflowId !== workflowId)) throw new Error(t('workflowRollout.invalidResponse'))
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
      addToast(tApiError(error) || t('workflowRollout.loadFailed'), 'error')
    })
    return () => { request.abort() }
  }, [addToast, current, platformVersion, retry, rolloutPath, t, workflowId])

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

  const canStart = !readOnly && !loading && !loadError && !mutating && Boolean(latest && draft.baselineVersionId
    && qualificationGate && !qualificationGate.loading
    && qualificationGate.baselineVersionId === draft.baselineVersionId && qualificationGate.candidateVersionId === latest.id
    && (!qualificationGate.required || qualificationGate.status === 'passed'))

  const mutate = async (request: AbortController, path: string, body: object, success: string,
    accepts: (value: WorkflowRollout) => boolean) => {
    setMutating(true)
    try {
      const payload = await api(path, { method: 'POST', signal: request.signal, body: JSON.stringify(body) })
      if (!current(request)) return
      const updated = parseRollout(payload)
      if (!updated || updated.workflowId !== workflowId || !accepts(updated)) throw new Error(t('workflowRollout.invalidResponse'))
      setRollout(updated)
      addToast(t(success), 'success')
      bumpPlatformVersion(WORKFLOW_ROLLOUT_MUTATION_TAGS)
    } catch (error) {
      if (current(request)) addToast(tApiError(error) || t('workflowRollout.decisionFailed'), 'error')
    } finally {
      if (current(request)) setMutating(false)
    }
  }

  const createRollout = async () => {
    const request = owner.current
    if (!current(request) || !canStart || !latest) return
    await mutate(request, rolloutPath,
      { ...draft, canaryVersionId: latest.id }, 'workflowRollout.started',
      value => value.baselineVersionId === draft.baselineVersionId && value.canaryVersionId === latest.id)
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
    if (!accepted || !current(request)) return
    await mutate(request, `${rolloutPath}/${encodeURIComponent(rollout.id)}/${decision}`,
      {}, decision === 'promote' ? 'workflowRollout.promoted' : 'workflowRollout.rolledBack', value => value.id === rollout.id)
  }

  return (
    <section className="we-card we-rollout-panel" aria-labelledby="workflow-rollout-title" data-testid="workflow-rollout-panel">
      <div className="we-card__header">
        <div>
          <p className="eyebrow"><GitBranch size={13} aria-hidden="true" /> {t('workflowRollout.eyebrow')}</p>
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
        <Button onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</Button></div>}

      {!loading && !loadError && versions.length < 2 && (
        <p className="we-rollout-panel__empty">{t('workflowRollout.needsVersions')}</p>
      )}

      {!loading
        && versions.length >= 2
        && qualificationBaselineVersionId
        && qualificationCandidateVersionId && (
        <Suspense fallback={<p className="helper-text" role="status">{t('workflowRollout.qualification.loading')}</p>}>
          <WorkflowRecoveryQualification
            key={`${platformVersion}:${retry}:${qualificationBaselineVersionId}:${qualificationCandidateVersionId}`}
            workflowId={workflowId}
            baselineVersionId={qualificationBaselineVersionId}
            candidateVersionId={qualificationCandidateVersionId}
            readOnly={readOnly}
            onGateChange={setQualificationGate}
          />
        </Suspense>
      )}

      {!readOnly
        && !loading
        && versions.length >= 2
        && (!rollout || !rolloutControlsLatest)
        && latest && (
        <form className="we-rollout-panel__form" onSubmit={event => { event.preventDefault(); void createRollout() }}>
          <div className="we-rollout-panel__pair">
            <FormField label={t('workflowRollout.baseline')}>
              {(controlProps) => (
                <select
                  {...controlProps}
                  value={draft.baselineVersionId}
                  onChange={event => setDraft({ ...draft, baselineVersionId: event.target.value })}
                  disabled={mutating}
                >
                  {versions.slice(1).map(version => <option key={version.id} value={version.id}>v{version.version}</option>)}
                </select>
              )}
            </FormField>
            <div className="we-rollout-panel__canary">
              <span>{t('workflowRollout.canary')}</span>
              <strong>v{latest.version}</strong>
            </div>
          </div>
          <div className="we-rollout-panel__fields">
            {([
              ['trafficPercent', 'traffic', 1, 50],
              ['minimumSampleSize', 'sample', 5, 100],
              ['minimumSuccessRatePercent', 'successRate', 1, 100],
            ] as const).map(([field, label, min, max]) => (
              <FormField key={field} label={t(`workflowRollout.${label}`)}>
                {controlProps => (
                  <span className="we-rollout-panel__input-unit" data-unit={field !== 'minimumSampleSize'}>
                    <input
                      {...controlProps}
                      type="number"
                      min={min}
                      max={max}
                      value={draft[field]}
                      disabled={mutating}
                      onChange={event => setDraft({ ...draft, [field]: Number(event.target.value) })}
                    />
                    {field !== 'minimumSampleSize' && <span aria-hidden="true">{t('workflowRollout.percentUnit')}</span>}
                  </span>
                )}
              </FormField>
            ))}
          </div>
          <p className="helper-text">{t('workflowRollout.guardrailHint')}</p>
          {qualificationGate?.required && qualificationGate.status !== 'passed' && (
            <p className="we-rollout-panel__qualification-blocked">
              {t('workflowRollout.qualification.blockedHint')}
            </p>
          )}
          <Button variant="primary"
            type="submit"

            disabled={!canStart}
          >
            {mutating ? t('workflowRollout.starting') : t('workflowRollout.start')}
          </Button>
        </form>
      )}
    </section>
  )
}
