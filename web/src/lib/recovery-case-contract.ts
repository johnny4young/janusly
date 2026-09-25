/**
 * Browser-side semantic recovery read contract.
 *
 * The generated guard owns the case envelope's shape; this module keeps the
 * invariants the governed-recovery panel depends on: vocabulary it translates,
 * row identity, candidate and validation hashes, and the approval binding.
 * Artifact payloads are opaque in the manifest, so their structure is narrowed
 * here only as far as the panel renders it. Size and count caps are server policy.
 */

import {
  RECOVERY_AUTONOMY_CAPABILITIES,
  RECOVERY_AUTONOMY_CAPABILITY_LEVEL,
  type RecoveryAutonomyCapability,
  type RecoveryAutonomyProfile,
} from './recovery-autonomy'
import type {
  RecoveryCase,
  RecoveryCaseArtifact,
  RecoveryCaseTransition,
  SemanticCaseResolution,
} from '../types'
import type { ApiResponses } from './api-types.generated'
import { hasOnlyKeys, isRecord } from './guards'
import { isGetRecoveryCasesCaseIdResponse } from './api-guards/operations/GetRecoveryCasesCaseId'
import { isPostRecoveryCasesCaseIdApplyResponse } from './api-guards/operations/PostRecoveryCasesCaseIdApply'

export type RecoveryCaseDetail = {
  case: RecoveryCase
  transitions: RecoveryCaseTransition[]
  artifacts: RecoveryCaseArtifact[]
  autonomy: RecoveryAutonomyProfile
  activeApproval: RecoveryActiveApproval | null
}

export type RecoveryActiveApproval = {
  candidateArtifactId: string
  validationArtifactId: string
  caseRevision: number
  expiresAt: string
}

type WireDetail = ApiResponses['GET /recovery/cases/{caseId}']

// The panel translates these values into state pills, actor labels and step copy.
const CASE_STATES: ReadonlySet<string> = new Set<RecoveryCase['state']>([
  'detected', 'contained', 'diagnosed', 'candidates_ready', 'validating', 'awaiting_approval',
  'publishing', 'monitoring', 'verified_recovered', 'recurred', 'accepted_loss', 'abandoned',
])
const CASE_ACTIONS: ReadonlySet<string> = new Set<RecoveryCase['action']>(['observe', 'quarantine'])
const ACTOR_KINDS: ReadonlySet<string> = new Set<RecoveryCaseTransition['actorKind']>(['system', 'user', 'agent'])
const ARTIFACT_KINDS: ReadonlySet<string> = new Set<RecoveryCaseArtifact['kind']>([
  'diagnosis', 'candidate', 'validation', 'publication', 'verification',
])
const AUTONOMY_SOURCES: ReadonlySet<string> = new Set<RecoveryAutonomyProfile['source']>([
  'failure_override', 'workflow_default', 'strictest_failure', 'unavailable',
])
// RecoveryCasePanel formats these with Intl, which throws on an unparseable date.
const isDate = (value: string) => Number.isFinite(Date.parse(value))
const UNAVAILABLE_REASONS: ReadonlySet<unknown> = new Set([null, 'contract_missing', 'failure_policy_missing'])
const AUTONOMY_LEVELS: ReadonlySet<unknown> = new Set(Object.values(RECOVERY_AUTONOMY_CAPABILITY_LEVEL))
const CAPABILITIES: ReadonlySet<string> = new Set<RecoveryAutonomyCapability>(RECOVERY_AUTONOMY_CAPABILITIES)

// Approval binds a candidate to its validation by content hash, so both must be comparable digests.
const SHA256 = /^[a-f0-9]{64}$/

function isAutonomyProfile(value: WireDetail['autonomy']): boolean {
  // The autonomy card explains every capability exactly once, at a level it has copy for.
  return (value.level === null || AUTONOMY_LEVELS.has(value.level))
    && AUTONOMY_SOURCES.has(value.source)
    && UNAVAILABLE_REASONS.has(value.unavailableReason)
    && value.factors.length === CAPABILITIES.size
    && new Set(value.factors.map(factor => factor.capability)).size === CAPABILITIES.size
    && value.factors.every(factor => CAPABILITIES.has(factor.capability) && AUTONOMY_LEVELS.has(factor.requiredLevel))
}

