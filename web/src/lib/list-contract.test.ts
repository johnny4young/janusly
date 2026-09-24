import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { contractApi } from '../api'
import { isGetRunsResponse } from './api-guards/operations/GetRuns'
import { isGetWorkflowsResponse } from './api-guards/operations/GetWorkflows'
import { isGetWorkflowsVersionsResponse } from './api-guards/operations/GetWorkflowsVersions'
import { parseRunSummaryPage, parseSavedWorkflowPage, readRunSummaryPage, readSavedWorkflowPage, readTemplateCatalog, readToolCatalog, readWorkflowVersionPage } from './list-contract'

vi.mock('../api', () => ({ contractApi: vi.fn() }))
const respond = (payload: unknown) => vi.mocked(contractApi).mockImplementation(async () => payload as never)
const workflow = { id: 'workflow-a', nodes: [{ id: 'done', type: 'noop', config: {} }], edges: [] }
const version = { id: 'version-a', workflowId: workflow.id, version: 2, createdAt: null, dagJson: workflow }
const saved = { id: workflow.id, orgId: 'org-a', name: 'Example', createdAt: null, tags: [], runCount: 0 }
const tool = { name: 'noop', description: 'No operation', writeSide: false, required: [], inputFields: [] }

describe('list read boundaries', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts empty pages, nullable metadata and additive fields', () => {
    expect(parseRunSummaryPage([])).toEqual([])
    expect(parseSavedWorkflowPage([])).toEqual([])
    expect(parseSavedWorkflowPage([saved])).toEqual([saved])
    const run = { id: 'run-a', status: 'timed_out', createdAt: null, futureField: true }
    expect(parseRunSummaryPage([run])).toEqual([run])
  })

  it.each([null, {}, [null], [{ id: '' }], Array.from({ length: 201 }, (_, i) => ({ id: `r${i}`, status: 'running' }))])('rejects malformed whole pages instead of returning empty success: %j', value => {
    expect(() => parseRunSummaryPage(value)).toThrow()
    expect(() => parseSavedWorkflowPage(value)).toThrow()
  })

  it('rejects duplicate identities and malformed consumed fields', () => {
    expect(() => parseSavedWorkflowPage([saved, saved])).toThrow()
    for (const patch of [{ tags: null }, { runCount: -1 }, { runCount: 0.5 }, { createdAt: 1 }, { orgId: null }]) {
      expect(() => parseSavedWorkflowPage([{ ...saved, ...patch }])).toThrow()
    }
    const run = { id: 'run-a', status: 'running' }
    expect(() => parseRunSummaryPage([run, run])).toThrow()
    expect(() => parseRunSummaryPage([{ ...run, status: 'complete' }])).toThrow()
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

  it('rejects malformed templates and duplicate catalog identities', async () => {
    const entry = { id: 'template-a', name: 'Example', description: '', category: '', nameCode: '', descriptionCode: '', categoryCode: '', workflow }
    respond([entry]); expect(await readTemplateCatalog()).toEqual([entry])
    for (const payload of [[entry, entry], [{ ...entry, workflow: { nodes: [{}], edges: [] } }], [{ ...entry, requiredCredentials: null }]]) {
      respond(payload); await expect(readTemplateCatalog()).rejects.toThrow()
    }
  })

  it('requires safe tool metadata without imposing a catalog page limit', async () => {
    respond(Array.from({ length: 201 }, (_, i) => ({ ...tool, name: `tool-${i}`, inputExample: {}, inputFields: ['array', 'object', 'unknown'].map(kind => ({ name: kind, kind, required: false })) })))
    expect(await readToolCatalog()).toHaveLength(201)
    for (const payload of [[tool, tool], [{ ...tool, writeSide: 'false' }], [{ ...tool, inputFields: [{ name: 'x', kind: 'secret', required: true }] }], [{ ...tool, inputExample: [] }]]) {
      respond(payload); await expect(readToolCatalog()).rejects.toThrow()
    }
  })

  it('binds versions to the requested workflow and cursor and copies only the display projection', async () => {
    respond([{ ...version, orgId: 'org-a', extra: true }])
    expect(await readWorkflowVersionPage(workflow.id, { beforeVersion: 3, limit: 50 })).toEqual([
      { id: version.id, version: 2, dagJson: workflow, createdAt: null },
    ])
    expect(contractApi).toHaveBeenLastCalledWith('GET /workflows/versions', '/workflows/versions?workflowId=workflow-a&beforeVersion=3&limit=50', undefined, { guard: isGetWorkflowsVersionsResponse })
    await expect(readWorkflowVersionPage(workflow.id, { version: 2 })).resolves.toHaveLength(1)
    await expect(readWorkflowVersionPage(workflow.id, { version: 1 })).rejects.toThrow()
    await expect(readWorkflowVersionPage(workflow.id, { beforeVersion: 2 })).rejects.toThrow()
  })

  it.each([
    null, {}, [null], [version, version], [{ ...version, id: '' }],
    [{ ...version, workflowId: 'other' }], [{ ...version, dagJson: { ...workflow, id: 'other' } }],
    [{ ...version, dagJson: { nodes: [{ id: 'x' }], edges: [] } }],
    [{ ...version, version: 0 }], [{ ...version, version: 1.5 }],
    [{ ...version, createdAt: undefined }], [{ ...version, createdAt: 1 }],
    [version, { ...version, id: 'different' }], [version, { ...version, version: 1 }],
    Array.from({ length: 201 }, (_, i) => ({ ...version, id: `v${i}`, version: i + 1 })),
  ])('rejects malformed version pages atomically: %j', async payload => {
    respond(payload)
    await expect(readWorkflowVersionPage(workflow.id)).rejects.toThrow()
  })
})
