import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  Gauge,
  History,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
  WandSparkles,
} from 'lucide-react'
import { V1_READ_PATHS } from '@/lib/api-contract'
import {
  candidatePayload,
  diagnosisPayload,
  parseRecoveryCaseDetail,
  parseResolution,
  selectCandidateId,
  validationPayload,
  type RecoveryCandidateKind,
  type RecoveryCaseDetail,
} from '@/lib/recovery-case-contract'

import { api, contractApi } from '../api'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import type { RecoveryCase } from '../types'
import { EmptyView, PanelChrome } from './panel-primitives'
import { Button } from './ui/Button'
import { FormActions, FormDisclosure, FormField } from './ui/Form'

const AUTHORING_PROMPT_MAX_RUNES = 4000

function recoveryCaseTone(
  state: RecoveryCase['state'],
  action: RecoveryCase['action'],
): 'danger' | 'warning' | 'info' | 'success' | 'neutral' {
  if (state === 'verified_recovered') return 'success'
  if (state === 'accepted_loss' || state === 'abandoned') return 'neutral'
  if (state === 'publishing' || state === 'monitoring') return 'info'
  if (state === 'recurred' || action === 'quarantine') return 'danger'
  return 'warning'
}

export function RecoveryCasePanel({
  caseId,
  canResolve,
  canInspectWorkflow = false,
  canAuthorWorkflow = false,
  onBack,
  onOpenRun,
  onOpenWorkflowVersion,
  onOpenAiAuthoring,
  onResolved,
}: {
  caseId: string | null
  canResolve: boolean
  canInspectWorkflow?: boolean
  canAuthorWorkflow?: boolean
  onBack: () => void
  onOpenRun: (runId: string) => void | Promise<void>
  onOpenWorkflowVersion?: (
    workflowId: string,
    workflowVersionId: string,
    targetTab: 'inspector' | 'ai-studio',
  ) => Promise<boolean>
  onOpenAiAuthoring?: (prompt: string) => void
  onResolved: () => void | Promise<void>
}) {
  const { t, i18n } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const [detail, setDetail] = useState<RecoveryCaseDetail | null>(null)
  const [loading, setLoading] = useState(Boolean(caseId))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [output, setOutput] = useState('{\n  "mode": "ai"\n}')
  const [reason, setReason] = useState('')
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)

  const loadCase = useCallback(async (
    preferredCandidateKind?: RecoveryCandidateKind,
    background = false,
  ) => {
    if (!caseId) {
      setDetail(null)
      setSelectedCandidateId(null)
      setLoading(false)
      return
    }
    if (!background) {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const path = `/v1${V1_READ_PATHS.recoveryCase.replace(
        '{caseId}',
        encodeURIComponent(caseId),
      )}`
      const parsed = parseRecoveryCaseDetail(await api(path))
      if (!parsed) {
        throw new Error(t('recoveryCase.invalidResponse'))
      }
      setDetail(parsed)
      setLoadError(null)
      const candidates = parsed.artifacts.filter(artifact => artifact.kind === 'candidate')
      setSelectedCandidateId(current => selectCandidateId(
        candidates,
        parsed.activeApproval?.candidateArtifactId ?? current,
        preferredCandidateKind,
      ))
    } catch (error) {
      if (!background) setDetail(null)
      setLoadError(tApiError(error) || t('recoveryCase.loadFailed'))
    } finally {
      if (!background) setLoading(false)
    }
  }, [caseId, t])

  useEffect(() => {
    void loadCase()
  }, [loadCase])

  useEffect(() => {
    if (detail?.case.state !== 'monitoring') return
    let cancelled = false
    let timeout = 0
    const refresh = async () => {
      await loadCase(undefined, true)
      if (!cancelled) timeout = window.setTimeout(refresh, 1_000)
    }
    timeout = window.setTimeout(refresh, 1_000)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [detail?.case.state, loadCase])

  useEffect(() => {
    const expiresAt = detail?.activeApproval?.expiresAt
    if (!expiresAt) return
    const remaining = Date.parse(expiresAt) - Date.now()
    if (remaining <= 0) {
      void loadCase(undefined, true)
      return
    }
    const timeout = window.setTimeout(
      () => void loadCase(undefined, true),
      Math.min(remaining + 50, 2_147_483_647),
    )
    return () => window.clearTimeout(timeout)
  }, [detail?.activeApproval?.expiresAt, loadCase])

  const formatter = useMemo(
    () => new Intl.DateTimeFormat(getResolvedLocale(), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    [i18n.resolvedLanguage],
  )

  const governedPath = (suffix: string) =>
    `/recovery/cases/${encodeURIComponent(detail?.case.id ?? '')}/${suffix}`

  const finishMutation = async (
    action: string,
    operation: () => Promise<unknown>,
    preferredCandidateKind?: RecoveryCandidateKind,
  ) => {
    setMutationError(null)
    setBusyAction(action)
    try {
      const result = await operation()
      await loadCase(preferredCandidateKind)
      return result
    } catch (error) {
      setMutationError(
        tApiError(error) || t('recoveryCenter.tile.semantic.resolveFailed'),
      )
      return null
    } finally {
      setBusyAction(null)
    }
  }

  const diagnoseCase = async () => {
    if (!detail) return
    await finishMutation('diagnose', () => contractApi(
      'POST /recovery/cases/{caseId}/diagnose',
      governedPath('diagnose'),
      { expectedRevision: detail.case.revision },
    ))
  }

  const proposeCandidates = async (includeReplacement: boolean) => {
    if (!detail) return
    const trimmedReason = reason.trim()
    let replacement: unknown
    if (includeReplacement) {
      if (!trimmedReason) {
        setMutationError(t('recoveryCenter.tile.semantic.reasonRequired'))
        return
      }
      try {
        replacement = JSON.parse(output)
      } catch {
        setMutationError(t('recoveryCenter.tile.semantic.invalidJson'))
        return
      }
    }
    const result = await finishMutation(
      'candidates',
      () => contractApi(
        'POST /recovery/cases/{caseId}/candidates',
        governedPath('candidates'),
        {
          expectedRevision: detail.case.revision,
          ...(includeReplacement
            ? { manualReplacement: { output: replacement, reason: trimmedReason } }
            : {}),
        },
      ),
      includeReplacement ? 'replace_output' : undefined,
    )
    if (result) setReason('')
  }

  const validateCandidate = async () => {
    if (!detail || !selectedCandidateId) return
    await finishMutation('validate', () => contractApi(
      'POST /recovery/cases/{caseId}/validate',
      governedPath('validate'),
      {
        expectedRevision: detail.case.revision,
        candidateArtifactId: selectedCandidateId,
      },
    ))
  }

  const recoveryCase = detail?.case ?? null
  const transitions = detail?.transitions ?? []
  const artifacts = detail?.artifacts ?? []
  const autonomy = detail?.autonomy ?? null
  const diagnoses = artifacts.filter(artifact => artifact.kind === 'diagnosis')
  const latestDiagnosis = diagnoses.at(-1)
  const latestDiagnosisPayload = diagnosisPayload(latestDiagnosis)
  const candidates = artifacts.filter(artifact => candidatePayload(artifact) !== null)
  const selectedCandidate = candidates.find(candidate => candidate.id === selectedCandidateId) ?? null
  const selectedPayload = selectedCandidate ? candidatePayload(selectedCandidate) : null
  const manualFollowUpTarget = selectedPayload?.decision === 'manual_follow_up'
    && selectedPayload.target?.workflowId
    && selectedPayload.target.workflowVersionId
    ? {
        workflowId: selectedPayload.target.workflowId,
        workflowVersionId: selectedPayload.target.workflowVersionId,
        detectorId: selectedPayload.target.detectorId,
      }
    : null
  const selectedValidation = detail?.artifacts
    .filter((artifact) => {
      const validation = validationPayload(artifact)
      if (!validation || !selectedCandidate) return false
      return validation.candidateArtifactId === selectedCandidate.id
        && validation.candidateSha256 === selectedCandidate.sha256
    })
    .at(-1) ?? null
  const selectedValidationPayload = validationPayload(selectedValidation)

  const openManualFollowUp = async (authoring: boolean) => {
    if (!manualFollowUpTarget || !selectedPayload || !onOpenWorkflowVersion) return
    setMutationError(null)
    setBusyAction(authoring ? 'author-successor' : 'inspect-source')
    try {
      const opened = await onOpenWorkflowVersion(
        manualFollowUpTarget.workflowId,
        manualFollowUpTarget.workflowVersionId,
        authoring ? 'ai-studio' : 'inspector',
      )
      if (!opened || !authoring || !onOpenAiAuthoring) return
      const prompt = t('recoveryCase.governed.successorPrompt', {
        workflowId: manualFollowUpTarget.workflowId,
        versionId: manualFollowUpTarget.workflowVersionId,
        caseId: recoveryCase?.id ?? '',
        candidate: t(`recoveryCase.governed.candidate.${selectedPayload.kind}`),
        reason: selectedPayload.reason,
        expectedResult: selectedPayload.expectedResult,
        detector: manualFollowUpTarget.detectorId ?? t('common.none'),
      })
      onOpenAiAuthoring([...prompt].slice(0, AUTHORING_PROMPT_MAX_RUNES).join(''))
    } finally {
      setBusyAction(null)
    }
  }

  const approveCandidate = async () => {
    if (!detail || !selectedCandidateId || !selectedValidation) return
    await finishMutation('approve', () => contractApi(
      'POST /recovery/cases/{caseId}/approve',
      governedPath('approve'),
      {
        expectedRevision: detail.case.revision,
        candidateArtifactId: selectedCandidateId,
        validationArtifactId: selectedValidation.id,
      },
    ))
  }

  const applyCandidate = async () => {
    if (!detail || !selectedCandidateId || !selectedValidation) return
    const response = await finishMutation('apply', () => contractApi(
      'POST /recovery/cases/{caseId}/apply',
      governedPath('apply'),
      {
        expectedRevision: detail.case.revision,
        candidateArtifactId: selectedCandidateId,
        validationArtifactId: selectedValidation.id,
      },
    ))
    if (!response) return
    const result = parseResolution(response)
    if (!result) {
      setMutationError(t('recoveryCase.invalidResponse'))
      return
    }
    const toastKey = selectedPayload?.kind === 'accept_loss'
      ? 'dlq.drill.outcome.evidence.explicit_resolution'
      : result.resumed
        ? 'recoveryCenter.tile.semantic.replaced'
        : 'recoveryCenter.tile.semantic.replacedPending'
    addToast(t(toastKey), 'success')
    await onResolved()
  }

  if (!caseId) {
    return (
      <PanelChrome
        title={t('recoveryCase.title')}
        description={t('recoveryCase.description')}
        icon={<ShieldAlert size={18} />}
      >
        <EmptyView
          icon={<CircleAlert size={20} />}
          title={t('recoveryCase.emptyTitle')}
          body={t('recoveryCase.emptyBody')}
          cta={{ label: t('recoveryCase.back'), onClick: onBack }}
        />
      </PanelChrome>
    )
  }

  const canReplace = Boolean(
    recoveryCase?.action === 'quarantine'
    && autonomy?.capabilities.applyWithApproval,
  )
  const canDiagnose = Boolean(
    canResolve && recoveryCase
    && (recoveryCase.state === 'detected' || recoveryCase.state === 'contained'),
  )
  const canPropose = Boolean(canResolve && recoveryCase?.state === 'diagnosed')
  const canValidate = Boolean(
    canResolve && recoveryCase?.state === 'candidates_ready' && selectedCandidate,
  )
  const canApprove = Boolean(
    canResolve && recoveryCase?.state === 'awaiting_approval'
    && selectedCandidate && selectedValidation && selectedValidationPayload?.passed
    && selectedValidationPayload.caseRevision === recoveryCase.revision - 2,
  )
  const activeApprovalMatchesSelection = Boolean(
    detail?.activeApproval
    && detail.activeApproval.candidateArtifactId === selectedCandidateId
    && detail.activeApproval.validationArtifactId === selectedValidation?.id
    && detail.activeApproval.caseRevision === recoveryCase?.revision
    && Date.parse(detail.activeApproval.expiresAt) > Date.now(),
  )
  const canApply = Boolean(
    canApprove && activeApprovalMatchesSelection,
  )
  const details = Array.isArray(recoveryCase?.detailsJson)
    ? recoveryCase.detailsJson
      .filter((item): item is string => typeof item === 'string')
      .slice(0, 5)
    : []

  return (
    <PanelChrome
      title={t('recoveryCase.title')}
      description={t('recoveryCase.description')}
      kicker={t('recoveryCase.kicker')}
      icon={<ShieldAlert size={18} />}
    >
      <Button
        className="we-recovery-case__back"
        onClick={onBack}
        size="sm"
        variant="ghost"
        leadingIcon={<ArrowLeft size={15} />}
      >
        {t('recoveryCase.back')}
      </Button>

      {loading && (
        <div className="we-card we-recovery-case__notice" role="status">
          <Clock3 size={17} aria-hidden="true" />
          <span>{t('recoveryCase.loading')}</span>
        </div>
      )}
      {loadError && (
        <div className="we-card we-recovery-case__notice" data-tone="danger" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          <span>{loadError}</span>
          <Button size="sm" variant="ghost" onClick={() => void loadCase()}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      {recoveryCase && (
        <div
          className="we-recovery-case"
          data-testid={`recovery-case-workspace-${recoveryCase.id}`}
        >
          <section className="we-card we-recovery-case__summary">
            <div className="we-recovery-case__summary-head">
              <div>
                <div className="section-kicker">{t('recoveryCase.summaryKicker')}</div>
                <h3>{recoveryCase.message}</h3>
              </div>
              <span
                className="we-pill"
                data-tone={recoveryCaseTone(recoveryCase.state, recoveryCase.action)}
              >
                {t(`recoveryCase.state.${recoveryCase.state}`)}
              </span>
            </div>
            <div className="we-recovery-case__meta">
              <div>
                <span>{t('recoveryCase.detector')}</span>
                <strong>{recoveryCase.detectorId}</strong>
              </div>
              <div>
                <span>{t('recoveryCase.sourceNode')}</span>
                <strong>{recoveryCase.sourceNodeId}</strong>
              </div>
              <div>
                <span>{t('recoveryCase.policy')}</span>
                <strong>{t(`recoveryCenter.tile.semantic.action.${recoveryCase.action}`)}</strong>
              </div>
              <div>
                <span>{t('recoveryCase.created')}</span>
                <strong>{formatter.format(new Date(recoveryCase.createdAt))}</strong>
              </div>
            </div>
            {details.length > 0 && (
              <div className="we-recovery-case__evidence">
                <span>{t('recoveryCase.evidence')}</span>
                <ul>
                  {details.map((item, index) => (
                    <li key={`${index}:${item}`}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<ExternalLink size={14} />}
              onClick={() => void onOpenRun(recoveryCase.runId)}
            >
              {t('recoveryCenter.tile.semantic.openRun')}
            </Button>
          </section>

          {autonomy && (
            <section
              className="we-card we-recovery-case__autonomy"
              data-level={autonomy.level ?? 'unavailable'}
              data-testid={`recovery-autonomy-profile-${recoveryCase.id}`}
              aria-labelledby="recovery-case-autonomy-title"
            >
              <div className="we-recovery-case__autonomy-head">
                <div className="we-recovery-case__section-head">
                  <Gauge size={17} aria-hidden="true" />
                  <div>
                    <div className="section-kicker">
                      {t('recoveryCase.autonomy.kicker')}
                    </div>
                    <h3 id="recovery-case-autonomy-title">
                      {t('recoveryCase.autonomy.title')}
                    </h3>
                  </div>
                </div>
                <span
                  className="we-pill"
                  data-tone={
                    autonomy.level === null
                      ? 'danger'
                      : autonomy.level >= 3
                        ? 'success'
                        : 'warning'
                  }
                >
                  {autonomy.level === null
                    ? t('recoveryCase.autonomy.unavailable')
                    : t('recoveryCase.autonomy.level', {
                        level: autonomy.level,
                      })}
                </span>
              </div>
              <p className="helper-text">
                {autonomy.level === null
                  ? t(
                      `recoveryCase.autonomy.reason.${autonomy.unavailableReason ?? 'failure_policy_missing'}`,
                    )
                  : t(`recoveryCase.autonomy.description.${autonomy.level}`)}
              </p>
              <div className="we-recovery-case__autonomy-meta">
                <span>
                  {t('recoveryCase.autonomy.source')}
                  <strong>
                    {t(`recoveryCase.autonomy.source.${autonomy.source}`)}
                  </strong>
                </span>
                <span>
                  {t('recoveryCase.autonomy.detectors')}
                  <strong>{autonomy.detectorIds.length}</strong>
                </span>
              </div>
              <ol className="we-recovery-case__autonomy-ladder">
                {autonomy.factors.map(factor => (
                  <li
                    key={factor.capability}
                    data-enabled={factor.enabled}
                  >
                    <span className="we-recovery-case__autonomy-level">
                      {factor.requiredLevel}
                    </span>
                    <span>
                      <strong>
                        {t(
                          `recoveryCase.autonomy.capability.${factor.capability}`,
                        )}
                      </strong>
                      <small>
                        {t(
                          factor.enabled
                            ? 'recoveryCase.autonomy.enabled'
                            : 'recoveryCase.autonomy.disabled',
                        )}
                      </small>
                    </span>
                    {factor.enabled
                      ? <ShieldCheck size={15} aria-hidden="true" />
                      : <LockKeyhole size={15} aria-hidden="true" />}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <div className="we-recovery-case__columns">
            <section className="we-card we-recovery-case__history" aria-labelledby="recovery-case-history-title">
              <div className="we-recovery-case__section-head">
                <History size={17} aria-hidden="true" />
                <div>
                  <div className="section-kicker">{t('recoveryCase.historyKicker')}</div>
                  <h3 id="recovery-case-history-title">{t('recoveryCase.historyTitle')}</h3>
                </div>
              </div>
              {transitions.length === 0 ? (
                <p className="helper-text">{t('recoveryCase.historyEmpty')}</p>
              ) : (
                <ol className="we-recovery-case__timeline">
                  {transitions.map(transition => (
                    <li key={transition.id}>
                      <span className="we-recovery-case__timeline-dot" aria-hidden="true" />
                      <div>
                        <strong>
                          {t(`recoveryCase.state.${transition.fromState}`)}
                          <ArrowRight size={13} aria-hidden="true" />
                          {t(`recoveryCase.state.${transition.toState}`)}
                        </strong>
                        <span>
                          {t(`recoveryCase.actor.${transition.actorKind}`)}
                          {transition.actorId ? ` · ${transition.actorId}` : ''}
                          {' · '}
                          {formatter.format(new Date(transition.occurredAt))}
                        </span>
                        {transition.reason && <p>{transition.reason}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="we-card we-recovery-case__decision" aria-labelledby="recovery-case-decision-title">
              <div className="section-kicker">{t('recoveryCase.decisionKicker')}</div>
              <h3 id="recovery-case-decision-title">{t('recoveryCase.governed.title')}</h3>
              <p className="helper-text">
                {canResolve
                  ? t('recoveryCase.governed.description')
                  : t('recoveryCase.decisionReadOnly')}
              </p>

              <ol className="we-recovery-case__steps" aria-label={t('recoveryCase.governed.progress')}>
                {[
                  ['diagnosis', diagnoses.length > 0],
                  ['candidates', candidates.length > 0],
                  ['validation', Boolean(selectedValidation)],
                  ['approval', activeApprovalMatchesSelection],
                  ['verification', ['verified_recovered', 'accepted_loss'].includes(recoveryCase.state)],
                ].map(([step, complete], index) => (
                  <li key={String(step)} data-complete={complete} data-current={!complete && index === [
                    diagnoses.length > 0,
                    candidates.length > 0,
                    Boolean(selectedValidation),
                    activeApprovalMatchesSelection,
                    ['verified_recovered', 'accepted_loss'].includes(recoveryCase.state),
                  ].findIndex(value => !value)}>
                    <span>{complete ? <ShieldCheck size={14} /> : index + 1}</span>
                    {t(`recoveryCase.governed.step.${step}`)}
                  </li>
                ))}
              </ol>

              {latestDiagnosisPayload && (
                <div className="we-recovery-case__diagnosis" data-testid={`recovery-diagnosis-${recoveryCase.id}`}>
                  <div className="we-recovery-case__diagnosis-head">
                    <strong>{latestDiagnosisPayload.summary}</strong>
                    <span
                      className="we-pill"
                      data-tone={latestDiagnosisPayload.mode === 'ai_enriched' ? 'success' : 'neutral'}
                    >
                      {t(`recoveryCase.governed.mode.${latestDiagnosisPayload.mode}`)}
                    </span>
                  </div>
                  <p>{t(`recoveryCase.governed.modeHelp.${latestDiagnosisPayload.mode}`)}</p>
                  <div className="we-recovery-case__hypotheses">
                    {latestDiagnosisPayload.hypotheses.map((hypothesis, index) => (
                      <article key={hypothesis.id}>
                        <div className="we-recovery-case__hypothesis-head">
                          <span>
                            {t('recoveryCase.governed.hypothesisNumber', {
                              number: index + 1,
                            })}
                          </span>
                          {hypothesis.confidence !== null && (
                            <span>
                              {t('recoveryCase.governed.confidence', {
                                percent: Math.round(hypothesis.confidence * 100),
                              })}
                            </span>
                          )}
                        </div>
                        <strong>{hypothesis.cause}</strong>
                        <div className="we-recovery-case__hypothesis-evidence">
                          <div>
                            <span>{t('recoveryCase.governed.supportingEvidence')}</span>
                            {hypothesis.evidence.length > 0
                              ? (
                                  <ul>
                                    {hypothesis.evidence.map((statement, statementIndex) => (
                                      <li key={`${hypothesis.id}:evidence:${statementIndex}`}>
                                        {statement}
                                      </li>
                                    ))}
                                  </ul>
                                )
                              : <small>{t('recoveryCase.governed.evidenceUnavailable')}</small>}
                          </div>
                          <div>
                            <span>{t('recoveryCase.governed.counterEvidence')}</span>
                            {hypothesis.counterEvidence.length > 0
                              ? (
                                  <ul>
                                    {hypothesis.counterEvidence.map((statement, statementIndex) => (
                                      <li key={`${hypothesis.id}:counter:${statementIndex}`}>
                                        {statement}
                                      </li>
                                    ))}
                                  </ul>
                                )
                              : <small>{t('recoveryCase.governed.counterEvidenceUnavailable')}</small>}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}

              {candidates.length > 0 && (
                <div
                  className="we-recovery-case__candidates"
                  role="radiogroup"
                  aria-label={t('recoveryCase.governed.candidates')}
                >
                  {candidates.map(candidate => {
                    const payload = candidatePayload(candidate)
                    if (!payload) return null
                    const selected = candidate.id === selectedCandidateId
                    const candidateLabel = t(`recoveryCase.governed.candidate.${payload.kind}`)
                    const candidateFactsId = `recovery-candidate-facts-${candidate.id}`
                    return (
                      <label key={candidate.id} className="we-recovery-case__candidate" data-selected={selected}>
                        <input
                          type="radio"
                          name={`recovery-candidate-${recoveryCase.id}`}
                          value={candidate.id}
                          checked={selected}
                          aria-label={candidateLabel}
                          aria-describedby={candidateFactsId}
                          onChange={() => {
                            setSelectedCandidateId(candidate.id)
                          }}
                        />
                        <span>
                          <strong>{candidateLabel}</strong>
                          <small>{payload.reason}</small>
                          {payload.decision === 'manual_follow_up' && (
                            <small>{t('recoveryCase.governed.authoringRequired')}</small>
                          )}
                          <span
                            id={candidateFactsId}
                            className="we-recovery-case__candidate-facts"
                          >
                            <small>
                              <b>{t('aiStudio.brief.outcome')}</b>
                              {payload.expectedResult}
                            </small>
                            <small>
                              <b>{t('recoveryDialog.passport.evidence')}</b>
                              {payload.evidence.slice(0, 2).map(reference => (
                                `${reference.kind}: ${reference.id}`
                              )).join(' · ')}
                              {payload.evidence.length > 2 && ` (${t(
                                'dlq.bulkErrorsMore',
                                { count: payload.evidence.length - 2 },
                              )})`}
                            </small>
                            <small>
                              <b>
                                {t('permissions.add.permissions')} ({t('permissions.required')})
                              </b>
                              <code>{payload.requiredPermissions.join(', ')}</code>
                            </small>
                          </span>
                        </span>
                        <span className="we-pill" data-tone={payload.kind === 'accept_loss' ? 'warning' : 'neutral'}>
                          {t(`recoveryCase.governed.risk.${payload.risk}`)}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}

              {manualFollowUpTarget && onOpenWorkflowVersion
                && (canInspectWorkflow || (canAuthorWorkflow && onOpenAiAuthoring)) && (
                <div
                  className="we-recovery-case__authoring-handoff"
                  role="group"
                  aria-label={t('versionHistory.suggest')}
                >
                  <div>
                    <WandSparkles size={17} aria-hidden="true" />
                    <span>
                      <strong>{t('versionHistory.suggest')}</strong>
                      <small>{t('aiStudio.apply.body')}</small>
                    </span>
                  </div>
                  <FormActions>
                    {canInspectWorkflow && (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busyAction === 'inspect-source'}
                        onClick={() => void openManualFollowUp(false)}
                        data-testid={`semantic-recovery-inspect-source-${recoveryCase.id}`}
                      >
                        {t('palette.dynamic.openWorkflow')}
                      </Button>
                    )}
                    {canAuthorWorkflow && onOpenAiAuthoring && (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={busyAction === 'author-successor'}
                        leadingIcon={<WandSparkles size={14} />}
                        onClick={() => void openManualFollowUp(true)}
                        data-testid={`semantic-recovery-author-successor-${recoveryCase.id}`}
                      >
                        {t('versionHistory.suggest')}
                      </Button>
                    )}
                  </FormActions>
                </div>
              )}

              {selectedValidationPayload && (
                <div
                  className="we-recovery-case__validation"
                  data-tone={selectedValidationPayload.passed ? 'success' : 'warning'}
                  role="status"
                >
                  {selectedValidationPayload.passed ? <ShieldCheck size={17} /> : <CircleAlert size={17} />}
                  <span>
                    <strong>{t(
                      selectedValidationPayload.passed
                        ? 'recoveryCase.governed.validationPassed'
                        : 'recoveryCase.governed.validationBlocked',
                    )}</strong>
                    <small>{selectedValidationPayload.summary}</small>
                  </span>
                </div>
              )}

              {mutationError && <p className="ui-field__error" role="alert">{mutationError}</p>}

              {canResolve
                && recoveryCase.action === 'quarantine'
                && !canReplace
                && !['verified_recovered', 'accepted_loss', 'abandoned'].includes(recoveryCase.state) && (
                <div className="we-recovery-case__readonly" role="note">
                  <LockKeyhole size={16} aria-hidden="true" />
                  {t('recoveryCase.decisionPolicyBlocked')}
                </div>
              )}

              {canDiagnose && (
                <Button
                  variant="primary"
                  loading={busyAction === 'diagnose'}
                  loadingLabel={t('recoveryCase.governed.diagnosing')}
                  onClick={() => void diagnoseCase()}
                  data-testid={`semantic-recovery-diagnose-${recoveryCase.id}`}
                >
                  {t('recoveryCase.governed.diagnose')}
                </Button>
              )}

              {canPropose && (
                <div className="we-recovery-case__form">
                  {canReplace && (
                    <FormDisclosure summary={t('recoveryCase.governed.manualOption')}>
                      <FormField
                        label={t('recoveryCenter.tile.semantic.output')}
                        hint={t('recoveryCase.governed.outputHint')}
                      >
                        {controlProps => (
                          <textarea
                            {...controlProps}
                            className="we-recovery-case__output"
                            value={output}
                            onChange={event => setOutput(event.target.value)}
                            rows={8}
                            spellCheck={false}
                            data-testid={`semantic-recovery-output-${recoveryCase.id}`}
                          />
                        )}
                      </FormField>
                      <FormField
                        label={t('recoveryCenter.tile.semantic.reason')}
                        required
                      >
                        {controlProps => (
                          <textarea
                            {...controlProps}
                            value={reason}
                            onChange={event => setReason(event.target.value)}
                            rows={3}
                            maxLength={1000}
                            data-testid={`semantic-recovery-reason-${recoveryCase.id}`}
                          />
                        )}
                      </FormField>
                    </FormDisclosure>
                  )}
                  <FormActions>
                    {canReplace && (
                      <Button
                        variant="primary"
                        loading={busyAction === 'candidates'}
                        onClick={() => void proposeCandidates(true)}
                        data-testid={`semantic-recovery-propose-${recoveryCase.id}`}
                      >
                        {t('recoveryCase.governed.proposeReplacement')}
                      </Button>
                    )}
                    <Button
                      variant={canReplace ? 'secondary' : 'primary'}
                      loading={busyAction === 'candidates'}
                      onClick={() => void proposeCandidates(false)}
                      data-testid={`semantic-recovery-accept-${recoveryCase.id}`}
                    >
                      {t('recoveryCase.governed.proposeSafeAlternative')}
                    </Button>
                  </FormActions>
                </div>
              )}

              {canValidate && (
                <Button
                  variant="primary"
                  loading={busyAction === 'validate'}
                  onClick={() => void validateCandidate()}
                  data-testid={`semantic-recovery-validate-${recoveryCase.id}`}
                >
                  {t('recoveryCase.governed.validate')}
                </Button>
              )}

              {canApprove && !canApply && (
                <Button
                  variant="primary"
                  loading={busyAction === 'approve'}
                  leadingIcon={<LockKeyhole size={15} />}
                  onClick={() => void approveCandidate()}
                  data-testid={`semantic-recovery-approve-${recoveryCase.id}`}
                >
                  {t('recoveryCase.governed.approve')}
                </Button>
              )}

              {canApply && (
                <div className="we-recovery-case__approval-ready" role="status">
                  <ShieldCheck size={17} aria-hidden="true" />
                  <span>{t('recoveryCase.governed.approvalReady')}</span>
                  <Button
                    variant="primary"
                    loading={busyAction === 'apply'}
                    onClick={() => void applyCandidate()}
                    data-testid={`semantic-recovery-apply-${recoveryCase.id}`}
                  >
                    {t(
                      selectedPayload?.kind === 'accept_loss'
                        ? 'recoveryCase.governed.applyLoss'
                        : 'recoveryCase.governed.apply',
                    )}
                  </Button>
                </div>
              )}

              {!canResolve && (
                <div className="we-recovery-case__readonly" role="note">
                  <LockKeyhole size={16} aria-hidden="true" />
                  {t('recoveryCase.decisionReadOnly')}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </PanelChrome>
  )
}
