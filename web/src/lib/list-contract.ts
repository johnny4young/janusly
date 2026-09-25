import { contractApi } from '../api'
import type { ApiResponses } from './api-types.generated'
import type { RunSummary, SavedWorkflow, Template, ToolSchema, WorkflowDefinition } from '../types'
import { isOptionalNullableRecord as objectOrAbsent } from './guards'
import { MalformedResponseError } from './malformed-response'
import { isGetRunsResponse } from './api-guards/operations/GetRuns'
import { isGetTemplatesResponse } from './api-guards/operations/GetTemplates'
import { isGetToolsResponse } from './api-guards/operations/GetTools'
import { isGetWorkflowsResponse } from './api-guards/operations/GetWorkflows'
import { isGetWorkflowsVersionsResponse } from './api-guards/operations/GetWorkflowsVersions'

// Shape is checked by each operation's generated guard inside contractApi;
// these readers keep only the invariants their list components depend on.

// List rows are React keys and store identities, so a page never repeats one.
function unique<Row>(rows: readonly Row[], key: (row: Row) => unknown): boolean {
  return new Set(rows.map(key)).size === rows.length
}

export async function readRunSummaryPage(path = '/runs', signal?: AbortSignal): Promise<RunSummary[]> {
  const rows = await contractApi('GET /runs', path, undefined, { signal, guard: isGetRunsResponse })
  // RunsPanel renders the active run's opaque output projection as an object.
  if (!unique(rows, row => row.id) || !rows.every(row => objectOrAbsent(row.outputJson))) throw new MalformedResponseError()
  return rows as RunSummary[]
}

export async function readSavedWorkflowPage(): Promise<SavedWorkflow[]> {
  const rows = await contractApi('GET /workflows', '/workflows', undefined, { guard: isGetWorkflowsResponse })
  if (!unique(rows, row => row.id)) throw new MalformedResponseError()
  return rows
}

export async function readToolCatalog(): Promise<ToolSchema[]> {
  const rows = await contractApi('GET /tools', '/tools', undefined, { guard: isGetToolsResponse })
  // The node palette and tool picker key tools by name.
  if (!unique(rows, row => row.name)) throw new MalformedResponseError()
  return rows as ToolSchema[]
}

export async function readTemplateCatalog(): Promise<Template[]> {
  const [rows, { isWorkflowDefinition }] = await Promise.all([
    contractApi('GET /templates', '/templates', undefined, { guard: isGetTemplatesResponse }), import('./authoring-contract'),
  ])
  // A template opens on the canvas, which needs the workflow-definition invariants.
  if (!unique(rows, row => row.id) || !rows.every(row => isWorkflowDefinition(row.workflow))) throw new MalformedResponseError()
  return rows as Template[]
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
    contractApi('GET /workflows/versions', `/workflows/versions?${query}`, undefined, signal ? { signal, guard: isGetWorkflowsVersionsResponse } : { guard: isGetWorkflowsVersionsResponse }), import('./authoring-contract'),
  ])
  const rows: WorkflowVersionRow[] = []
  for (const row of value) {
    // VersionHistoryPanel pages by version and binds each row to the requested
    // workflow; RecoveryDeltaCard reads one exact version.
    if (row.workflowId !== workflowId || !isWorkflowDefinition(row.dagJson)
      || (row.dagJson.id !== undefined && row.dagJson.id !== workflowId)
      || (options.version !== undefined && row.version !== options.version)
      || (options.beforeVersion !== undefined && row.version >= options.beforeVersion)) throw new MalformedResponseError()
    rows.push({ id: row.id, version: row.version, dagJson: row.dagJson, createdAt: row.createdAt })
  }
  if (!unique(rows, row => row.id) || !unique(rows, row => row.version)) throw new MalformedResponseError()
  return rows
}
