import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { contractApi } from '../api'
import { isGetRunsResponse } from './api-guards/operations/GetRuns'
import { isGetWorkflowsResponse } from './api-guards/operations/GetWorkflows'
import { isGetWorkflowsVersionsResponse } from './api-guards/operations/GetWorkflowsVersions'
import { readRunSummaryPage, readSavedWorkflowPage, readTemplateCatalog, readToolCatalog, readWorkflowVersionPage } from './list-contract'
import { MalformedResponseError } from './malformed-response'

vi.mock('../api', () => ({ contractApi: vi.fn() }))
// Run the operation's generated guard the way contractApi does.
const respond = (payload: unknown) => vi.mocked(contractApi).mockImplementation(async (_operation, _path, _request, options) => {
  if (options?.guard && !options.guard(payload)) throw new MalformedResponseError()
  return payload as never
})
const workflow = { id: 'workflow-a', nodes: [{ id: 'done', type: 'noop', config: {} }], edges: [] }
const version = {
  id: 'version-a', orgId: 'org-a', workflowId: workflow.id, version: 2, createdAt: null, createdBy: null,
  dagJson: workflow, sloJson: null, upstreamHealthSources: null,
}
const saved = {
  id: workflow.id, orgId: 'org-a', name: 'Example', createdAt: null, createdBy: null, deletedAt: null, folder: null,
  lastRunStatus: null, pausedReason: null, status: 'active', tags: [], runCount: 0, bufferedTriggerCount: 0,
}
const run = {
  id: 'run-a', orgId: 'org-a', status: 'timed_out', createdAt: null, createdBy: null, hasWaitingNodes: false,
  outcomeStatus: null, outputJson: null, parentNodeId: null, parentRunId: null, replayMode: null,
  semanticViolationCount: 0, traceId: null, validationEvidenceLevel: null, workflowId: workflow.id,
  workflowName: null, workflowVersionId: version.id,
}
const tool = { name: 'noop', description: 'No operation', writeSide: false, required: [], inputFields: [] }

