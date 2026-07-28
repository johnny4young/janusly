/**
 * Inspector deployment control for deterministic baseline/canary traffic.
 *
 * Operators choose an older immutable baseline and the latest saved version as
 * canary. The server owns compatibility, assignment, counters, and automatic
 * rollback; this panel only renders a defensive projection and bounded inputs.
 */

import { GitBranch, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { api } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { useConfirm } from './ConfirmDialog'

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

type RecoveryQualification = {
  id: string
  baselineVersionId: string
  candidateVersionId: string
  datasetVersion: string
  datasetDigest: string
  mode: 'bootstrap' | 'compare'
  status: 'passed' | 'failed'
  createdAt: string
  summary: {
    candidateAssertionCount: number
    passedCandidateAssertions: number
    failedCandidateAssertions: number
    regressionCount: number
    coverageFailureCount: number
    failures: Array<{
      dataset: 'baseline' | 'candidate'
      fixtureId: string
      sourceNodeId: string
      reason:
        | 'baseline_dataset_invalid'
        | 'candidate_contract_missing'
        | 'detector_uncovered'
        | 'expected_mismatch'
    }>
    failuresTruncated: boolean
  }
}

type RecoveryQualificationState = {
  required: boolean
  qualification: RecoveryQualification | null
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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

function parseRecoveryQualification(payload: unknown): RecoveryQualificationState | null {
  const envelope = asRecord(payload)
  if (typeof envelope?.required !== 'boolean') return null
  if (envelope.qualification === null) {
    return { required: envelope.required, qualification: null }
  }
  const row = asRecord(envelope.qualification)
  const summary = asRecord(row?.summary)
  if (!row || !summary) return { required: envelope.required, qualification: null }
  if (row.status !== 'passed' && row.status !== 'failed') return { required: envelope.required, qualification: null }
  if (row.mode !== 'bootstrap' && row.mode !== 'compare') return { required: envelope.required, qualification: null }
  const strings = ['id', 'baselineVersionId', 'candidateVersionId', 'datasetVersion', 'datasetDigest', 'createdAt'] as const
  if (strings.some(key => typeof row[key] !== 'string' || row[key].length === 0)) {
    return { required: envelope.required, qualification: null }
  }
  const summaryKeys = [
    'candidateAssertionCount',
    'passedCandidateAssertions',
    'failedCandidateAssertions',
    'regressionCount',
    'coverageFailureCount',
  ] as const
  const values = summaryKeys.map(key => boundedInteger(summary[key], 0))
  if (
    values.some(value => value === null)
    || !Array.isArray(summary.failures)
    || typeof summary.failuresTruncated !== 'boolean'
  ) {
    return { required: envelope.required, qualification: null }
  }
  const failures: RecoveryQualification['summary']['failures'] = []
  for (const item of summary.failures) {
    const failure = asRecord(item)
    if (!failure) return { required: envelope.required, qualification: null }
    const dataset = failure.dataset
    const reason = failure.reason
    if (
      (dataset !== 'baseline' && dataset !== 'candidate')
      || (
        reason !== 'baseline_dataset_invalid'
        && reason !== 'candidate_contract_missing'
        && reason !== 'detector_uncovered'
        && reason !== 'expected_mismatch'
      )
      || typeof failure.fixtureId !== 'string'
      || typeof failure.sourceNodeId !== 'string'
    ) {
      return { required: envelope.required, qualification: null }
    }
    failures.push({
      dataset,
      fixtureId: failure.fixtureId,
      sourceNodeId: failure.sourceNodeId,
      reason,
    })
  }
  return {
    required: envelope.required,
    qualification: {
      id: row.id as string,
      baselineVersionId: row.baselineVersionId as string,
      candidateVersionId: row.candidateVersionId as string,
      datasetVersion: row.datasetVersion as string,
      datasetDigest: row.datasetDigest as string,
      mode: row.mode,
      status: row.status,
      createdAt: row.createdAt as string,
      summary: {
        candidateAssertionCount: values[0]!,
        passedCandidateAssertions: values[1]!,
        failedCandidateAssertions: values[2]!,
        regressionCount: values[3]!,
        coverageFailureCount: values[4]!,
        failures,
        failuresTruncated: summary.failuresTruncated,
      },
    },
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
  const [qualificationState, setQualificationState] = useState<RecoveryQualificationState | null>(null)
  const [loading, setLoading] = useState(false)
  const [qualificationLoading, setQualificationLoading] = useState(false)
  const [qualifying, setQualifying] = useState(false)
  const [mutating, setMutating] = useState(false)

  useEffect(() => {
    if (!workflowId) {
      setVersions([])
      setRollout(null)
      setQualificationState(null)
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all([
      api(`/workflows/versions?workflowId=${encodeURIComponent(workflowId)}`),
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
  const canCreate = versions.length >= 2 && (!rollout || !rolloutControlsLatest)
  const qualificationBaselineVersionId = rollout && rolloutControlsLatest
    ? rollout.baselineVersionId
    : draft.baselineVersionId
  const qualificationCandidateVersionId = rollout && rolloutControlsLatest
    ? rollout.canaryVersionId
    : latest?.id
  const canaryRate = useMemo(
    () => rollout ? successRate(rollout.canarySucceeded, rollout.canaryFailed) : null,
    [rollout],
  )

  useEffect(() => {
    if (!workflowId || !qualificationBaselineVersionId || !qualificationCandidateVersionId) {
      setQualificationState(null)
      setQualificationLoading(false)
      return
    }
    let cancelled = false
    setQualificationState(null)
    setQualificationLoading(true)
    const query = new URLSearchParams({
      baselineVersionId: qualificationBaselineVersionId,
      candidateVersionId: qualificationCandidateVersionId,
    })
    api(`/workflows/${encodeURIComponent(workflowId)}/rollout/qualification?${query.toString()}`)
      .then(payload => {
        if (cancelled) return
        const parsed = parseRecoveryQualification(payload)
        if (!parsed) throw new Error(t('workflowRollout.qualification.invalidResponse'))
        setQualificationState(parsed)
      })
      .catch(error => {
        if (!cancelled) addToast(tApiError(error) || t('workflowRollout.qualification.loadFailed'), 'error')
      })
      .finally(() => {
        if (!cancelled) setQualificationLoading(false)
      })
    return () => { cancelled = true }
  }, [
    addToast,
    platformVersion,
    qualificationBaselineVersionId,
    qualificationCandidateVersionId,
    t,
    workflowId,
  ])

  if (!workflowId) return null

  const runQualification = async () => {
    if (!qualificationBaselineVersionId || !qualificationCandidateVersionId) return
    setQualifying(true)
    try {
      const payload = await api(`/workflows/${encodeURIComponent(workflowId)}/rollout/qualification`, {
        method: 'POST',
        body: JSON.stringify({
          baselineVersionId: qualificationBaselineVersionId,
          candidateVersionId: qualificationCandidateVersionId,
        }),
      })
      const parsed = parseRecoveryQualification(payload)
      if (!parsed?.qualification) throw new Error(t('workflowRollout.qualification.invalidResponse'))
      setQualificationState(parsed)
      addToast(
        t(parsed.qualification.status === 'passed'
          ? 'workflowRollout.qualification.passedToast'
          : 'workflowRollout.qualification.failedToast'),
        parsed.qualification.status === 'passed' ? 'success' : 'error',
      )
    } catch (error) {
      addToast(tApiError(error) || t('workflowRollout.qualification.runFailed'), 'error')
    } finally {
      setQualifying(false)
    }
  }

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
        <div className="we-rollout-panel__status" data-testid="workflow-rollout-status">
          <div className="we-rollout-panel__versions">
            <span>{t('workflowRollout.baselineVersion', { version: baseline?.version ?? '?' })}</span>
            <strong>{t('workflowRollout.trafficToCanary', { percent: rollout.trafficPercent, version: canary?.version ?? '?' })}</strong>
          </div>
          <progress
            className="we-rollout-panel__progress"
            max={100}
            value={rollout.trafficPercent}
            aria-label={t('workflowRollout.trafficProgress')}
          />
          <div className="we-rollout-panel__metrics">
            <div><span>{t('workflowRollout.baselineRuns')}</span><strong>{rollout.baselineSucceeded + rollout.baselineFailed}</strong></div>
            <div><span>{t('workflowRollout.canaryRuns')}</span><strong>{rollout.canarySucceeded + rollout.canaryFailed}</strong></div>
            <div><span>{t('workflowRollout.canarySuccess')}</span><strong>{canaryRate === null ? '—' : `${canaryRate.toFixed(1)}%`}</strong></div>
            <div><span>{t('workflowRollout.guardrail')}</span><strong>≥ {rollout.minimumSuccessRatePercent}% / {rollout.minimumSampleSize}</strong></div>
          </div>
          {!readOnly && rollout.status === 'active' && (
            <div className="we-rollout-panel__actions">
              <button type="button" className="command-button command-button-primary" disabled={mutating} onClick={() => void decide('promote')}>
                {t('workflowRollout.promote')}
              </button>
              <button type="button" className="command-button command-button-danger" disabled={mutating} onClick={() => void decide('rollback')}>
                {t('workflowRollout.rollback')}
              </button>
            </div>
          )}
          {rollout.status !== 'active' && (
            <p className="we-rollout-panel__decision">
              <ShieldCheck size={15} aria-hidden="true" />
              {t(`workflowRollout.decision.${rollout.status}`)}
            </p>
          )}
        </div>
      )}

      {!loading && versions.length < 2 && (
        <p className="we-rollout-panel__empty">{t('workflowRollout.needsVersions')}</p>
      )}

      {!loading && versions.length >= 2 && (qualificationLoading || qualificationState?.required) && (
        <div
          className="we-rollout-panel__qualification"
          data-status={qualificationState?.qualification?.status ?? 'pending'}
          data-testid="workflow-recovery-qualification"
        >
          <div className="we-rollout-panel__qualification-header">
            <div>
              <span>{t('workflowRollout.qualification.eyebrow')}</span>
              <strong>{t('workflowRollout.qualification.title')}</strong>
            </div>
            <span
              className="we-pill"
              data-tone={qualificationState?.qualification?.status === 'passed' ? 'success' : qualificationState?.qualification?.status === 'failed' ? 'danger' : 'warning'}
            >
              {qualificationLoading
                ? t('workflowRollout.qualification.loading')
                : t(`workflowRollout.qualification.status.${qualificationState?.qualification?.status ?? 'pending'}`)}
            </span>
          </div>
          <p className="helper-text">
            {qualificationState?.qualification
              ? t(`workflowRollout.qualification.mode.${qualificationState.qualification.mode}`)
              : t('workflowRollout.qualification.description')}
          </p>
          {qualificationState?.qualification && (
            <div className="we-rollout-panel__qualification-metrics">
              <div>
                <span>{t('workflowRollout.qualification.assertions')}</span>
                <strong>
                  {qualificationState.qualification.summary.passedCandidateAssertions}
                  /{qualificationState.qualification.summary.candidateAssertionCount}
                </strong>
              </div>
              <div>
                <span>{t('workflowRollout.qualification.regressions')}</span>
                <strong>{qualificationState.qualification.summary.regressionCount}</strong>
              </div>
              <div>
                <span>{t('workflowRollout.qualification.coverage')}</span>
                <strong>{qualificationState.qualification.summary.coverageFailureCount}</strong>
              </div>
            </div>
          )}
          {qualificationState?.qualification?.status === 'failed'
            && qualificationState.qualification.summary.failures.length > 0 && (
            <div className="we-rollout-panel__qualification-failures">
              <strong>{t('workflowRollout.qualification.failuresTitle')}</strong>
              <ul>
                {qualificationState.qualification.summary.failures.slice(0, 5).map(failure => (
                  <li key={`${failure.dataset}:${failure.fixtureId}:${failure.reason}`}>
                    <span>
                      {t(`workflowRollout.qualification.dataset.${failure.dataset}`)}
                      {' · '}
                      {failure.fixtureId}
                      {failure.sourceNodeId ? ` · ${failure.sourceNodeId}` : ''}
                    </span>
                    <small>{t(`workflowRollout.qualification.failure.${failure.reason}`)}</small>
                  </li>
                ))}
              </ul>
              {(qualificationState.qualification.summary.failures.length > 5
                || qualificationState.qualification.summary.failuresTruncated) && (
                <p>{t('workflowRollout.qualification.failuresBounded')}</p>
              )}
            </div>
          )}
          {!readOnly && (
            <button
              type="button"
              className="command-button"
              disabled={qualifying || qualificationLoading}
              onClick={() => void runQualification()}
            >
              {qualifying
                ? t('workflowRollout.qualification.running')
                : t(qualificationState?.qualification
                  ? 'workflowRollout.qualification.runAgain'
                  : 'workflowRollout.qualification.run')}
            </button>
          )}
        </div>
      )}

      {!readOnly && !loading && canCreate && latest && (
        <form className="we-rollout-panel__form" onSubmit={event => { event.preventDefault(); void createRollout() }}>
          <div className="we-rollout-panel__pair">
            <label className="we-field">
              <span>{t('workflowRollout.baseline')}</span>
              <select value={draft.baselineVersionId} onChange={event => setDraft({ ...draft, baselineVersionId: event.target.value })} disabled={mutating}>
                {versions.slice(1).map(version => <option key={version.id} value={version.id}>v{version.version}</option>)}
              </select>
            </label>
            <div className="we-rollout-panel__canary">
              <span>{t('workflowRollout.canary')}</span>
              <strong>v{latest.version}</strong>
            </div>
          </div>
          <div className="we-rollout-panel__fields">
            <div className="we-field">
              <label htmlFor="workflow-rollout-traffic">{t('workflowRollout.traffic')}</label>
              <span className="we-rollout-panel__input-unit">
                <input id="workflow-rollout-traffic" type="number" min={1} max={50} value={draft.trafficPercent} disabled={mutating} onChange={event => setDraft({ ...draft, trafficPercent: Number(event.target.value) })} />
                <span aria-hidden="true">{t('workflowRollout.percentUnit')}</span>
              </span>
            </div>
            <div className="we-field">
              <label htmlFor="workflow-rollout-minimum-outcomes">{t('workflowRollout.sample')}</label>
              <input id="workflow-rollout-minimum-outcomes" type="number" min={5} max={100} value={draft.minimumSampleSize} disabled={mutating} onChange={event => setDraft({ ...draft, minimumSampleSize: Number(event.target.value) })} />
            </div>
            <div className="we-field">
              <label htmlFor="workflow-rollout-success-floor">{t('workflowRollout.successRate')}</label>
              <span className="we-rollout-panel__input-unit">
                <input id="workflow-rollout-success-floor" type="number" min={1} max={100} value={draft.minimumSuccessRatePercent} disabled={mutating} onChange={event => setDraft({ ...draft, minimumSuccessRatePercent: Number(event.target.value) })} />
                <span aria-hidden="true">{t('workflowRollout.percentUnit')}</span>
              </span>
            </div>
          </div>
          <p className="helper-text">{t('workflowRollout.guardrailHint')}</p>
          {qualificationState?.required && qualificationState.qualification?.status !== 'passed' && (
            <p className="we-rollout-panel__qualification-blocked">
              {t('workflowRollout.qualification.blockedHint')}
            </p>
          )}
          <button
            type="submit"
            className="command-button command-button-primary"
            disabled={
              mutating
              || !draft.baselineVersionId
              || qualificationLoading
              || qualificationState === null
              || (qualificationState.required && qualificationState.qualification?.status !== 'passed')
            }
          >
            {mutating ? t('workflowRollout.starting') : t('workflowRollout.start')}
          </button>
        </form>
      )}
    </section>
  )
}
