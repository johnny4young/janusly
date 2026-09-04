/**
 * Inspector deployment control for deterministic baseline/canary traffic.
 *
 * Operators choose an older immutable baseline and the latest saved version as
 * canary. The server owns compatibility, assignment, counters, and automatic
 * rollback; this panel only renders a defensive projection and bounded inputs.
 */

import { GitBranch } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'

import { api, contractApi } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { useConfirm } from './ConfirmDialog'
import type {
  RecoveryQualificationGate,
} from './WorkflowRecoveryQualification'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/Form'
import { asRecord } from '../lib/guards'

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
  rolledBackReason: string | null
  createdAt: string
  updatedAt: string
  endedAt: string | null
  lastOutcomeAt: string | null
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

function parseVersions(payload: unknown): VersionRow[] {
  if (!Array.isArray(payload)) return []
  const rows: VersionRow[] = []
  for (const item of payload) {
    const record = asRecord(item)
    const id = typeof record?.id === 'string' ? record.id : null
    const version = boundedInteger(record?.version, 1)
    if (id && version !== null) rows.push({ id, version })
  }
  return rows.sort((left, right) => right.version - left.version)
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
    rolledBackReason: typeof row.rolledBackReason === 'string' ? row.rolledBackReason : null,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
    endedAt: typeof row.endedAt === 'string' ? row.endedAt : null,
    lastOutcomeAt: typeof row.lastOutcomeAt === 'string' ? row.lastOutcomeAt : null,
  }
}

function successRate(succeeded: number, failed: number): number | null {
  const total = succeeded + failed
  return total === 0 ? null : (succeeded / total) * 100
}