export function parseRecoveryCaseDetail(value: unknown): RecoveryCaseDetail | null {
  if (!isGetRecoveryCasesCaseIdResponse(value)) return null
  const { case: wireCase, transitions, artifacts, autonomy } = value
  if (!CASE_STATES.has(wireCase.state) || !CASE_ACTIONS.has(wireCase.action) || !isDate(wireCase.createdAt)
    || !isAutonomyProfile(autonomy)) return null
  // Transitions and artifacts are receipts for this case only.
  if (transitions.some(transition => (
    transition.orgId !== wireCase.orgId || transition.caseId !== wireCase.id
    || !CASE_STATES.has(transition.fromState) || !CASE_STATES.has(transition.toState)
    || !ACTOR_KINDS.has(transition.actorKind) || !isDate(transition.occurredAt)
  ))) return null
  if (artifacts.some(artifact => (
    artifact.caseId !== wireCase.id || !ARTIFACT_KINDS.has(artifact.kind)
    || !ACTOR_KINDS.has(artifact.actorKind) || !SHA256.test(artifact.sha256)
  ))) return null
  const recoveryCase = wireCase as RecoveryCase
  const parsedArtifacts = artifacts as RecoveryCaseArtifact[]
  const candidateArtifacts = parsedArtifacts.filter(artifact => artifact.kind === 'candidate')
  const candidateHashes = new Map(candidateArtifacts.map(artifact => [artifact.id, artifact.sha256]))
  // Candidate ids key the selection and the approval request.
  if (candidateHashes.size !== candidateArtifacts.length) return null
  if (parsedArtifacts.some((artifact) => {
    switch (artifact.kind) {
      case 'diagnosis':
        return diagnosisPayload(artifact) === null
      case 'candidate':
        return candidatePayload(artifact) === null
      case 'validation': {
        // A validation must describe exactly the candidate content it tested.
        const validation = validationPayload(artifact)
        return validation === null
          || candidateHashes.get(validation.candidateArtifactId) !== validation.candidateSha256
      }
      default:
        return false
    }
  })) return null
  const activeApproval = parseRecoveryActiveApproval(value.activeApproval, recoveryCase, parsedArtifacts)
  if (activeApproval === undefined) return null
  return {
    case: recoveryCase,
    transitions: transitions as RecoveryCaseTransition[],
    artifacts: parsedArtifacts,
    autonomy: autonomy as RecoveryAutonomyProfile,
    activeApproval,
  }
}

/** The apply receipt; the success toast distinguishes a replacement from an accepted loss. */
export function parseResolution(value: unknown): SemanticCaseResolution | null {
  if (!isPostRecoveryCasesCaseIdApplyResponse(value)
    || (value.decision !== 'replace' && value.decision !== 'accept_loss')) return null
  return {
    runId: value.runId,
    sourceNodeId: value.sourceNodeId,
    decision: value.decision,
    resumed: value.resumed,
    resolvedCaseIds: value.resolvedCaseIds,
  }
}

const RECOVERY_EVIDENCE_KINDS = [
  'run',
  'run_node',
  'run_event',
  'semantic_detector',
  'dead_letter',
  'validation',
  'publication',
  'effect',
  'audit',
  'operator_decision',
  'case_artifact',
] as const
type RecoveryEvidenceKind = typeof RECOVERY_EVIDENCE_KINDS[number]
const RECOVERY_EVIDENCE_KIND_SET = new Set<string>(RECOVERY_EVIDENCE_KINDS)

export type RecoveryEvidenceRef = {
  kind: RecoveryEvidenceKind
  id: string
  sha256?: string
}

export type RecoveryCandidatePayload = {
  kind: 'replace_output' | 'repair_workflow' | 'adjust_detector' | 'accept_loss'
  decision: 'replace' | 'accept_loss' | 'manual_follow_up'
  reason: string
  requiredPermissions: string[]
  evidence: RecoveryEvidenceRef[]
  output?: unknown
  target?: {
    workflowId?: string
    workflowVersionId?: string
    detectorId?: string
  }
  risk: 'low' | 'medium' | 'high'
  expectedResult: string
}

export type RecoveryCandidateKind = RecoveryCandidatePayload['kind']

export type RecoveryDiagnosisHypothesis = {
  id: string
  cause: string
  confidence: number | null
  evidence: string[]
  counterEvidence: string[]
}

