/**
 * Browser-side semantic recovery read contract.
 *
 * The API envelope is untrusted until this module has bounded every collection,
 * identifier, artifact payload, approval binding, and candidate hash. Keeping
 * the pure parser outside the React panel makes the authority reusable and
 * keeps the lazy recovery UI focused on presentation and orchestration.
 */

import {
  RECOVERY_AUTONOMY_CAPABILITIES,
  type RecoveryAutonomyCapability,
  type RecoveryAutonomyLevel,
  type RecoveryAutonomyProfile,
} from './recovery-autonomy'
import type {
  RecoveryCase,
  RecoveryCaseArtifact,
  RecoveryCaseTransition,
  SemanticCaseResolution,
} from '../types'
import { isRecord } from './guards'

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
const RECOVERY_DETAIL_MAX_ITEMS = 100
const RECOVERY_IDENTIFIER_MAX_BYTES = 256
const RECOVERY_TIMESTAMP_MAX_BYTES = 64
const RECOVERY_CASE_MESSAGE_MAX_BYTES = 3200
const RECOVERY_TRANSITION_REASON_MAX_BYTES = 1000
const textEncoder = new TextEncoder()
const RECOVERY_AUTONOMY_SOURCES = new Set<RecoveryAutonomyProfile['source']>([
  'failure_override',
  'workflow_default',
  'strictest_failure',
  'unavailable',
])

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}

function isBoundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && utf8ByteLength(value) <= maximum
}

function isBoundedIdentifier(value: unknown): value is string {
  return isBoundedString(value, RECOVERY_IDENTIFIER_MAX_BYTES)
}

function isBoundedTimestamp(value: unknown): value is string {
  return isBoundedString(value, RECOVERY_TIMESTAMP_MAX_BYTES)
    && Number.isFinite(Date.parse(value))
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
    !isBoundedIdentifier(value.id)
    || !isBoundedIdentifier(value.orgId)
    || !isBoundedIdentifier(value.runId)
    || !(value.workflowId === null || isBoundedIdentifier(value.workflowId))
    || !isBoundedIdentifier(value.workflowVersionId)
    || value.source !== 'semantic_violation'
    || !isBoundedIdentifier(value.detectorId)
    || !isBoundedIdentifier(value.sourceNodeId)
    || (value.detectorKind !== 'expression' && value.detectorKind !== 'schema')
    || (value.action !== 'observe' && value.action !== 'quarantine')
    || !isBoundedString(value.message, RECOVERY_CASE_MESSAGE_MAX_BYTES)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 1
    || !isRecoveryCaseState(value.state)
    || !(value.createdBy === null || isBoundedIdentifier(value.createdBy))
    || !isBoundedTimestamp(value.createdAt)
    || !isBoundedTimestamp(value.updatedAt)
    || !(value.resolvedAt === null || isBoundedTimestamp(value.resolvedAt))
  ) return null
  return value as RecoveryCase
}

const RECOVERY_ARTIFACT_KINDS = new Set<RecoveryCaseArtifact['kind']>([
  'diagnosis',
  'candidate',
  'validation',
  'publication',
  'verification',
])

function parseRecoveryCaseArtifact(value: unknown): RecoveryCaseArtifact | null {
  if (!isRecord(value)) return null
  if (
    !isBoundedIdentifier(value.id)
    || !isBoundedIdentifier(value.caseId)
    || typeof value.kind !== 'string'
    || !RECOVERY_ARTIFACT_KINDS.has(value.kind as RecoveryCaseArtifact['kind'])
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !isRecoveryCaseActorKind(value.actorKind)
    || !(value.actorId === null || isBoundedIdentifier(value.actorId))
    || !isBoundedTimestamp(value.createdAt)
    || !('payload' in value)
  ) return null
  return value as RecoveryCaseArtifact
}

