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
} from 'lucide-react'
import { V1_READ_PATHS } from '@janusly/shared/src/api-contract'
import {
  RECOVERY_AUTONOMY_CAPABILITIES,
  type RecoveryAutonomyCapability,
  type RecoveryAutonomyLevel,
  type RecoveryAutonomyProfile,
} from '@janusly/shared/src/recovery-autonomy'

import { api } from '../api'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import type {
  RecoveryCase,
  RecoveryCaseTransition,
  SemanticCaseResolution,
} from '../types'
import { EmptyView, PanelChrome } from './panel-primitives'

type RecoveryCaseDetail = {
  case: RecoveryCase
  transitions: RecoveryCaseTransition[]
  autonomy: RecoveryAutonomyProfile
}

const RECOVERY_CASE_STATES = new Set<RecoveryCase['state']>([
  'detected',
  'contained',
  'diagnosed',
  'candidates_ready',
  'validating',
  'awaiting_approval',
  'publishing',
  'monitoring',
  'verified_recovered',
  'recurred',
  'accepted_loss',
  'abandoned',
])
const RECOVERY_AUTONOMY_CAPABILITY_SET =
  new Set<RecoveryAutonomyCapability>(RECOVERY_AUTONOMY_CAPABILITIES)
const RECOVERY_AUTONOMY_SOURCES = new Set<RecoveryAutonomyProfile['source']>([
  'failure_override',
  'workflow_default',
  'strictest_failure',
  'unavailable',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecoveryCaseState(value: unknown): value is RecoveryCase['state'] {
  return typeof value === 'string'
    && RECOVERY_CASE_STATES.has(value as RecoveryCase['state'])
}

function isRecoveryCaseActorKind(
  value: unknown,
): value is RecoveryCaseTransition['actorKind'] {
  return value === 'system' || value === 'user' || value === 'agent'
}

function parseRecoveryCase(value: unknown): RecoveryCase | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string'
    || typeof value.orgId !== 'string'
    || typeof value.runId !== 'string'
    || !(value.workflowId === null || typeof value.workflowId === 'string')
    || typeof value.workflowVersionId !== 'string'
    || value.source !== 'semantic_violation'
    || typeof value.detectorId !== 'string'
    || typeof value.sourceNodeId !== 'string'
    || (value.detectorKind !== 'expression' && value.detectorKind !== 'schema')
    || (value.action !== 'observe' && value.action !== 'quarantine')
    || typeof value.message !== 'string'
    || !isRecoveryCaseState(value.state)
    || !(value.createdBy === null || typeof value.createdBy === 'string')
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || !(value.resolvedAt === null || typeof value.resolvedAt === 'string')
  ) return null
  return value as RecoveryCase
}

function parseRecoveryCaseTransition(
  value: unknown,
): RecoveryCaseTransition | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string'
    || typeof value.orgId !== 'string'
    || typeof value.caseId !== 'string'
    || !isRecoveryCaseState(value.fromState)
    || !isRecoveryCaseState(value.toState)
    || !isRecoveryCaseActorKind(value.actorKind)
    || !(value.actorId === null || typeof value.actorId === 'string')
    || !('evidenceJson' in value)
    || !(value.reason === null || typeof value.reason === 'string')
    || typeof value.occurredAt !== 'string'
  ) return null
  return value as RecoveryCaseTransition
}

function isRecoveryAutonomyLevel(
  value: unknown,
): value is RecoveryAutonomyLevel {
  return Number.isInteger(value)
    && typeof value === 'number'
    && value >= 0
    && value <= 4
}

