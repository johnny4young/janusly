import { CircleAlert, LockKeyhole, ShieldCheck, WandSparkles } from 'lucide-react'
import { candidatePayload } from '@/lib/recovery-case-contract'
import { useT } from '../../i18n'
import { Button } from '../ui/Button'
import { FormActions, FormDisclosure, FormField } from '../ui/Form'
import type { RecoveryCaseModel } from './useRecoveryCaseController'

// The governed decision ladder: progress, diagnosis, candidates, manual
// follow-up, validation and the action for the current step.
export function RecoveryCaseDecision({ model }: { model: RecoveryCaseModel }) {
  const { t } = useT()
  const {
    canResolve,
    canInspectWorkflow,
    canAuthorWorkflow,
    onOpenWorkflowVersion,
    onOpenAiAuthoring,
    output,
    setOutput,
    reason,
    setReason,
    mutationError,
    busyAction,
    selectedCandidateId,
    setSelectedCandidateId,
    diagnoseCase,
    proposeCandidates,
    validateCandidate,
    openManualFollowUp,
    approveCandidate,
    applyCandidate,
    recoveryCase,
    diagnoses,
    latestDiagnosisPayload,
    candidates,
    selectedPayload,
    manualFollowUpTarget,
    selectedValidation,
    selectedValidationPayload,
    canReplace,
    canDiagnose,
    canPropose,
    canValidate,
    canApprove,
    activeApprovalMatchesSelection,
    canApply,
  } = model
  if (!recoveryCase) return null
  return (
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
  )
}