function parseRecoveryCaseTransition(
  value: unknown,
): RecoveryCaseTransition | null {
  if (!isRecord(value)) return null
  if (
    !isBoundedIdentifier(value.id)
    || !isBoundedIdentifier(value.orgId)
    || !isBoundedIdentifier(value.caseId)
    || !isRecoveryCaseState(value.fromState)
    || !isRecoveryCaseState(value.toState)
    || !isRecoveryCaseActorKind(value.actorKind)
    || !(value.actorId === null || isBoundedIdentifier(value.actorId))
    || !('evidenceJson' in value)
    || !(
      value.reason === null
      || isBoundedString(value.reason, RECOVERY_TRANSITION_REASON_MAX_BYTES, true)
    )
    || !isBoundedTimestamp(value.occurredAt)
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
    || value.detectorIds.length > 50
    || !value.detectorIds.every(id => (
      isBoundedIdentifier(id)
    ))
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

export function parseRecoveryCaseDetail(value: unknown): RecoveryCaseDetail | null {
  if (!isRecord(value)) return null
  const recoveryCase = parseRecoveryCase(value.case)
  const autonomy = parseRecoveryAutonomyProfile(value.autonomy)
  if (
    !recoveryCase
    || !autonomy
    || !Array.isArray(value.transitions)
    || !Array.isArray(value.artifacts)
    || value.transitions.length > RECOVERY_DETAIL_MAX_ITEMS
    || value.artifacts.length > RECOVERY_DETAIL_MAX_ITEMS
  ) return null
  const transitions = value.transitions
    .map(parseRecoveryCaseTransition)
    .filter((item): item is RecoveryCaseTransition => item !== null)
  if (transitions.length !== value.transitions.length) return null
  const artifacts = value.artifacts
    .map(parseRecoveryCaseArtifact)
    .filter((item): item is RecoveryCaseArtifact => item !== null)
  if (artifacts.length !== value.artifacts.length) return null
  if (
    transitions.some(transition => (
      transition.orgId !== recoveryCase.orgId || transition.caseId !== recoveryCase.id
    ))
    || artifacts.some(artifact => artifact.caseId !== recoveryCase.id)
  ) return null
  const candidateArtifacts = artifacts.filter(artifact => artifact.kind === 'candidate')
  const candidateHashes = new Map(candidateArtifacts.map(artifact => [artifact.id, artifact.sha256]))
  if (candidateHashes.size !== candidateArtifacts.length) return null
  if (artifacts.some((artifact) => {
    switch (artifact.kind) {
      case 'diagnosis':
        return diagnosisPayload(artifact) === null
      case 'candidate':
        return candidatePayload(artifact) === null
      case 'validation': {
        const validation = validationPayload(artifact)
        return validation === null
          || candidateHashes.get(validation.candidateArtifactId) !== validation.candidateSha256
      }
      default:
        return false
    }
  })) return null
  const activeApproval = parseRecoveryActiveApproval(
    value.activeApproval,
    recoveryCase,
    artifacts,
  )
  if (activeApproval === undefined) return null
  return { case: recoveryCase, transitions, artifacts, autonomy, activeApproval }
}

export function parseResolution(value: unknown): SemanticCaseResolution | null {
  if (!isRecord(value)) return null
  if (
    !isBoundedIdentifier(value.runId)
    || !isBoundedIdentifier(value.sourceNodeId)
    || (value.decision !== 'replace' && value.decision !== 'accept_loss')
    || typeof value.resumed !== 'boolean'
    || !Array.isArray(value.resolvedCaseIds)
    || value.resolvedCaseIds.length > 100
    || !value.resolvedCaseIds.every(id => (
      isBoundedIdentifier(id)
    ))
  ) return null
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

function boundedStringList(value: unknown, limit: number): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) return null
  const strings = value.filter((item): item is string => (
    typeof item === 'string' && item.length <= 1600
  ))
  return strings.length === value.length ? strings : null
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
    || payload.summary.length > 3200
    || !Array.isArray(payload.hypotheses)
    || payload.hypotheses.length < 1
    || payload.hypotheses.length > 3
  ) return null
  const hypotheses = payload.hypotheses.map((value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.cause !== 'string') {
      return null
    }
    const evidence = boundedStringList(value.evidence, 5)
    const counterEvidence = boundedStringList(value.counterEvidence, 5)
    if (
      !evidence
      || !counterEvidence
      || value.id.length > 320
      || value.cause.length > 3200
      || !(
        value.confidence === undefined
        || (typeof value.confidence === 'number'
          && Number.isFinite(value.confidence)
          && value.confidence >= 0
          && value.confidence <= 1)
      )
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

export function candidatePayload(artifact: RecoveryCaseArtifact): RecoveryCandidatePayload | null {
  if (artifact.kind !== 'candidate' || !isRecord(artifact.payload)) return null
  const payload = artifact.payload
  const kind = payload.kind
  const decision = payload.decision
  const permissions = payload.requiredPermissions
  const evidence = payload.evidence
  if (
    typeof kind !== 'string'
    || !['replace_output', 'repair_workflow', 'adjust_detector', 'accept_loss'].includes(kind)
    || typeof decision !== 'string'
    || !['replace', 'accept_loss', 'manual_follow_up'].includes(decision)
    || typeof payload.reason !== 'string'
    || payload.reason.trim().length === 0
    || payload.reason.length > 1000
    || typeof payload.expectedResult !== 'string'
    || payload.expectedResult.trim().length === 0
    || payload.expectedResult.length > 500
    || typeof payload.risk !== 'string'
    || !['low', 'medium', 'high'].includes(payload.risk)
    || !Array.isArray(permissions)
    || permissions.length < 1
    || permissions.length > 4
    || !permissions.every(permission => (
      permission === 'recovery.write' || permission === 'workflows.write'
    ))
    || new Set(permissions).size !== permissions.length
    || !permissions.includes('recovery.write')
    || !Array.isArray(evidence)
    || evidence.length < 1
    || evidence.length > 20
  ) return null
  const parsedEvidence = evidence.map((value): RecoveryEvidenceRef | null => {
    if (
      !isRecord(value)
      || !Object.hasOwn(value, 'kind')
      || !Object.hasOwn(value, 'id')
      || Object.keys(value).some(key => !['kind', 'id', 'sha256'].includes(key))
      || typeof value.kind !== 'string'
      || !RECOVERY_EVIDENCE_KIND_SET.has(value.kind)
      || typeof value.id !== 'string'
      || utf8ByteLength(value.id) < 1
      || utf8ByteLength(value.id) > 500
      || !(
        value.sha256 === undefined
        || (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256))
      )
    ) return null
    return {
      kind: value.kind as RecoveryEvidenceKind,
      id: value.id,
      ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
    }
  })
  if (parsedEvidence.some(value => value === null)) return null
  const commonKeys = [
    'kind',
    'decision',
    'reason',
    'risk',
    'evidence',
    'expectedResult',
    'requiredPermissions',
  ]
  if (commonKeys.some(key => !Object.hasOwn(payload, key))) return null
  const hasOutput = Object.hasOwn(payload, 'output') && payload.output !== null
  const target = payload.target
  const allowedKeys = new Set([
    ...commonKeys,
    ...(decision === 'replace' ? ['output'] : []),
    ...(decision === 'manual_follow_up' ? ['target'] : []),
  ])
  if (Object.keys(payload).some(key => !allowedKeys.has(key))) return null
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
        || typeof target.workflowId !== 'string'
        || target.workflowId.length === 0
        || target.workflowId.length > 200
        || typeof target.workflowVersionId !== 'string'
        || target.workflowVersionId.length === 0
        || target.workflowVersionId.length > 200
        || Object.keys(target).some(key => (
          key !== 'workflowId' && key !== 'workflowVersionId' && key !== 'detectorId'
        ))
        || (kind === 'repair_workflow' && target.detectorId !== undefined)
        || (kind === 'adjust_detector' && (
          typeof target.detectorId !== 'string'
          || target.detectorId.length === 0
          || target.detectorId.length > 200
        ))
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

export function validationPayload(
  artifact: RecoveryCaseArtifact | null,
): RecoveryValidationPayload | null {
  if (!artifact || artifact.kind !== 'validation' || !isRecord(artifact.payload)) return null
  const payload = artifact.payload
  if (
    Object.keys(payload).length !== 5
    || ![
      'candidateArtifactId',
      'candidateSha256',
      'caseRevision',
      'passed',
      'summary',
    ].every(key => Object.hasOwn(payload, key))
    || typeof artifact.payload.candidateArtifactId !== 'string'
    || utf8ByteLength(artifact.payload.candidateArtifactId) === 0
    || utf8ByteLength(artifact.payload.candidateArtifactId) > RECOVERY_IDENTIFIER_MAX_BYTES
    || typeof artifact.payload.candidateSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(artifact.payload.candidateSha256)
    || !Number.isSafeInteger(artifact.payload.caseRevision)
    || (artifact.payload.caseRevision as number) < 1
    || typeof artifact.payload.passed !== 'boolean'
    || typeof artifact.payload.summary !== 'string'
    || artifact.payload.summary.trim().length === 0
    || Array.from(artifact.payload.summary).length > 500
  ) return null
  return {
    candidateArtifactId: artifact.payload.candidateArtifactId,
    candidateSha256: artifact.payload.candidateSha256,
    caseRevision: artifact.payload.caseRevision as number,
    passed: artifact.payload.passed,
    summary: artifact.payload.summary,
  }
}

function parseRecoveryActiveApproval(
  value: unknown,
  recoveryCase: RecoveryCase,
  artifacts: RecoveryCaseArtifact[],
): RecoveryActiveApproval | null | undefined {
  if (value === null) return null
  if (
    !isRecord(value)
    || Object.keys(value).length !== 4
    || ![
      'candidateArtifactId',
      'validationArtifactId',
      'caseRevision',
      'expiresAt',
    ].every(key => Object.hasOwn(value, key))
    || !isBoundedIdentifier(value.candidateArtifactId)
    || !isBoundedIdentifier(value.validationArtifactId)
    || !Number.isSafeInteger(value.caseRevision)
    || value.caseRevision !== recoveryCase.revision
    || recoveryCase.state !== 'awaiting_approval'
    || !isBoundedTimestamp(value.expiresAt)
  ) return undefined
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
    || validation.caseRevision !== recoveryCase.revision - 2
  ) return undefined
  return {
    candidateArtifactId: value.candidateArtifactId,
    validationArtifactId: value.validationArtifactId,
    caseRevision: value.caseRevision as number,
    expiresAt: value.expiresAt,
  }
}
