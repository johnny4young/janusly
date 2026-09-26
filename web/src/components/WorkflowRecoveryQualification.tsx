import { useEffect, useRef, useState } from 'react'

import { contractApi } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { Button } from '@/components/ui/Button'
import type { QualificationEnvelope, QualificationSummary } from '../lib/api-types.generated'
import { isGetWorkflowsWorkflowIdRolloutQualificationResponse } from '../lib/api-guards/operations/GetWorkflowsWorkflowIdRolloutQualification'
import { isPostWorkflowsWorkflowIdRolloutQualificationResponse } from '../lib/api-guards/operations/PostWorkflowsWorkflowIdRolloutQualification'
import { MalformedResponseError } from '../lib/malformed-response'
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
    failures: Array<Pick<QualificationSummary['failures'][number], 'dataset' | 'fixtureId' | 'sourceNodeId' | 'reason'>>
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

const STATUSES: ReadonlySet<string> = new Set<RecoveryQualification['status']>(['passed', 'failed'])
const MODES: ReadonlySet<string> = new Set<RecoveryQualification['mode']>(['bootstrap', 'compare'])
// wire-policy: how many failures the card lists, not a wire bound.
const VISIBLE_FAILURES = 5

/**
 * Shape, including the failure dataset and reason vocabularies, is the
 * generated guard's. The rollout gate must describe the exact workflow and
 * version pair the form selected, and the card translates only a passed or
 * failed qualification in bootstrap or compare mode.
 */
function parseRecoveryQualification(
  payload: QualificationEnvelope,
  workflowId: string,
  baselineVersionId: string,
  candidateVersionId: string,
): RecoveryQualificationState | null {
  const row = payload.qualification
  if (row === null) return { required: payload.required, qualification: null }
  if (row.workflowId !== workflowId || row.baselineVersionId !== baselineVersionId
    || row.candidateVersionId !== candidateVersionId
    || !STATUSES.has(row.status) || !MODES.has(row.mode)) return null
  const summary = row.summary
  return {
    required: payload.required,
    qualification: {
      baselineVersionId: row.baselineVersionId,
      candidateVersionId: row.candidateVersionId,
      mode: row.mode as RecoveryQualification['mode'],
      status: row.status as RecoveryQualification['status'],
      summary: {
        candidateAssertionCount: summary.candidateAssertionCount,
        passedCandidateAssertions: summary.passedCandidateAssertions,
        regressionCount: summary.regressionCount,
        coverageFailureCount: summary.coverageFailureCount,
        failures: summary.failures.map(({ dataset, fixtureId, sourceNodeId, reason }) => ({
          dataset, fixtureId, sourceNodeId, reason,
        })),
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
    contractApi(
      'GET /workflows/{workflowId}/rollout/qualification',
      `${qualificationPath}?${query.toString()}`,
      undefined,
      { signal: abortController.signal, guard: isGetWorkflowsWorkflowIdRolloutQualificationResponse },
    )
      .then(payload => {
        if (abortController.signal.aborted) return
        const parsed = parseRecoveryQualification(payload, workflowId, baselineVersionId, candidateVersionId)
        if (!parsed) throw new MalformedResponseError()
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
        addToast(error instanceof MalformedResponseError
          ? t('workflowRollout.qualification.invalidResponse')
          : tApiError(error) || t('workflowRollout.qualification.loadFailed'), 'error')
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
    workflowId,
  ])

  const runQualification = async () => {
    const request = owner.current
    if (!request || request.signal.aborted || readOnly || loading || qualifying) return
    setQualifying(true)
    try {
      const payload = await contractApi(
        'POST /workflows/{workflowId}/rollout/qualification',
        qualificationPath,
        { baselineVersionId, candidateVersionId },
        { signal: request.signal, guard: isPostWorkflowsWorkflowIdRolloutQualificationResponse },
      )
      if (request.signal.aborted) return
      const parsed = parseRecoveryQualification(payload, workflowId, baselineVersionId, candidateVersionId)
      if (!parsed?.qualification) throw new MalformedResponseError()
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
      if (!request.signal.aborted) {
        addToast(error instanceof MalformedResponseError
          ? t('workflowRollout.qualification.invalidResponse')
          : tApiError(error) || t('workflowRollout.qualification.runFailed'), 'error')
      }
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
            {qualification.summary.failures.slice(0, VISIBLE_FAILURES).map(failure => (
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
          {(qualification.summary.failures.length > VISIBLE_FAILURES
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
