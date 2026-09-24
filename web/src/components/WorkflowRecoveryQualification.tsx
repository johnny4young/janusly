import { useEffect, useRef, useState } from 'react'

import { api } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { Button } from '@/components/ui/Button'
import { asRecord } from '../lib/guards'
import './WorkflowRecoveryQualification.css'

export type RecoveryQualification = {
  baselineVersionId: string
  candidateVersionId: string
  mode: 'bootstrap' | 'compare'
  status: 'passed' | 'failed'
  summary: {
    candidateAssertionCount: number
    passedCandidateAssertions: number
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
  baselineVersionId: string
  candidateVersionId: string
  loading: boolean
  required: boolean
  status: RecoveryQualification['status'] | null
}

function boundedInteger(value: unknown, min = 0): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min
    ? value
    : null
}

function parseRecoveryQualification(payload: unknown, baselineVersionId: string, candidateVersionId: string): RecoveryQualificationState | null {
  const envelope = asRecord(payload)
  if (typeof envelope?.required !== 'boolean') return null
  if (envelope.qualification === null) {
    return { required: envelope.required, qualification: null }
  }
  const row = asRecord(envelope.qualification)
  const summary = asRecord(row?.summary)
  if (!row || !summary || row.baselineVersionId !== baselineVersionId || row.candidateVersionId !== candidateVersionId) return null
  if (row.status !== 'passed' && row.status !== 'failed') return null
  if (row.mode !== 'bootstrap' && row.mode !== 'compare') return null
  const strings = ['id', 'baselineVersionId', 'candidateVersionId', 'datasetVersion', 'datasetDigest', 'createdAt'] as const
  if (strings.some(key => typeof row[key] !== 'string' || row[key].length === 0)) {
    return null
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
    return null
  }
  const failures: RecoveryQualification['summary']['failures'] = []
  for (const item of summary.failures) {
    const failure = asRecord(item)
    if (!failure) return null
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
      return null
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
      baselineVersionId: row.baselineVersionId as string,
      candidateVersionId: row.candidateVersionId as string,
      mode: row.mode,
      status: row.status,
      summary: {
        candidateAssertionCount: values[0]!,
        passedCandidateAssertions: values[1]!,
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
  readOnly,
  onGateChange,
}: {
  workflowId: string
  baselineVersionId: string
  candidateVersionId: string
  readOnly: boolean
  onGateChange: (gate: RecoveryQualificationGate | null) => void
}) {
  const { t } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const [state, setState] = useState<RecoveryQualificationState | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [qualifying, setQualifying] = useState(false)
  const owner = useRef<AbortController | null>(null)
  const qualificationPath = `/workflows/${encodeURIComponent(workflowId)}/rollout/qualification`
  const qualification = state?.qualification
  const loading = state === null && !loadError

  useEffect(() => {
    const abortController = new AbortController()
    owner.current = abortController
    setState(null)
    setLoadError(false)
    setQualifying(false)
    onGateChange({ baselineVersionId, candidateVersionId, loading: true, required: true, status: null })
    const query = new URLSearchParams({
      baselineVersionId,
      candidateVersionId,
    })
    api(
      `${qualificationPath}?${query.toString()}`,
      { signal: abortController.signal },
    )
      .then(payload => {
        if (abortController.signal.aborted) return
        const parsed = parseRecoveryQualification(payload, baselineVersionId, candidateVersionId)
        if (!parsed) throw new Error(t('workflowRollout.qualification.invalidResponse'))
        setState(parsed)
        onGateChange({
          baselineVersionId, candidateVersionId,
          loading: false,
          required: parsed.required,
          status: parsed.qualification?.status ?? null,
        })
      })
      .catch(error => {
        if (abortController.signal.aborted) return
        setLoadError(true)
        onGateChange(null)
        addToast(tApiError(error) || t('workflowRollout.qualification.loadFailed'), 'error')
      })
    return () => {
      abortController.abort()
    }
  }, [
    addToast,
    baselineVersionId,
    candidateVersionId,
    onGateChange,
    readOnly,
    retry,
    t,
    qualificationPath,
  ])

  const runQualification = async () => {
    const request = owner.current
    if (!request || request.signal.aborted || readOnly || loading || qualifying) return
    setQualifying(true)
    try {
      const payload = await api(qualificationPath, {
        method: 'POST', signal: request.signal,
        body: JSON.stringify({
          baselineVersionId,
          candidateVersionId,
        }),
      })
      if (request.signal.aborted) return
      const parsed = parseRecoveryQualification(payload, baselineVersionId, candidateVersionId)
      if (!parsed?.qualification) throw new Error(t('workflowRollout.qualification.invalidResponse'))
      setState(parsed)
      onGateChange({
        baselineVersionId, candidateVersionId,
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
      if (!request.signal.aborted) addToast(tApiError(error) || t('workflowRollout.qualification.runFailed'), 'error')
    } finally {
      if (!request.signal.aborted) setQualifying(false)
    }
  }

  if (loadError) return <div role="alert"><p>{t('workflowRollout.qualification.loadFailed')}</p>
    <Button onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</Button></div>
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
          {([
            ['assertions', `${qualification.summary.passedCandidateAssertions}/${qualification.summary.candidateAssertionCount}`],
            ['regressions', qualification.summary.regressionCount],
            ['coverage', qualification.summary.coverageFailureCount],
          ] as const).map(([label, value]) => <div key={label}>
            <span>{t(`workflowRollout.qualification.${label}`)}</span><strong>{value}</strong>
          </div>)}
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
        <Button variant="secondary"
          type="button"

          disabled={qualifying || loading}
          onClick={() => { void runQualification() }}
        >
          {qualifying
            ? t('workflowRollout.qualification.running')
            : t(qualification
              ? 'workflowRollout.qualification.runAgain'
              : 'workflowRollout.qualification.run')}
        </Button>
      )}
    </div>
  )
}
