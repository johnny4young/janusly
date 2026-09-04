import type {
  WorkflowBriefCompilation,
  WorkflowDefinition,
  WorkflowIntentBrief,
  WorkflowProposalResponse,
} from '../types'
import { isRecord } from './guards'

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isCanonicalNonemptyString(value: unknown): value is string {
  return isNonemptyString(value) && value === value.trim()
}

function isWorkflowIntentBrief(value: unknown): value is WorkflowIntentBrief {
  if (!isRecord(value)) return false
  return value.version === '1'
    && typeof value.objective === 'string'
    && typeof value.trigger === 'string'
    && isStringArray(value.inputs)
    && typeof value.expectedOutcome === 'string'
    && isStringArray(value.externalEffects)
    && isStringArray(value.approvals)
    && typeof value.failurePolicy === 'string'
    && isStringArray(value.examples)
    && (value.language === 'en' || value.language === 'es')
}

function isWorkflowInputSchema(value: unknown): boolean {
  const pending: unknown[] = [value]
  let visited = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (!isRecord(current) || ++visited > 512) return false
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

function isCircuitBreaker(value: unknown): boolean {
  if (value === false) return true
  if (typeof value === 'number') return Number.isInteger(value) && value >= 2 && value <= 100
  if (!isRecord(value) || !hasOnlyKeys(value, ['consecutiveFailures'])) return false
  const threshold = value.consecutiveFailures
  return threshold === false
    || (typeof threshold === 'number' && Number.isInteger(threshold) && threshold >= 2 && threshold <= 100)
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
      || (node.label !== undefined && (!isCanonicalNonemptyString(node.label) || node.label.length > 80))) return false
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

export type WorkflowVersionSnapshot = {
  id: string
  workflowId: string
  version: number
  dagJson: WorkflowDefinition
}

/**
 * Runtime authority for an exact historical workflow read. The generated
 * client catches compile-time drift; this closed guard prevents a malformed,
 * mismatched, or legacy-expanded success payload from replacing the canvas.
 */
export function parseWorkflowVersionSnapshot(
  value: unknown,
  expectedWorkflowId: string,
  expectedVersionId: string,
): WorkflowVersionSnapshot | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'workflowId', 'version', 'dagJson'])) return null
  if (value.id !== expectedVersionId || value.workflowId !== expectedWorkflowId) return null
  if (!isCanonicalNonemptyString(value.id) || value.id.length > 256
    || !isCanonicalNonemptyString(value.workflowId) || value.workflowId.length > 256) return null
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) return null
  if (!isWorkflowDefinition(value.dagJson) || value.dagJson.id !== expectedWorkflowId) return null
  return value as WorkflowVersionSnapshot
}

function isCapabilityBinding(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.kind === 'string'
    && typeof value.nodeId === 'string'
    && typeof value.field === 'string'
    && isStringArray(value.alternatives)
    && (value.requested === undefined || typeof value.requested === 'string')
    && (value.resolvedId === undefined || typeof value.resolvedId === 'string')
    && (value.reason === undefined || typeof value.reason === 'string')
}

function isReadinessIssue(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.code === 'string'
    && typeof value.severity === 'string'
    && ['info', 'warn', 'fail'].includes(value.severity)
    && typeof value.message === 'string'
    && (value.nodeId === undefined || typeof value.nodeId === 'string')
    && (value.edgeId === undefined || typeof value.edgeId === 'string')
    && (value.suggestion === undefined || typeof value.suggestion === 'string')
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

/** Runtime guard for the generated compile operation's parsed JSON payload. */
export function isWorkflowBriefCompilation(value: unknown): value is WorkflowBriefCompilation {
  if (!isRecord(value)) return false
  return isWorkflowIntentBrief(value.brief)
    && isStringArray(value.clarifyingQuestions)
    && value.clarifyingQuestions.length <= 3
    && typeof value.complete === 'boolean'
    && value.mode === 'deterministic'
}

/**
 * Runtime guard for the proposal boundary. OpenAPI provides compile-time
 * shapes; this check prevents malformed or stale success JSON from reaching
 * Apply even when an intermediary violates that contract.
 */
export function isWorkflowProposalResponse(value: unknown): value is WorkflowProposalResponse {
  if (!isRecord(value) || typeof value.mode !== 'string' || !['ai', 'fallback', 'error'].includes(value.mode)) return false
  if (!isWorkflowIntentBrief(value.brief) || !isStringArray(value.clarifyingQuestions)
    || value.clarifyingQuestions.length > 3) return false
  if (value.aiError !== undefined && typeof value.aiError !== 'string') return false
  if (value.providerGuarded !== undefined && typeof value.providerGuarded !== 'boolean') return false
  if (value.bonBackoff !== undefined && (
    !isRecord(value.bonBackoff)
    || !hasOnlyKeys(value.bonBackoff, ['from', 'to'])
    || typeof value.bonBackoff.from !== 'number'
    || !Number.isInteger(value.bonBackoff.from)
    || value.bonBackoff.from < 1
    || typeof value.bonBackoff.to !== 'number'
    || !Number.isInteger(value.bonBackoff.to)
    || value.bonBackoff.to < 1
  )) return false
  if (!isRecord(value.bindings)
    || typeof value.bindings.catalogVersion !== 'string'
    || !Array.isArray(value.bindings.resolved)
    || !value.bindings.resolved.every(isCapabilityBinding)
    || !Array.isArray(value.bindings.missing)
    || !value.bindings.missing.every(isCapabilityBinding)
    || typeof value.bindings.complete !== 'boolean') return false
  if (!isRecord(value.proposal) || !isWorkflowDefinition(value.proposal.workflow)) return false
  if (!isRecord(value.proposal.intentContract)
    || Object.values(value.proposal.intentContract).some((output) => typeof output !== 'string')) return false
  if (!Object.hasOwn(value.proposal, 'recoveryContract')
    || (value.proposal.recoveryContract !== null && !isRecord(value.proposal.recoveryContract))) return false
  if (!isRecord(value.proposal.qualification)
    || typeof value.proposal.qualification.intent !== 'boolean'
    || typeof value.proposal.qualification.recovery !== 'boolean'
    || typeof value.proposal.qualification.semantic !== 'boolean') return false
  if (!isStringArray(value.proposal.assumptions) || !isStringArray(value.proposal.risks)) return false
  if (!isRecord(value.proposal.readiness)
    || typeof value.proposal.readiness.status !== 'string'
    || !['pass', 'warn', 'fail'].includes(value.proposal.readiness.status)
    || !Array.isArray(value.proposal.readiness.issues)
    || !value.proposal.readiness.issues.every(isReadinessIssue)) return false
  if (!isRecord(value.proposal.diff)
    || !isStringArray(value.proposal.diff.nodesAdded)
    || !isStringArray(value.proposal.diff.nodesRemoved)
    || !isStringArray(value.proposal.diff.nodesChanged)
    || typeof value.proposal.diff.edgesBefore !== 'number'
    || !Number.isInteger(value.proposal.diff.edgesBefore)
    || value.proposal.diff.edgesBefore < 0
    || typeof value.proposal.diff.edgesAfter !== 'number'
    || !Number.isInteger(value.proposal.diff.edgesAfter)
    || value.proposal.diff.edgesAfter < 0
    || typeof value.proposal.applicable !== 'boolean') return false
  if (value.proposal.applicable && !value.bindings.complete) return false
  return true
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