function parseRecoveryAutonomyProfile(
  value: unknown,
): RecoveryAutonomyProfile | null {
  if (!isRecord(value) || !isRecord(value.capabilities)) return null
  if (
    !(value.level === null || isRecoveryAutonomyLevel(value.level))
    || typeof value.source !== 'string'
    || !RECOVERY_AUTONOMY_SOURCES.has(
      value.source as RecoveryAutonomyProfile['source'],
    )
    || !Array.isArray(value.detectorIds)
    || !value.detectorIds.every(id => typeof id === 'string')
    || !(
      value.unavailableReason === null
      || value.unavailableReason === 'contract_missing'
      || value.unavailableReason === 'failure_policy_missing'
    )
    || typeof value.capabilities.observe !== 'boolean'
    || typeof value.capabilities.recommend !== 'boolean'
    || typeof value.capabilities.validate !== 'boolean'
    || typeof value.capabilities.applyWithApproval !== 'boolean'
    || typeof value.capabilities.autonomousApply !== 'boolean'
    || !Array.isArray(value.factors)
  ) return null
  const factors = value.factors.map((factor) => {
    if (
      !isRecord(factor)
      || typeof factor.capability !== 'string'
      || !RECOVERY_AUTONOMY_CAPABILITY_SET.has(
        factor.capability as RecoveryAutonomyCapability,
      )
      || !isRecoveryAutonomyLevel(factor.requiredLevel)
      || typeof factor.enabled !== 'boolean'
    ) return null
    return {
      capability: factor.capability as RecoveryAutonomyCapability,
      requiredLevel: factor.requiredLevel,
      enabled: factor.enabled,
    }
  })
  if (
    factors.some(factor => factor === null)
    || factors.length !== RECOVERY_AUTONOMY_CAPABILITY_SET.size
    || new Set(factors.map(factor => factor?.capability)).size
      !== RECOVERY_AUTONOMY_CAPABILITY_SET.size
  ) return null
  return {
    level: value.level,
    source: value.source as RecoveryAutonomyProfile['source'],
    detectorIds: value.detectorIds,
    unavailableReason: value.unavailableReason,
    capabilities: {
      observe: value.capabilities.observe,
      recommend: value.capabilities.recommend,
      validate: value.capabilities.validate,
      applyWithApproval: value.capabilities.applyWithApproval,
      autonomousApply: value.capabilities.autonomousApply,
    },
    factors: factors as RecoveryAutonomyProfile['factors'],
  }
}

function parseRecoveryCaseDetail(value: unknown): RecoveryCaseDetail | null {
  if (!isRecord(value)) return null
  const recoveryCase = parseRecoveryCase(value.case)
  const autonomy = parseRecoveryAutonomyProfile(value.autonomy)
  if (
    !recoveryCase
    || !autonomy
    || !Array.isArray(value.transitions)
  ) return null
  const transitions = value.transitions
    .map(parseRecoveryCaseTransition)
    .filter((item): item is RecoveryCaseTransition => item !== null)
  if (transitions.length !== value.transitions.length) return null
  return { case: recoveryCase, transitions, autonomy }
}

function parseResolution(value: unknown): SemanticCaseResolution | null {
  if (!isRecord(value)) return null
  if (
    typeof value.runId !== 'string'
    || typeof value.sourceNodeId !== 'string'
    || typeof value.resumed !== 'boolean'
    || !Array.isArray(value.resolvedCaseIds)
    || !value.resolvedCaseIds.every(id => typeof id === 'string')
  ) return null
  return {
    runId: value.runId,
    sourceNodeId: value.sourceNodeId,
    resumed: value.resumed,
    resolvedCaseIds: value.resolvedCaseIds,
  }
}

