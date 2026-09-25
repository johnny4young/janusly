import type { WorkflowVersionIdentity } from '../store'
import type {
  WorkflowDefinition,
  WorkflowProposalResponse,
} from '../types'
import { hasOnlyKeys, isNonEmptyString, isRecord } from './guards'
import { isGetWorkflowsVersionsVersionIdResponse } from './api-guards/operations/GetWorkflowsVersionsVersionId'
import { isPostAiWorkflowProposalsResponse } from './api-guards/operations/PostAiWorkflowProposals'

// Wire shape is checked by the generated guards; this module keeps the workflow
// document rules the canvas depends on and the authoring binding invariants.

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isCanonicalNonemptyString(value: unknown): value is string {
  return isNonEmptyString(value) && value === value.trim()
}

function isWorkflowInputSchema(value: unknown): boolean {
  const pending: unknown[] = [value]
  let visited = 0
  // wire-policy: user-authored schemas are walked iteratively; Go shares this amplification bound.
  const maxNodes = 512
  while (pending.length > 0) {
    const current = pending.pop()
    if (!isRecord(current) || ++visited > maxNodes) return false
    if (!hasOnlyKeys(current, ['type', 'description', 'properties', 'required', 'items', 'enum', 'default'])) return false
    if (typeof current.type !== 'string'
      || !['string', 'number', 'boolean', 'object', 'array'].includes(current.type)) return false
    if (current.description !== undefined && typeof current.description !== 'string') return false
    if (current.required !== undefined && !isStringArray(current.required)) return false
    if (current.enum !== undefined && !Array.isArray(current.enum)) return false
    if (current.properties !== undefined) {
      if (!isRecord(current.properties)) return false
      pending.push(...Object.values(current.properties))
    }
    if (current.items !== undefined) pending.push(current.items)
    if (Object.hasOwn(current, 'default') && current.default === undefined) return false
  }
  return true
}

function isWorkflowMetadata(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['description', 'tags'])) return false
  if (value.description !== undefined
    && (typeof value.description !== 'string' || value.description !== value.description.trim())) return false
  return value.tags === undefined
    || (isStringArray(value.tags) && value.tags.every(isCanonicalNonemptyString))
}

// The threshold's range is server policy; the canvas only needs its form.
function isCircuitBreaker(value: unknown): boolean {
  if (value === false) return true
  if (typeof value === 'number') return Number.isInteger(value)
  if (!isRecord(value) || !hasOnlyKeys(value, ['consecutiveFailures'])) return false
  const threshold = value.consecutiveFailures
  return threshold === false || (typeof threshold === 'number' && Number.isInteger(threshold))
}

function isWorkflowRecoveryEnvelope(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['circuitBreaker', 'contract'])) return false
  if (value.circuitBreaker !== undefined && !isCircuitBreaker(value.circuitBreaker)) return false
  if (Object.hasOwn(value, 'circuitBreaker') && value.circuitBreaker === undefined) return false
  if (value.contract !== undefined && !isRecord(value.contract)) return false
  return !(Object.hasOwn(value, 'contract') && value.contract === undefined)
}