export type RecoveryDiagnosisPayload = {
  mode: 'deterministic_fallback' | 'ai_enriched'
  summary: string
  hypotheses: RecoveryDiagnosisHypothesis[]
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return []
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null
}

export function diagnosisPayload(
  artifact: RecoveryCaseArtifact | undefined,
): RecoveryDiagnosisPayload | null {
  if (!artifact || artifact.kind !== 'diagnosis' || !isRecord(artifact.payload)) {
    return null
  }
  const payload = artifact.payload
  if (
    (payload.mode !== 'deterministic_fallback' && payload.mode !== 'ai_enriched')
    || typeof payload.summary !== 'string'
    || !Array.isArray(payload.hypotheses)
  ) return null
  const hypotheses = payload.hypotheses.map((value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.cause !== 'string') {
      return null
    }
    const evidence = stringList(value.evidence)
    const counterEvidence = stringList(value.counterEvidence)
    if (
      !evidence
      || !counterEvidence
      || !(value.confidence === undefined || (typeof value.confidence === 'number' && Number.isFinite(value.confidence)))
    ) return null
    return {
      id: value.id,
      cause: value.cause,
      confidence: typeof value.confidence === 'number' ? value.confidence : null,
      evidence,
      counterEvidence,
    }
  })
  if (hypotheses.some(hypothesis => hypothesis === null)) return null
  return {
    mode: payload.mode,
    summary: payload.summary,
    hypotheses: hypotheses as RecoveryDiagnosisHypothesis[],
  }
}

const CANDIDATE_KINDS = ['replace_output', 'repair_workflow', 'adjust_detector', 'accept_loss']
const CANDIDATE_DECISIONS = ['replace', 'accept_loss', 'manual_follow_up']
const CANDIDATE_RISKS = ['low', 'medium', 'high']
const CANDIDATE_KEYS = ['kind', 'decision', 'reason', 'risk', 'evidence', 'expectedResult', 'requiredPermissions']

function evidenceRef(value: unknown): RecoveryEvidenceRef | null {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['kind', 'id', 'sha256'])
    || typeof value.kind !== 'string'
    || !RECOVERY_EVIDENCE_KIND_SET.has(value.kind)
    || typeof value.id !== 'string'
    || !(value.sha256 === undefined || (typeof value.sha256 === 'string' && SHA256.test(value.sha256)))
  ) return null
  return {
    kind: value.kind as RecoveryEvidenceKind,
    id: value.id,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
  }
}

/**
 * The candidate card renders one flow per decision: replace shows the output,
 * accept-loss nothing else, manual follow-up opens the target workflow version.
 * Each decision therefore pins its kind, its extra key and its permissions.
 */
export function candidatePayload(artifact: RecoveryCaseArtifact): RecoveryCandidatePayload | null {
  if (artifact.kind !== 'candidate' || !isRecord(artifact.payload)) return null
  const payload = artifact.payload
  const { kind, decision, requiredPermissions: permissions, evidence } = payload
  if (
    typeof kind !== 'string' || !CANDIDATE_KINDS.includes(kind)
    || typeof decision !== 'string' || !CANDIDATE_DECISIONS.includes(decision)
    || typeof payload.reason !== 'string'
    || typeof payload.expectedResult !== 'string'
    || typeof payload.risk !== 'string' || !CANDIDATE_RISKS.includes(payload.risk)
    || !Array.isArray(permissions)
    || !permissions.every(permission => permission === 'recovery.write' || permission === 'workflows.write')
    || !permissions.includes('recovery.write')
    || !Array.isArray(evidence)
    || CANDIDATE_KEYS.some(key => !Object.hasOwn(payload, key))
  ) return null
  const parsedEvidence = evidence.map(evidenceRef)
  if (parsedEvidence.some(value => value === null)) return null
  const hasOutput = Object.hasOwn(payload, 'output') && payload.output !== null
  const target = payload.target
  const allowedKeys = [
    ...CANDIDATE_KEYS,
    ...(decision === 'replace' ? ['output'] : []),
    ...(decision === 'manual_follow_up' ? ['target'] : []),
  ]
  if (!hasOnlyKeys(payload, allowedKeys)) return null
  switch (decision) {
    case 'replace':
      if (kind !== 'replace_output' || target !== undefined) return null
      break
    case 'accept_loss':
      if (kind !== 'accept_loss' || hasOutput || target !== undefined) return null
      break
    case 'manual_follow_up':
      if (
        (kind !== 'repair_workflow' && kind !== 'adjust_detector')
        || hasOutput
        || !permissions.includes('workflows.write')
        || !isRecord(target)
        || !hasOnlyKeys(target, ['workflowId', 'workflowVersionId', 'detectorId'])
        || typeof target.workflowId !== 'string' || target.workflowId === ''
        || typeof target.workflowVersionId !== 'string' || target.workflowVersionId === ''
        || (kind === 'repair_workflow' && target.detectorId !== undefined)
        || (kind === 'adjust_detector' && (typeof target.detectorId !== 'string' || target.detectorId === ''))
      ) return null
      break
  }
  return {
    ...(payload as RecoveryCandidatePayload),
    evidence: parsedEvidence as RecoveryEvidenceRef[],
  }
}

