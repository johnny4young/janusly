import { useEffect, useState } from 'react'

import { api } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'

export type RecoveryQualification = {
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

export type RecoveryQualificationState = {
  required: boolean
  qualification: RecoveryQualification | null
}

export type RecoveryQualificationGate = {
  loading: boolean
  required: boolean
  status: RecoveryQualification['status'] | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function boundedInteger(value: unknown, min = 0): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min
    ? value
    : null
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
  const values = summaryKeys.map(key => boundedInteger(summary[key]))
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

export function WorkflowRecoveryQualification({
  workflowId,
  baselineVersionId,
  candidateVersionId,
  platformVersion,
  readOnly,
  onGateChange,
}: {
  workflowId: string
  baselineVersionId: string
  candidateVersionId: string
  platformVersion: number
  readOnly: boolean
  onGateChange: (gate: RecoveryQualificationGate | null) => void
}) {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const [state, setState] = useState<RecoveryQualificationState | null>(null)
  const [loading, setLoading] = useState(false)
  const [qualifying, setQualifying] = useState(false)
  const qualification = state?.qualification

  useEffect(() => {
    let cancelled = false
    setState(null)
    setLoading(true)
    onGateChange({ loading: true, required: true, status: null })
    const query = new URLSearchParams({
      baselineVersionId,
      candidateVersionId,
    })
    api(`/workflows/${encodeURIComponent(workflowId)}/rollout/qualification?${query.toString()}`)
      .then(payload => {
        if (cancelled) return
        const parsed = parseRecoveryQualification(payload)
        if (!parsed) throw new Error(t('workflowRollout.qualification.invalidResponse'))
        setState(parsed)
        onGateChange({
          loading: false,
          required: parsed.required,
          status: parsed.qualification?.status ?? null,
        })
      })
      .catch(error => {
        if (cancelled) return
        onGateChange(null)
        addToast(tApiError(error) || t('workflowRollout.qualification.loadFailed'), 'error')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [
    addToast,
    baselineVersionId,
    candidateVersionId,
    onGateChange,
    platformVersion,
    t,
    workflowId,
  ])

  const runQualification = async () => {
    setQualifying(true)
    try {
      const payload = await api(`/workflows/${encodeURIComponent(workflowId)}/rollout/qualification`, {
        method: 'POST',
        body: JSON.stringify({
          baselineVersionId,
          candidateVersionId,
        }),
      })
      const parsed = parseRecoveryQualification(payload)
      if (!parsed?.qualification) throw new Error(t('workflowRollout.qualification.invalidResponse'))
      setState(parsed)
      onGateChange({
        loading: false,
        required: parsed.required,
        status: parsed.qualification.status,
      })
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

  if (!loading && !state?.required) return null

  return (
    <div
      className="we-rollout-panel__qualification"
      data-status={qualification?.status ?? 'pending'}
      data-testid="workflow-recovery-qualification"
    >
      <div className="we-rollout-panel__qualification-header">
        <div>
          <span>{t('workflowRollout.qualification.eyebrow')}</span>
          <strong>{t('workflowRollout.qualification.title')}</strong>
        </div>
        <span
          className="we-pill"
          data-tone={qualification?.status === 'passed' ? 'success' : qualification?.status === 'failed' ? 'danger' : 'warning'}
        >
          {loading
            ? t('workflowRollout.qualification.loading')
            : t(`workflowRollout.qualification.status.${qualification?.status ?? 'pending'}`)}
        </span>
      </div>
      <p className="helper-text">
        {qualification
          ? t(`workflowRollout.qualification.mode.${qualification.mode}`)
          : t('workflowRollout.qualification.description')}
      </p>
      {qualification && (
        <div className="we-rollout-panel__qualification-metrics">
          <div>
            <span>{t('workflowRollout.qualification.assertions')}</span>
            <strong>
              {qualification.summary.passedCandidateAssertions}
              /{qualification.summary.candidateAssertionCount}
            </strong>
          </div>
          <div>
            <span>{t('workflowRollout.qualification.regressions')}</span>
            <strong>{qualification.summary.regressionCount}</strong>
          </div>
          <div>
            <span>{t('workflowRollout.qualification.coverage')}</span>
            <strong>{qualification.summary.coverageFailureCount}</strong>
          </div>
        </div>
      )}
      {qualification?.status === 'failed' && qualification.summary.failures.length > 0 && (
        <div className="we-rollout-panel__qualification-failures">
          <strong>{t('workflowRollout.qualification.failuresTitle')}</strong>
          <ul>
            {qualification.summary.failures.slice(0, 5).map(failure => (
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
          {(qualification.summary.failures.length > 5
            || qualification.summary.failuresTruncated) && (
            <p>{t('workflowRollout.qualification.failuresBounded')}</p>
          )}
        </div>
      )}
      {!readOnly && (
        <button
          type="button"
          className="command-button"
          disabled={qualifying || loading}
          onClick={() => { void runQualification() }}
        >
          {qualifying
            ? t('workflowRollout.qualification.running')
            : t(qualification
              ? 'workflowRollout.qualification.runAgain'
              : 'workflowRollout.qualification.run')}
        </button>
      )}
    </div>
  )
}