function isWorkflowUI(value: unknown, nodeIds: Set<string>): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['positions'])) return false
  if (value.positions === undefined) return !Object.hasOwn(value, 'positions')
  if (!isRecord(value.positions)) return false
  for (const [nodeId, rawPosition] of Object.entries(value.positions)) {
    if (!isCanonicalNonemptyString(nodeId) || !nodeIds.has(nodeId)) return false
    if (!isRecord(rawPosition) || !hasOnlyKeys(rawPosition, ['x', 'y'])) return false
    if (typeof rawPosition.x !== 'number' || !Number.isFinite(rawPosition.x)
      || typeof rawPosition.y !== 'number' || !Number.isFinite(rawPosition.y)) return false
  }
  return true
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false
  if (!hasOnlyKeys(value, [
    'dslVersion', 'id', 'name', 'metadata', 'nodes', 'edges', 'inputs',
    'outputs', 'templatePolicy', 'recovery', 'ui',
  ])) return false
  if (value.id !== undefined && !isCanonicalNonemptyString(value.id)) return false
  if (value.name !== undefined && !isCanonicalNonemptyString(value.name)) return false
  if (value.dslVersion !== undefined && value.dslVersion !== '1.0') return false
  if (value.templatePolicy !== undefined && value.templatePolicy !== 'lenient' && value.templatePolicy !== 'strict') return false
  if (value.metadata !== undefined && !isWorkflowMetadata(value.metadata)) return false
  if (value.inputs !== undefined && !isWorkflowInputSchema(value.inputs)) return false
  if (value.recovery !== undefined && !isWorkflowRecoveryEnvelope(value.recovery)) return false
  if (value.outputs !== undefined && (
    !isRecord(value.outputs) || Object.values(value.outputs).some((output) => typeof output !== 'string')
  )) return false
  const nodeIds = new Set<string>()
  for (const node of value.nodes) {
    if (!isRecord(node) || !hasOnlyKeys(node, ['id', 'type', 'label', 'config'])
      || !isCanonicalNonemptyString(node.id) || !isCanonicalNonemptyString(node.type)
      || !isRecord(node.config)
      || (node.label !== undefined && !isCanonicalNonemptyString(node.label))) return false
    if (nodeIds.has(node.id)) return false
    nodeIds.add(node.id)
  }
  if (value.ui !== undefined && !isWorkflowUI(value.ui, nodeIds)) return false
  return value.edges.every((edge) => (
    isRecord(edge)
    && hasOnlyKeys(edge, ['id', 'from', 'to', 'condition', 'onError'])
    && (edge.id === undefined || isCanonicalNonemptyString(edge.id))
    && isCanonicalNonemptyString(edge.from)
    && isCanonicalNonemptyString(edge.to)
    && nodeIds.has(edge.from)
    && nodeIds.has(edge.to)
    && (edge.condition === undefined || isCanonicalNonemptyString(edge.condition))
    && (edge.onError === undefined || typeof edge.onError === 'boolean')
  ))
}

/** Shared immutable identity boundary for save, latest read and rollback receipts. */
export function workflowVersionIdentity(
  value: unknown,
  expectedWorkflowId: string,
): WorkflowVersionIdentity | null {
  if (!isRecord(value)) return null
  const id = typeof value.versionId === 'string' ? value.versionId : value.id
  // The canvas records the saved version of the workflow it is editing, never another's.
  if (value.workflowId !== expectedWorkflowId || !isNonEmptyString(id) || !Number.isSafeInteger(value.version)) {
    return null
  }
  return { id, version: value.version as number }
}

/**
 * A rollback appends a new version copied from the target, so the receipt must
 * name the requested source, a fresh id, and a version after the current one.
 */
export function parseWorkflowRollbackReceipt(
  value: unknown,
  workflowId: string,
  current: WorkflowVersionIdentity,
  target: WorkflowVersionIdentity,
): WorkflowVersionIdentity | null {
  const version = workflowVersionIdentity(value, workflowId)
  if (!version || !isRecord(value) || value.sourceVersion !== target.version
    || value.versionId !== version.id
    || version.id === target.id || version.id === current.id
    || version.version <= current.version) return null
  return version
}

export type WorkflowVersionSnapshot = {
  id: string
  workflowId: string
  version: number
  dagJson: WorkflowDefinition
}

/**
 * Runtime authority for an exact historical workflow read. The generated guard
 * checks the closed shape; this binds the snapshot to both requested ids and
 * the canvas workflow rules before it can replace the canvas.
 */
