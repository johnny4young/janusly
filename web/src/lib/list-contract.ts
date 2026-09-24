import { contractApi } from '../api'
import { t } from '../i18n/runtime'
import type { ApiResponses } from './api-types.generated'
import type { RunSummary, SavedWorkflow, Template, ToolSchema, WorkflowDefinition } from '../types'
import {
  isRecord,
  isNonEmptyString as nonempty,
  isNonNegativeSafeInteger as count,
  isOptionalNullableString as nullableText,
} from './guards'
import { isRunSummary } from './run-status-contract'

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
const malformed = () => new Error(t('api.error.malformedResponse'))

export function parseRunSummaryPage(value: unknown): RunSummary[] {
  if (!Array.isArray(value) || value.length > 200 || !value.every(isRunSummary)
    || new Set(value.map(row => row.id)).size !== value.length) throw malformed()
  return value
}

function isSavedWorkflow(value: unknown): value is SavedWorkflow {
  return isRecord(value) && nonempty(value.id) && typeof value.orgId === 'string' && typeof value.name === 'string'
    && ['createdBy', 'createdAt', 'updatedAt', 'lastRunStatus', 'pausedReason', 'folder', 'deletedAt'].every(key => nullableText(value[key]))
    && (value.runCount === undefined || count(value.runCount))
    && (value.bufferedTriggerCount === undefined || count(value.bufferedTriggerCount))
    && (value.tags === undefined || strings(value.tags))
    && (value.status === undefined || typeof value.status === 'string')
}

export function parseSavedWorkflowPage(value: unknown): SavedWorkflow[] {
  if (!Array.isArray(value) || value.length > 200 || !value.every(isSavedWorkflow)
    || new Set(value.map(row => row.id)).size !== value.length) throw malformed()
  return value
}

export async function readRunSummaryPage(path = '/runs', signal?: AbortSignal): Promise<RunSummary[]> {
  return parseRunSummaryPage(await contractApi('GET /runs', path, undefined, { signal }))
}

export async function readSavedWorkflowPage(): Promise<SavedWorkflow[]> {
  return parseSavedWorkflowPage(await contractApi('GET /workflows', '/workflows', undefined))
}

function isTool(value: unknown): value is ToolSchema {
  return isRecord(value) && nonempty(value.name) && typeof value.description === 'string'
    && typeof value.writeSide === 'boolean' && strings(value.required)
    && (value.optional === undefined || strings(value.optional))
    && (value.inputExample === undefined || isRecord(value.inputExample))
    && (value.descriptionCode === undefined || typeof value.descriptionCode === 'string')
    && Array.isArray(value.inputFields) && value.inputFields.every(field => isRecord(field)
      && typeof field.name === 'string' && typeof field.kind === 'string' && ['string', 'number', 'integer', 'boolean', 'json', 'array', 'object', 'unknown'].includes(field.kind)
      && typeof field.required === 'boolean' && (field.options === undefined || strings(field.options)))
}

export async function readToolCatalog(): Promise<ToolSchema[]> {
  const value: unknown = await contractApi('GET /tools', '/tools', undefined)
  if (!Array.isArray(value) || !value.every(isTool) || new Set(value.map(row => row.name)).size !== value.length) throw malformed()
  return value
}

export async function readTemplateCatalog(): Promise<Template[]> {
  const [payload, { isWorkflowDefinition }] = await Promise.all([
    contractApi('GET /templates', '/templates', undefined), import('./authoring-contract'),
  ])
  const value: unknown = payload
  const isTemplate = (row: unknown): row is Template => isRecord(row)
    && nonempty(row.id) && ['name', 'description', 'category', 'nameCode', 'descriptionCode', 'categoryCode'].every(key => typeof row[key] === 'string')
    && (row.requiredCredentials === undefined || strings(row.requiredCredentials)) && isWorkflowDefinition(row.workflow)
  if (!Array.isArray(value) || !value.every(isTemplate) || new Set(value.map(row => row.id)).size !== value.length) throw malformed()
  return value
}

// A display/authoring projection, not a second workflow parser. Persisted DAGs
// pass the same existing workflow guard used when opening an exact version.
export type WorkflowVersionRow = Pick<ApiResponses['GET /workflows/versions'][number], 'id' | 'version' | 'createdAt'> & {
  dagJson: WorkflowDefinition
}

export async function readWorkflowVersionPage(workflowId: string, options: { beforeVersion?: number; version?: number; limit?: number } = {}, signal?: AbortSignal): Promise<WorkflowVersionRow[]> {
  const query = new URLSearchParams({ workflowId })
  for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value))
  const [value, { isWorkflowDefinition }] = await Promise.all([
    contractApi('GET /workflows/versions', `/workflows/versions?${query}`, undefined, signal ? { signal } : undefined), import('./authoring-contract'),
  ])
  if (!Array.isArray(value) || value.length > 200) throw malformed()
  const rows: WorkflowVersionRow[] = []
  for (const row of value) {
    if (!isRecord(row) || !nonempty(row.id) || typeof row.id !== 'string'
      || !count(row.version) || row.version < 1
      || row.workflowId !== workflowId || !isWorkflowDefinition(row.dagJson)
      || (row.dagJson.id !== undefined && row.dagJson.id !== workflowId)
      || !(row.createdAt === null || typeof row.createdAt === 'string')
      || (options.version !== undefined && row.version !== options.version)
      || (options.beforeVersion !== undefined && row.version >= options.beforeVersion)) throw malformed()
    rows.push({ id: row.id, version: row.version, dagJson: row.dagJson, createdAt: row.createdAt })
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length
    || new Set(rows.map(row => row.version)).size !== rows.length) throw malformed()
  return rows
}
