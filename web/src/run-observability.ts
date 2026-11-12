/**
 * Pure projections for the active-run and waiting-step surfaces. Extracts the
 * useful operator-facing subset from persisted JSON without trusting its shape.
 *
 * Used by:
 * - `components/RunsPanel.tsx` for run identity, trigger input, and wait cards.
 * - `run-map.ts` for the decisions the run map offers in place.
 * - Focused unit tests that pin malformed/historical payload fallbacks.
 *
 * Invariants:
 * - Never throws on historical or truncated persisted JSON.
 * - `inputJson.workflow` is treated as display context, never authorization.
 */

import type { JsonObject, RunEvent, RunNode, RunSummary, WorkflowInputSchemaShape } from './types'

export type RunWorkflowIdentity = { id: string | null; name: string | null }
export type RunWaitKind = 'approval' | 'tool_approval' | 'human_form' | 'webhook' | 'timer' | 'subworkflow' | 'unknown'
export type RunWaitingInfo = {
  kind: RunWaitKind
  title: string | null
  description: string | null
  waitingSince: string | null
  wakeAt: string | null
  deadlineAt: string | null
  assignee: string | null
  onTimeout: string | null
  escalateTo: string | null
  timeoutState: string | null
  escalatedFrom: string | null
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Identity captured with the exact workflow snapshot that started the run. */
export function getRunWorkflowIdentity(run: RunSummary): RunWorkflowIdentity {
  const workflow = asObject(asObject(run.inputJson)?.workflow)
  return {
    id: readNonEmptyString(workflow?.id),
    name: readNonEmptyString(workflow?.name),
  }
}

/** Trigger-time payload only; deliberately excludes the much larger workflow snapshot. */
export function getRunTriggerInput(run: RunSummary): unknown | undefined {
  const inputJson = asObject(run.inputJson)
  return inputJson && Object.hasOwn(inputJson, 'input') ? inputJson.input : undefined
}

/** Latest node finish, used as the stable terminal boundary for elapsed time. */
export function getRunFinishedAt(nodes: RunNode[]): string | null {
  let latest: { iso: string; ms: number } | null = null
  for (const node of nodes) {
    const iso = readNonEmptyString(node.finishedAt)
    if (!iso) continue
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) continue
    if (!latest || ms > latest.ms) latest = { iso, ms }
  }
  return latest?.iso ?? null
}

/** Persisted terminal run event is the authoritative run-level finish time. */
export function getRunTerminalAt(events: RunEvent[]): string | null {
  let latest: { iso: string; ms: number } | null = null
  for (const event of events) {
    if (!['run.succeeded', 'run.failed', 'run.cancelled'].includes(event.type)) continue
    const iso = readNonEmptyString(event.createdAt)
    if (!iso) continue
    const ms = Date.parse(iso)
    if (Number.isFinite(ms) && (!latest || ms > latest.ms)) latest = { iso, ms }
  }
  return latest?.iso ?? null
}

