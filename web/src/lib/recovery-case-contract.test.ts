import { describe, expect, it } from 'vitest'
import type { RecoveryCaseArtifact } from '../types'
import { candidatePayload, parseRecoveryCaseDetail, parseResolution, validationPayload } from './recovery-case-contract'

const hash = (char: string) => char.repeat(64)

function artifact(id: string, kind: RecoveryCaseArtifact['kind'], payload: unknown, sha256 = hash('a')) {
  return { id, caseId: 'case-1', kind, payload, sha256, actorKind: 'user', actorId: null, createdAt: '2026-07-27T12:00:00.000Z' }
}

const candidate = artifact('candidate-1', 'candidate', {
  kind: 'replace_output', decision: 'replace', output: { mode: 'ai' }, reason: 'Reviewed', risk: 'medium',
  evidence: [{ kind: 'run', id: 'run-1' }], expectedResult: 'Detector passes', requiredPermissions: ['recovery.write'],
}, hash('b'))
const validation = artifact('validation-1', 'validation', {
  candidateArtifactId: candidate.id, candidateSha256: candidate.sha256, caseRevision: 4, passed: true, summary: 'Passed',
}, hash('c'))
const approval = { candidateArtifactId: candidate.id, validationArtifactId: validation.id, caseRevision: 6, expiresAt: '2099-01-01T00:00:00.000Z' }

const factors = ['observe', 'recommend', 'validate', 'apply_with_approval', 'autonomous_apply']
  .map((capability, requiredLevel) => ({ capability, requiredLevel, enabled: true }))

function detail(patch: Record<string, unknown> = {}, casePatch: Record<string, unknown> = {}) {
  return {
    case: {
      id: 'case-1', orgId: 'org-1', runId: 'run-1', workflowId: null, workflowVersionId: 'version-1',
      source: 'semantic_violation', detectorId: 'detector', sourceNodeId: 'node', detectorKind: 'expression',
      action: 'quarantine', message: 'Output violated its contract', detailsJson: null, state: 'awaiting_approval',
      revision: 6, createdBy: null, createdAt: '2026-07-27T12:00:00.000Z', updatedAt: '2026-07-27T12:00:00.000Z',
      resolvedAt: null, ...casePatch,
    },
    transitions: [{
      id: 'transition-1', orgId: 'org-1', caseId: 'case-1', fromState: 'detected', toState: 'contained',
      actorKind: 'system', actorId: null, evidenceJson: null, reason: null, occurredAt: '2026-07-27T12:00:00.000Z',
    }],
    artifacts: [candidate, validation],
    autonomy: {
      level: 3, source: 'workflow_default', detectorIds: ['detector'], unavailableReason: null,
      capabilities: { observe: true, recommend: true, validate: true, applyWithApproval: true, autonomousApply: false },
      factors,
    },
    activeApproval: approval,
    ...patch,
  }
}