export function selectCandidateId(
  candidates: RecoveryCaseArtifact[],
  current: string | null,
  preferredKind?: RecoveryCandidateKind,
): string | null {
  if (preferredKind) {
    const preferred = candidates.find(candidate => (
      candidatePayload(candidate)?.kind === preferredKind
    ))
    if (preferred) return preferred.id
  }
  if (current && candidates.some(candidate => candidate.id === current)) {
    return current
  }
  return candidates.find(candidate => (
    candidatePayload(candidate)?.kind !== 'accept_loss'
  ))?.id ?? candidates[0]?.id ?? null
}

export type RecoveryValidationPayload = {
  candidateArtifactId: string
  candidateSha256: string
  caseRevision: number
  passed: boolean
  summary: string
}

const VALIDATION_KEYS = ['candidateArtifactId', 'candidateSha256', 'caseRevision', 'passed', 'summary']

export function validationPayload(
  artifact: RecoveryCaseArtifact | null,
): RecoveryValidationPayload | null {
  if (!artifact || artifact.kind !== 'validation' || !isRecord(artifact.payload)) return null
  const payload = artifact.payload
  if (
    !hasOnlyKeys(payload, VALIDATION_KEYS)
    || !VALIDATION_KEYS.every(key => Object.hasOwn(payload, key))
    || typeof payload.candidateArtifactId !== 'string'
    || typeof payload.candidateSha256 !== 'string'
    || !SHA256.test(payload.candidateSha256)
    || !Number.isSafeInteger(payload.caseRevision)
    || typeof payload.passed !== 'boolean'
    || typeof payload.summary !== 'string'
  ) return null
  return {
    candidateArtifactId: payload.candidateArtifactId,
    candidateSha256: payload.candidateSha256,
    caseRevision: payload.caseRevision as number,
    passed: payload.passed,
    summary: payload.summary,
  }
}

/**
 * Approve and Apply send the active approval's artifact ids back to the server,
 * so the binding must name a passed validation of exactly that candidate. The
 * server binds the validation revision to the grant. An expired approval is no approval.
 */
function parseRecoveryActiveApproval(
  value: WireDetail['activeApproval'],
  recoveryCase: RecoveryCase,
  artifacts: RecoveryCaseArtifact[],
): RecoveryActiveApproval | null | undefined {
  if (value === null) return null
  if (value.caseRevision !== recoveryCase.revision
    || recoveryCase.state !== 'awaiting_approval'
    || !isDate(value.expiresAt)) return undefined
  if (Date.parse(value.expiresAt) <= Date.now()) return null
  const candidate = artifacts.find(artifact => (
    artifact.kind === 'candidate' && artifact.id === value.candidateArtifactId
  ))
  const validationArtifact = artifacts.find(artifact => (
    artifact.kind === 'validation' && artifact.id === value.validationArtifactId
  )) ?? null
  const validation = validationPayload(validationArtifact)
  if (
    !candidate
    || !validation
    || !validation.passed
    || validation.candidateArtifactId !== candidate.id
    || validation.candidateSha256 !== candidate.sha256
  ) return undefined
  return {
    candidateArtifactId: value.candidateArtifactId,
    validationArtifactId: value.validationArtifactId,
    caseRevision: value.caseRevision,
    expiresAt: value.expiresAt,
  }
}