describe('list read boundaries', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts empty pages and nullable metadata', async () => {
    respond([]); expect(await readRunSummaryPage()).toEqual([])
    respond([saved]); expect(await readSavedWorkflowPage()).toEqual([saved])
    respond([run]); expect(await readRunSummaryPage()).toEqual([run])
  })

  it('delegates shape to the generated guard', async () => {
    for (const payload of [null, {}, [null], [{ ...run, status: 'complete' }], [{ ...run, futureField: true }]]) {
      respond(payload); await expect(readRunSummaryPage()).rejects.toBeInstanceOf(MalformedResponseError)
    }
    respond([{ ...saved, runCount: 0.5 }]); await expect(readSavedWorkflowPage()).rejects.toBeInstanceOf(MalformedResponseError)
  })

  it('leaves page sizes to the server', async () => {
    respond(Array.from({ length: 201 }, (_, i) => ({ ...run, id: `run-${i}` })))
    expect(await readRunSummaryPage()).toHaveLength(201)
  })

  it('rejects duplicate identities and non-object output projections', async () => {
    respond([saved, saved]); await expect(readSavedWorkflowPage()).rejects.toThrow()
    respond([run, run]); await expect(readRunSummaryPage()).rejects.toThrow()
    respond([{ ...run, outputJson: [] }]); await expect(readRunSummaryPage()).rejects.toThrow()
  })

  it('uses typed reads while forwarding the requested run page and cancellation', async () => {
    respond([])
    const signal = new AbortController().signal
    await readRunSummaryPage('/runs?workflowId=workflow-a&limit=50', signal)
    expect(contractApi).toHaveBeenLastCalledWith('GET /runs', '/runs?workflowId=workflow-a&limit=50', undefined, { signal, guard: isGetRunsResponse })
    await readSavedWorkflowPage()
    expect(contractApi).toHaveBeenLastCalledWith('GET /workflows', '/workflows', undefined, { guard: isGetWorkflowsResponse })
  })

  it('forwards version cancellation separately from bounded query options', async () => {
    respond([])
    const signal = new AbortController().signal
    await readWorkflowVersionPage('workflow-a', { limit: 50, beforeVersion: 3 }, signal)
    expect(contractApi).toHaveBeenLastCalledWith('GET /workflows/versions',
      '/workflows/versions?workflowId=workflow-a&limit=50&beforeVersion=3', undefined, { signal, guard: isGetWorkflowsVersionsResponse })
  })

  it('preserves network failures rather than manufacturing empty pages', async () => {
    const error = new Error('unreadable response')
    vi.mocked(contractApi).mockRejectedValue(error)
    await expect(readRunSummaryPage()).rejects.toBe(error)
    await expect(readSavedWorkflowPage()).rejects.toBe(error)
  })

  it('accepts the actual embedded template catalog, including absent credentials', async () => {
    const catalog: unknown = JSON.parse(readFileSync('../internal/httpapi/assets/templates.json', 'utf8'))
    respond(catalog)
    expect(await readTemplateCatalog()).toEqual(catalog)
  })

  it('rejects templates the canvas cannot open and duplicate catalog identities', async () => {
    const entry = { id: 'template-a', name: 'Example', description: '', category: '', nameCode: '', descriptionCode: '', categoryCode: '', workflow }
    respond([entry]); expect(await readTemplateCatalog()).toEqual([entry])
    const dangling = { ...workflow, edges: [{ from: 'done', to: 'missing' }] }
    for (const payload of [[entry, entry], [{ ...entry, workflow: dangling }], [{ ...entry, requiredCredentials: null }]]) {
      respond(payload); await expect(readTemplateCatalog()).rejects.toThrow()
    }
  })

  it('keys tools by name without imposing a catalog page limit', async () => {
    respond(Array.from({ length: 201 }, (_, i) => ({ ...tool, name: `tool-${i}`, inputExample: {}, inputFields: ['array', 'object', 'unknown'].map(kind => ({ name: kind, kind, required: false })) })))
    expect(await readToolCatalog()).toHaveLength(201)
    respond([tool, tool]); await expect(readToolCatalog()).rejects.toThrow()
  })

  it('binds versions to the requested workflow and cursor and copies only the display projection', async () => {
    respond([version])
    expect(await readWorkflowVersionPage(workflow.id, { beforeVersion: 3, limit: 50 })).toEqual([
      { id: version.id, version: 2, dagJson: workflow, createdAt: null },
    ])
    expect(contractApi).toHaveBeenLastCalledWith('GET /workflows/versions', '/workflows/versions?workflowId=workflow-a&beforeVersion=3&limit=50', undefined, { guard: isGetWorkflowsVersionsResponse })
    await expect(readWorkflowVersionPage(workflow.id, { version: 2 })).resolves.toHaveLength(1)
    await expect(readWorkflowVersionPage(workflow.id, { version: 1 })).rejects.toThrow()
    await expect(readWorkflowVersionPage(workflow.id, { beforeVersion: 2 })).rejects.toThrow()
  })

  it.each([
    [version, version],
    [{ ...version, workflowId: 'other' }], [{ ...version, dagJson: { ...workflow, id: 'other' } }],
    [{ ...version, dagJson: { ...workflow, edges: [{ from: 'done', to: 'missing' }] } }],
    [version, { ...version, id: 'different' }], [version, { ...version, version: 1 }],
  ])('rejects version pages that break a panel invariant atomically: %j', async (...payload) => {
    respond(payload)
    await expect(readWorkflowVersionPage(workflow.id)).rejects.toThrow()
  })

  it('leaves version numbering and page sizes to the server', async () => {
    respond([{ ...version, version: 0 }]); await expect(readWorkflowVersionPage(workflow.id)).resolves.toHaveLength(1)
    respond(Array.from({ length: 201 }, (_, i) => ({ ...version, id: `v${i}`, version: i + 1 })))
    await expect(readWorkflowVersionPage(workflow.id)).resolves.toHaveLength(201)
  })
})