describe('recovery case read contract', () => {
  it('accepts a bound approval and leaves sizes and counts to the server', () => {
    expect(parseRecoveryCaseDetail(detail())?.activeApproval).toEqual(approval)
    const large = detail({
      transitions: Array.from({ length: 150 }, (_, index) => ({ ...detail().transitions[0]!, id: `t-${index}-${'x'.repeat(300)}` })),
      autonomy: { ...detail().autonomy, detectorIds: Array.from({ length: 60 }, (_, index) => `detector-${index}`) },
    }, { message: 'm'.repeat(5_000), revision: 6 })
    expect(parseRecoveryCaseDetail(large)).not.toBeNull()
  })

  it.each([
    ['an additive envelope key', { ...detail(), futureField: true }],
    ['a missing autonomy profile', { ...detail(), autonomy: undefined }],
    ['a fractional revision', detail({}, { revision: 1.5 })],
  ])('delegates shape to the generated guard: %s', (_name, value) => {
    expect(parseRecoveryCaseDetail(value)).toBeNull()
  })

  it.each([
    ['a transition for another org', detail({ transitions: [{ ...detail().transitions[0]!, orgId: 'org-2' }] })],
    ['a transition for another case', detail({ transitions: [{ ...detail().transitions[0]!, caseId: 'case-2' }] })],
    ['an artifact for another case', detail({ artifacts: [{ ...candidate, caseId: 'case-2' }, validation] })],
    ['a state the panel cannot label', detail({}, { state: 'escalated' })],
    ['an actor the panel cannot label', detail({ transitions: [{ ...detail().transitions[0]!, actorKind: 'robot' }] })],
    ['a case date Intl cannot format', detail({}, { createdAt: 'not-a-date' })],
    ['a non-digest artifact hash', detail({ artifacts: [{ ...candidate, sha256: 'B'.repeat(64) }, validation] })],
    ['duplicate candidate ids', detail({ artifacts: [candidate, { ...candidate, sha256: hash('d') }, validation], activeApproval: null })],
    ['a validation of other candidate content', detail({
      artifacts: [candidate, { ...validation, payload: { ...validation.payload as object, candidateSha256: hash('e') } }],
    })],
    ['a missing capability factor', detail({ autonomy: { ...detail().autonomy, factors: factors.slice(1) } })],
    ['a duplicated capability factor', detail({ autonomy: { ...detail().autonomy, factors: [...factors.slice(1), factors[1]!] } })],
    ['an autonomy level with no copy', detail({ autonomy: { ...detail().autonomy, level: 9 } })],
  ])('rejects %s', (_name, value) => {
    expect(parseRecoveryCaseDetail(value)).toBeNull()
  })

  it.each([
    ['another revision', { ...approval, caseRevision: 5 }],
    ['an unparseable expiry', { ...approval, expiresAt: 'soon' }],
    ['another candidate', { ...approval, candidateArtifactId: 'candidate-2' }],
  ])('rejects an active approval bound to %s', (_name, activeApproval) => {
    expect(parseRecoveryCaseDetail(detail({ activeApproval }))).toBeNull()
  })

  it('rejects approval outside awaiting_approval or on a failed or stale validation', () => {
    expect(parseRecoveryCaseDetail(detail({}, { state: 'monitoring' }))).toBeNull()
    const failed = { ...validation, payload: { ...validation.payload as object, passed: false } }
    expect(parseRecoveryCaseDetail(detail({ artifacts: [candidate, failed] }))).toBeNull()
    const stale = { ...validation, payload: { ...validation.payload as object, caseRevision: 3 } }
    expect(parseRecoveryCaseDetail(detail({ artifacts: [candidate, stale] }))).toBeNull()
  })

  it('treats an expired approval as none', () => {
    expect(parseRecoveryCaseDetail(detail({ activeApproval: { ...approval, expiresAt: '2000-01-01T00:00:00.000Z' } }))?.activeApproval).toBeNull()
  })
})

describe('recovery artifact payloads', () => {
  const payload = candidate.payload as Record<string, unknown>
  const asCandidate = (value: Record<string, unknown>) => candidatePayload(artifact('c', 'candidate', value) as RecoveryCaseArtifact)

  it('pins each decision to its kind, extra key and permissions', () => {
    expect(asCandidate(payload)).not.toBeNull()
    expect(asCandidate({ ...payload, kind: 'accept_loss' })).toBeNull()
    expect(asCandidate({ ...payload, target: { workflowId: 'w', workflowVersionId: 'v' } })).toBeNull()
    expect(asCandidate({ ...payload, requiredPermissions: ['workflows.write'] })).toBeNull()
    const manual = {
      ...payload, kind: 'repair_workflow', decision: 'manual_follow_up', output: undefined,
      target: { workflowId: 'w', workflowVersionId: 'v' }, requiredPermissions: ['recovery.write', 'workflows.write'],
    }
    delete manual.output
    expect(asCandidate(manual)).not.toBeNull()
    expect(asCandidate({ ...manual, requiredPermissions: ['recovery.write'] })).toBeNull()
    expect(asCandidate({ ...manual, target: { workflowId: 'w' } })).toBeNull()
  })

  it('leaves reason, evidence and permission counts to the server', () => {
    expect(asCandidate({ ...payload, reason: 'r'.repeat(2_000), evidence: [], requiredPermissions: ['recovery.write', 'recovery.write'] })).not.toBeNull()
    expect(asCandidate({ ...payload, evidence: [{ kind: 'run', id: 'é'.repeat(300) }] })).not.toBeNull()
  })

  it('keeps validation payloads closed and hash-shaped', () => {
    expect(validationPayload(validation as RecoveryCaseArtifact)).not.toBeNull()
    const extra = { ...validation, payload: { ...validation.payload as object, note: 'x' } }
    expect(validationPayload(extra as RecoveryCaseArtifact)).toBeNull()
    const short = { ...validation, payload: { ...validation.payload as object, candidateSha256: 'abc' } }
    expect(validationPayload(short as RecoveryCaseArtifact)).toBeNull()
  })

  it('reads the apply receipt through its guard and decision vocabulary', () => {
    const receipt = { runId: 'run-1', sourceNodeId: 'node', decision: 'replace', resumed: true, resolvedCaseIds: Array.from({ length: 150 }, (_, i) => `c${i}`) }
    expect(parseResolution(receipt)).toEqual(receipt)
    expect(parseResolution({ ...receipt, decision: 'manual_follow_up' })).toBeNull()
    expect(parseResolution({ ...receipt, resumed: 'yes' })).toBeNull()
  })
})