export function parseWorkflowVersionSnapshot(
  value: unknown,
  expectedWorkflowId: string,
  expectedVersionId: string,
): WorkflowVersionSnapshot | null {
  if (!isGetWorkflowsVersionsVersionIdResponse(value)) return null
  if (value.id !== expectedVersionId || value.workflowId !== expectedWorkflowId) return null
  if (!isWorkflowDefinition(value.dagJson) || value.dagJson.id !== expectedWorkflowId) return null
  return { id: value.id, workflowId: value.workflowId, version: value.version, dagJson: value.dagJson }
}

// Compare JSON envelopes without recursion or key-order assumptions. Cyclic
// objects supplied directly by a plugin/test are rejected; network JSON can
// never contain them.
function jsonEquivalent(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]]
  const compared = new WeakMap<object, WeakSet<object>>()
  while (pending.length > 0) {
    const pair = pending.pop()
    if (!pair) return false
    const [currentLeft, currentRight] = pair
    if (currentLeft === currentRight) {
      if (currentLeft === null || typeof currentLeft !== 'object') continue
      return false
    }
    if (currentLeft !== null && currentRight !== null
      && typeof currentLeft === 'object' && typeof currentRight === 'object') {
      let rightObjects = compared.get(currentLeft)
      if (rightObjects?.has(currentRight)) return false
      if (!rightObjects) {
        rightObjects = new WeakSet<object>()
        compared.set(currentLeft, rightObjects)
      }
      rightObjects.add(currentRight)
    }
    if (Array.isArray(currentLeft) || Array.isArray(currentRight)) {
      if (!Array.isArray(currentLeft) || !Array.isArray(currentRight)
        || currentLeft.length !== currentRight.length) return false
      for (let index = 0; index < currentLeft.length; index += 1) {
        pending.push([currentLeft[index], currentRight[index]])
      }
      continue
    }
    if (!isRecord(currentLeft) || !isRecord(currentRight)) return false
    const leftKeys = Object.keys(currentLeft)
    const rightKeys = Object.keys(currentRight)
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !Object.hasOwn(currentRight, key))) return false
    for (const key of leftKeys) pending.push([currentLeft[key], currentRight[key]])
  }
  return true
}

function proposalContractsAreBound(value: WorkflowProposalResponse): boolean {
  const outputs = value.proposal.workflow.outputs ?? {}
  const workflowRecoveryContract = value.proposal.workflow.recovery?.contract ?? null
  const hasRecoveryContract = workflowRecoveryContract !== null
  const hasSemanticContract = isRecord(workflowRecoveryContract) && workflowRecoveryContract.version === '2'
  return jsonEquivalent(value.proposal.intentContract, outputs)
    && jsonEquivalent(value.proposal.recoveryContract, workflowRecoveryContract)
    && value.proposal.qualification.intent === (Object.keys(outputs).length > 0)
    && value.proposal.qualification.recovery === hasRecoveryContract
    && value.proposal.qualification.semantic === hasSemanticContract
}

/**
 * Runtime guard for the proposal boundary. The generated guard checks the wire
 * shape; Apply additionally needs a workflow the canvas can open and never an
 * applicable proposal whose capability bindings are incomplete.
 */
export function isWorkflowProposalResponse(value: unknown): value is WorkflowProposalResponse {
  return isPostAiWorkflowProposalsResponse(value)
    && isWorkflowDefinition(value.proposal.workflow)
    && (!value.proposal.applicable || value.bindings.complete)
}

/**
 * Final Apply boundary. The synchronous envelope guard keeps Zod out of the
 * boot chunk; only a proposal that actually carries recovery policy loads the
 * complete strict Recovery Contract validator. Duplicated contracts and
 * qualification flags must describe the exact workflow that will be copied.
 */
export async function isWorkflowProposalApplySafe(value: unknown): Promise<boolean> {
  if (!isWorkflowProposalResponse(value) || !proposalContractsAreBound(value)) return false
  if (value.proposal.workflow.recovery === undefined) return true
  const { WorkflowRecoverySchema } = await import('./recovery-contract')
  return WorkflowRecoverySchema.safeParse(value.proposal.workflow.recovery).success
}