export function RecoveryCasePanel({
  caseId,
  canResolve,
  onBack,
  onOpenRun,
  onResolved,
}: {
  caseId: string | null
  canResolve: boolean
  onBack: () => void
  onOpenRun: (runId: string) => void | Promise<void>
  onResolved: () => void | Promise<void>
}) {
  const { t, i18n } = useT()
  const addToast = useWorkflowStore(state => state.addToast)
  const [detail, setDetail] = useState<RecoveryCaseDetail | null>(null)
  const [loading, setLoading] = useState(Boolean(caseId))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [output, setOutput] = useState('{\n  "mode": "ai"\n}')
  const [reason, setReason] = useState('')
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  const loadCase = useCallback(async () => {
    if (!caseId) {
      setDetail(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
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
    } catch (error) {
      setDetail(null)
      setLoadError(tApiError(error) || t('recoveryCase.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [caseId, t])

  useEffect(() => {
    void loadCase()
  }, [loadCase])

  const formatter = useMemo(
    () => new Intl.DateTimeFormat(getResolvedLocale(), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    [i18n.resolvedLanguage],
  )

  const resolveCase = async (decision: 'replace' | 'accept_loss') => {
    if (!detail) return
    setResolveError(null)
    const trimmedReason = reason.trim()
    if (!trimmedReason) {
      setResolveError(t('recoveryCenter.tile.semantic.reasonRequired'))
      return
    }
    let replacement: unknown
    if (decision === 'replace') {
      try {
        replacement = JSON.parse(output)
      } catch {
        setResolveError(t('recoveryCenter.tile.semantic.invalidJson'))
        return
      }
    }

    setResolving(true)
    try {
      const response = await api(
        `/recovery/cases/${encodeURIComponent(detail.case.id)}/resolve`,
        {
          method: 'POST',
          body: JSON.stringify({
            decision,
            reason: trimmedReason,
            ...(decision === 'replace' ? { output: replacement } : {}),
          }),
        },
      )
      const result = parseResolution(response)
      if (!result) throw new Error(t('recoveryCase.invalidResponse'))
      addToast(
        t(
          detail.case.action === 'observe'
            ? 'recoveryCenter.tile.semantic.observed'
            : decision === 'replace'
              ? result.resumed
                ? 'recoveryCenter.tile.semantic.replaced'
                : 'recoveryCenter.tile.semantic.replacedPending'
              : result.resumed
                ? 'recoveryCenter.tile.semantic.accepted'
                : 'recoveryCenter.tile.semantic.acceptedPending',
        ),
        'success',
      )
      setReason('')
      await Promise.all([loadCase(), onResolved()])
    } catch (error) {
      setResolveError(
        tApiError(error) || t('recoveryCenter.tile.semantic.resolveFailed'),
      )
    } finally {
      setResolving(false)
    }
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

  const recoveryCase = detail?.case ?? null
  const transitions = detail?.transitions ?? []
  const autonomy = detail?.autonomy ?? null
  const canAcknowledge = Boolean(
    canResolve
    && recoveryCase
    && (
      (recoveryCase.action === 'quarantine' && recoveryCase.state === 'contained')
      || (recoveryCase.action === 'observe' && recoveryCase.state === 'detected')
    ),
  )
  const canReplace = Boolean(
    canAcknowledge
    && recoveryCase?.action === 'quarantine'
    && autonomy?.capabilities.applyWithApproval,
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
      <button
        type="button"
        className="we-recovery-case__back"
        onClick={onBack}
      >
        <ArrowLeft size={15} aria-hidden="true" />
        {t('recoveryCase.back')}
      </button>

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
          <button type="button" className="small-command" onClick={() => void loadCase()}>
            {t('common.retry')}
          </button>
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
                data-tone={
                  recoveryCase.state === 'verified_recovered'
                  || recoveryCase.state === 'accepted_loss'
                    ? 'success'
                    : recoveryCase.action === 'quarantine'
                      ? 'danger'
                      : 'warning'
                }
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
            <button
              type="button"
              className="small-command"
              onClick={() => void onOpenRun(recoveryCase.runId)}
            >
              <ExternalLink size={14} aria-hidden="true" />
              {t('recoveryCenter.tile.semantic.openRun')}
            </button>
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
              <h3 id="recovery-case-decision-title">{t('recoveryCase.decisionTitle')}</h3>
              <p className="helper-text">
                {canAcknowledge
                  ? t(
                      recoveryCase.action === 'quarantine'
                        ? canReplace
                          ? 'recoveryCase.decisionQuarantine'
                          : 'recoveryCase.decisionPolicyBlocked'
                        : 'recoveryCase.decisionObserve',
                    )
                  : t(
                      canResolve
                        ? 'recoveryCase.decisionUnavailable'
                        : 'recoveryCase.decisionReadOnly',
                    )}
              </p>
              {canAcknowledge && (
                <div className="we-recovery-case__form">
                  {canReplace && (
                    <label className="we-field">
                      <span>{t('recoveryCenter.tile.semantic.output')}</span>
                      <textarea
                        className="text-field we-recovery-case__output"
                        value={output}
                        onChange={event => setOutput(event.target.value)}
                        rows={8}
                        spellCheck={false}
                        data-testid={`semantic-recovery-output-${recoveryCase.id}`}
                      />
                    </label>
                  )}
                  <label className="we-field">
                    <span>{t('recoveryCenter.tile.semantic.reason')}</span>
                    <textarea
                      className="text-field"
                      value={reason}
                      onChange={event => setReason(event.target.value)}
                      rows={3}
                      maxLength={1000}
                      data-testid={`semantic-recovery-reason-${recoveryCase.id}`}
                    />
                  </label>
                  {resolveError && <p className="field-error" role="alert">{resolveError}</p>}
                  <div className="we-recovery-case__decision-actions">
                    {canReplace && (
                      <button
                        type="button"
                        className="command-button command-button-primary"
                        disabled={resolving}
                        onClick={() => void resolveCase('replace')}
                        data-testid={`semantic-recovery-replace-${recoveryCase.id}`}
                      >
                        {resolving
                          ? t('recoveryCenter.tile.semantic.resolving')
                          : t('recoveryCenter.tile.semantic.replace')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={recoveryCase.action === 'observe'
                        ? 'command-button command-button-primary'
                        : 'command-button'}
                      disabled={resolving}
                      onClick={() => void resolveCase('accept_loss')}
                      data-testid={`semantic-recovery-accept-${recoveryCase.id}`}
                    >
                      {t(
                        recoveryCase.action === 'observe'
                          ? 'recoveryCenter.tile.semantic.acknowledge'
                          : 'recoveryCenter.tile.semantic.acceptLoss',
                      )}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </PanelChrome>
  )
}