/** Classify both current metadata and older reason-only waiting rows. */
export function getRunWaitingInfo(node: RunNode): RunWaitingInfo {
  const waiting = asObject(asObject(node.stateJson)?.waiting) ?? {}
  const reason = readNonEmptyString(waiting.reason)?.toLowerCase() ?? ''
  const explicitKind = readNonEmptyString(waiting.kind)
  let kind: RunWaitKind = 'unknown'
  if (explicitKind === 'tool_approval') kind = 'tool_approval'
  else if (explicitKind === 'human_form') kind = 'human_form'
  else if (explicitKind === 'approval') kind = 'approval'
  else if (explicitKind === 'webhook') kind = 'webhook'
  else if (explicitKind === 'timer' || waiting.wakeAt) kind = 'timer'
  else if (explicitKind === 'subworkflow') kind = 'subworkflow'
  else if (reason.includes('approval')) kind = 'approval'
  else if (reason.includes('form')) kind = 'human_form'
  else if (reason.includes('webhook')) kind = 'webhook'
  else if (reason.includes('absolute time')) kind = 'timer'
  else if (reason.includes('subworkflow')) kind = 'subworkflow'

  return {
    kind,
    title: readNonEmptyString(waiting.title) ?? (kind === 'approval' ? readNonEmptyString(waiting.message) : null),
    description: readNonEmptyString(waiting.description),
    waitingSince: readNonEmptyString(waiting.waitingSince) ?? readNonEmptyString(node.startedAt),
    wakeAt: readNonEmptyString(waiting.wakeAt),
    deadlineAt: readNonEmptyString(waiting.deadlineAt),
    assignee: readNonEmptyString(waiting.assignee),
    onTimeout: readNonEmptyString(waiting.onTimeout),
    escalateTo: readNonEmptyString(waiting.escalateTo),
    timeoutState: readNonEmptyString(waiting.timeoutState),
    escalatedFrom: readNonEmptyString(waiting.escalatedFrom),
  }
}

export type ToolApprovalRequest = {
  approvalId: string
  tool: string
  params: unknown
  paramsDigest: string
  maskedPaths: string[]
  requesterIds: string[]
  eligibleApprovers: number | null
  requiredApprovals: number
}

export type ToolApprovalDecision = {
  approvalId: string
  paramsDigest: string
  decision: 'approve' | 'deny'
}

/** The exact call an approver decides on; null unless every binding field is present. */
export function getToolApprovalRequest(node: RunNode): ToolApprovalRequest | null {
  const waiting = asObject(asObject(node.stateJson)?.waiting)
  if (waiting?.kind !== 'tool_approval') return null
  const approvalId = readNonEmptyString(waiting.approvalId)
  const tool = readNonEmptyString(waiting.tool)
  const paramsDigest = readNonEmptyString(waiting.paramsDigest)
  if (!approvalId || !tool || !paramsDigest || !Object.hasOwn(waiting, 'params')) return null
  const required = typeof waiting.requiredApprovals === 'number' ? waiting.requiredApprovals : 1
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const eligibleApprovers = typeof waiting.eligibleApprovers === 'number' ? waiting.eligibleApprovers : null
  return {
    approvalId, tool, params: waiting.params, paramsDigest, maskedPaths: strings(waiting.maskedPaths),
    requesterIds: strings(waiting.requesterIds), eligibleApprovers, requiredApprovals: required,
  }
}

export type HumanFormWaiting = {
  title?: string
  description?: string
  schema: WorkflowInputSchemaShape
  initialValues?: unknown
  resumeToken: string
}

/** A waiting human form with everything the resume route needs, or null. */
export function readHumanFormWaiting(node: RunNode): HumanFormWaiting | null {
  const data = asObject(asObject(node.stateJson)?.waiting)
  if (data?.kind !== 'human_form') return null
  if (typeof data.resumeToken !== 'string' || !data.resumeToken) return null
  if (!isWorkflowInputSchemaShape(data.schema)) return null
  return {
    title: typeof data.title === 'string' ? data.title : undefined,
    description: typeof data.description === 'string' ? data.description : undefined,
    schema: data.schema,
    initialValues: data.initialValues,
    resumeToken: data.resumeToken,
  }
}

function isWorkflowInputSchemaShape(value: unknown): value is WorkflowInputSchemaShape {
  const schema = asObject(value)
  if (!schema || !['string', 'number', 'boolean', 'object', 'array'].includes(String(schema.type))) return false
  if (schema.properties !== undefined) {
    const properties = asObject(schema.properties)
    if (!properties) return false
    for (const child of Object.values(properties)) {
      if (!isWorkflowInputSchemaShape(child)) return false
    }
  }
  if (schema.items !== undefined && !isWorkflowInputSchemaShape(schema.items)) return false
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(item => typeof item === 'string'))) return false
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return false
  return true
}
