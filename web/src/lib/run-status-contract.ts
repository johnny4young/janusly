import type { ApiResponses } from './api-types.generated'
import type { RunEvent, RunNode, RunSummary } from '../types'
import { isRecord } from './guards'
import { isOpenNodeStatus, isOpenRunStatus, isTerminalNodeStatus, isTerminalRunStatus } from './status'

// A validated display projection: extension JSON is narrowed to the object
// shapes consumed by the UI; wire pagination types come from the manifest.
export type RunStatusSnapshot = Pick<ApiResponses['GET /status'], 'eventsCursor' | 'eventsHasMore'> & {
  run: RunSummary
  nodes: RunNode[]
  events: RunEvent[]
}

const optionalString = (value: unknown) => value === undefined || typeof value === 'string'
const nullableString = (value: unknown) => value === null || optionalString(value)
const optionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean'
const nullableRecord = (value: unknown) => value === undefined || value === null || isRecord(value)
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const optionalCount = (value: unknown) => value === undefined || count(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

export function isRunSummary(value: unknown): value is RunSummary {
  if (!isRecord(value) || !nonempty(value.id) || (!isOpenRunStatus(value.status) && !isTerminalRunStatus(value.status))) return false
  return ['orgId', 'workflowId', 'workflowVersionId'].every(key => optionalString(value[key]))
    && ['workflowName', 'createdBy', 'createdAt', 'traceId', 'replayMode'].every(key => nullableString(value[key]))
    && optionalBoolean(value.hasWaitingNodes)
    && optionalCount(value.semanticViolationCount)
    && nullableRecord(value.inputJson) && nullableRecord(value.outputJson)
    && (value.outcomeStatus == null || (typeof value.outcomeStatus === 'string' && ['semantic_violation', 'semantic_quarantined', 'semantic_recovering', 'semantic_recovered', 'semantic_accepted_loss'].includes(value.outcomeStatus)))
    && (value.validationEvidenceLevel == null || (typeof value.validationEvidenceLevel === 'string' && ['static', 'writes_skipped', 'provider_simulated', 'live_canary'].includes(value.validationEvidenceLevel)))
}

function runNode(value: unknown, runId: string): value is RunNode {
  return isRecord(value) && nonempty(value.nodeId)
    && (value.runId === undefined || value.runId === runId)
    && (isOpenNodeStatus(value.status) || isTerminalNodeStatus(value.status))
    && nullableRecord(value.stateJson) && nullableRecord(value.errorJson)
    && (value.attempts === null || optionalCount(value.attempts))
    && nullableString(value.startedAt) && nullableString(value.finishedAt)
}

function runEvent(value: unknown, runId: string): value is RunEvent {
  return isRecord(value) && nonempty(value.id) && nonempty(value.type)
    && (value.runId === undefined || value.runId === runId)
    && nullableString(value.nodeId) && nullableRecord(value.payload)
    && nullableString(value.createdAt)
}

// Validate the entire projection before any store or summary mutation. A
// syntactically valid JSON value (including {}) is not a status snapshot.
// Unknown additive fields remain compatible; malformed known fields do not.
export function parseRunStatusSnapshot(value: unknown, runId: string): RunStatusSnapshot | null {
  if (!isRecord(value) || !isRunSummary(value.run) || value.run.id !== runId
    || !Array.isArray(value.nodes) || !value.nodes.every(node => runNode(node, runId))
    || !Array.isArray(value.events) || value.events.length > 500 || !value.events.every(event => runEvent(event, runId))
    || typeof value.eventsHasMore !== 'boolean'
    || !(value.eventsCursor === null || typeof value.eventsCursor === 'string')
    || (value.eventsHasMore ? !nonempty(value.eventsCursor) : value.eventsCursor !== null)) return null
  if (new Set(value.nodes.map(node => node.nodeId)).size !== value.nodes.length
    || new Set(value.events.map(event => event.id)).size !== value.events.length) return null
  return { run: value.run, nodes: value.nodes, events: value.events, eventsCursor: value.eventsCursor, eventsHasMore: value.eventsHasMore }
}
