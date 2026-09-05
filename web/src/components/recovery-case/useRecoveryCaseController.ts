// The recovery case state machine: load and refresh the governed case,
// the diagnose → candidates → validate → approve → apply ladder, and the
// derived facts each step needs. The panel and its sections only render
// the returned model.
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { api, contractApi } from '../../api'
import { getResolvedLocale, tApiError, useT } from '../../i18n'
import { useWorkflowStore } from '../../store'

const AUTHORING_PROMPT_MAX_RUNES = 4000

export type RecoveryCasePanelProps = {
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
}

export type RecoveryCaseModel = ReturnType<typeof useRecoveryCaseController>

export function useRecoveryCaseController({
  caseId,
  canResolve,
  canInspectWorkflow = false,
  canAuthorWorkflow = false,
  onBack,
  onOpenRun,
  onOpenWorkflowVersion,
  onOpenAiAuthoring,
  onResolved,
}: RecoveryCasePanelProps) {
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

  return {
    caseId,
    canResolve,
    canInspectWorkflow,
    canAuthorWorkflow,
    onBack,
    onOpenRun,
    onOpenWorkflowVersion,
    onOpenAiAuthoring,
    detail,
    loading,
    loadError,
    loadCase,
    output,
    setOutput,
    reason,
    setReason,
    mutationError,
    busyAction,
    selectedCandidateId,
    setSelectedCandidateId,
    formatter,
    diagnoseCase,
    proposeCandidates,
    validateCandidate,
    openManualFollowUp,
    approveCandidate,
    applyCandidate,
    recoveryCase,
    transitions,
    autonomy,
    diagnoses,
    latestDiagnosisPayload,
    candidates,
    selectedCandidate,
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
    details,
  }
}