export function WorkflowRolloutPanel({ readOnly = false }: { readOnly?: boolean } = {}) {
  const { t } = useT()
  const confirm = useConfirm()
  const workflowId = useWorkflowStore(state => state.currentWorkflowSaved ? state.currentWorkflowId : undefined)
  const platformVersion = useWorkflowStore(state => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore(state => state.bumpPlatformVersion)
  const addToast = useWorkflowStore(state => state.addToast)
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [rollout, setRollout] = useState<WorkflowRollout | null>(null)
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT)
  const [qualificationGate, setQualificationGate] = useState<RecoveryQualificationGate | null>(null)
  const [loading, setLoading] = useState(false)
  const [mutating, setMutating] = useState(false)

  useEffect(() => {
    if (!workflowId) {
      setVersions([])
      setRollout(null)
      setQualificationGate(null)
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all([
      contractApi('GET /workflows/versions', `/workflows/versions?workflowId=${encodeURIComponent(workflowId)}`, undefined),
      api(`/workflows/${encodeURIComponent(workflowId)}/rollout`),
    ]).then(([versionsPayload, rolloutPayload]) => {
      if (cancelled) return
      const nextVersions = parseVersions(versionsPayload)
      setVersions(nextVersions)
      setRollout(parseRollout(rolloutPayload))
      setDraft(current => ({
        ...current,
        baselineVersionId: nextVersions.some(version => version.id === current.baselineVersionId)
          ? current.baselineVersionId
          : (nextVersions[1]?.id ?? ''),
      }))
    }).catch(error => {
      if (!cancelled) addToast(tApiError(error) || t('workflowRollout.loadFailed'), 'error')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [addToast, platformVersion, t, workflowId])

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

  useEffect(() => {
    setQualificationGate(null)
  }, [qualificationBaselineVersionId, qualificationCandidateVersionId])

  if (!workflowId) return null

  const createRollout = async () => {
    if (!latest || !draft.baselineVersionId) return
    setMutating(true)
    try {
      const payload = await api(`/workflows/${encodeURIComponent(workflowId)}/rollout`, {
        method: 'POST',
        body: JSON.stringify({
          ...draft,
          canaryVersionId: latest.id,
        }),
      })
      const created = parseRollout(payload)
      if (!created) throw new Error(t('workflowRollout.invalidResponse'))
      setRollout(created)
      addToast(t('workflowRollout.started'), 'success')
      bumpPlatformVersion()
    } catch (error) {
      addToast(tApiError(error) || (error instanceof Error ? error.message : t('workflowRollout.startFailed')), 'error')
    } finally {
      setMutating(false)
    }
  }

  const decide = async (decision: 'promote' | 'rollback') => {
    if (!rollout) return
    const accepted = await confirm({
      title: t(decision === 'promote' ? 'workflowRollout.promoteTitle' : 'workflowRollout.rollbackTitle'),
      body: t(decision === 'promote' ? 'workflowRollout.promoteConfirm' : 'workflowRollout.rollbackConfirm'),
      confirmLabel: t(decision === 'promote' ? 'workflowRollout.promote' : 'workflowRollout.rollback'),
      tone: decision === 'rollback' ? 'danger' : 'default',
    })
    if (!accepted) return
    setMutating(true)
    try {
      const payload = await api(
        `/workflows/${encodeURIComponent(workflowId)}/rollout/${encodeURIComponent(rollout.id)}/${decision}`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      const updated = parseRollout(payload)
      if (!updated) throw new Error(t('workflowRollout.invalidResponse'))
      setRollout(updated)
      addToast(t(decision === 'promote' ? 'workflowRollout.promoted' : 'workflowRollout.rolledBack'), 'success')
      bumpPlatformVersion()
    } catch (error) {
      addToast(tApiError(error) || (error instanceof Error ? error.message : t('workflowRollout.decisionFailed')), 'error')
    } finally {
      setMutating(false)
    }
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

      {!loading && versions.length < 2 && (
        <p className="we-rollout-panel__empty">{t('workflowRollout.needsVersions')}</p>
      )}

      {!loading
        && versions.length >= 2
        && qualificationBaselineVersionId
        && qualificationCandidateVersionId && (
        <Suspense fallback={<p className="helper-text" role="status">{t('workflowRollout.qualification.loading')}</p>}>
          <WorkflowRecoveryQualification
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
            <FormField id="workflow-rollout-traffic" label={t('workflowRollout.traffic')}>
              {(controlProps) => (
                <span className="we-rollout-panel__input-unit">
                  <input
                    {...controlProps}
                    type="number"
                    min={1}
                    max={50}
                    value={draft.trafficPercent}
                    disabled={mutating}
                    onChange={event => setDraft({ ...draft, trafficPercent: Number(event.target.value) })}
                  />
                  <span aria-hidden="true">{t('workflowRollout.percentUnit')}</span>
                </span>
              )}
            </FormField>
            <FormField id="workflow-rollout-minimum-outcomes" label={t('workflowRollout.sample')}>
              {(controlProps) => (
                <input
                  {...controlProps}
                  type="number"
                  min={5}
                  max={100}
                  value={draft.minimumSampleSize}
                  disabled={mutating}
                  onChange={event => setDraft({ ...draft, minimumSampleSize: Number(event.target.value) })}
                />
              )}
            </FormField>
            <FormField id="workflow-rollout-success-floor" label={t('workflowRollout.successRate')}>
              {(controlProps) => (
                <span className="we-rollout-panel__input-unit">
                  <input
                    {...controlProps}
                    type="number"
                    min={1}
                    max={100}
                    value={draft.minimumSuccessRatePercent}
                    disabled={mutating}
                    onChange={event => setDraft({ ...draft, minimumSuccessRatePercent: Number(event.target.value) })}
                  />
                  <span aria-hidden="true">{t('workflowRollout.percentUnit')}</span>
                </span>
              )}
            </FormField>
          </div>
          <p className="helper-text">{t('workflowRollout.guardrailHint')}</p>
          {qualificationGate?.required && qualificationGate.status !== 'passed' && (
            <p className="we-rollout-panel__qualification-blocked">
              {t('workflowRollout.qualification.blockedHint')}
            </p>
          )}
          <Button variant="primary"
            type="submit"

            disabled={
              mutating
              || !draft.baselineVersionId
              || qualificationGate === null
              || qualificationGate.loading
              || (qualificationGate.required && qualificationGate.status !== 'passed')
            }
          >
            {mutating ? t('workflowRollout.starting') : t('workflowRollout.start')}
          </Button>
        </form>
      )}
    </section>
  )
}
