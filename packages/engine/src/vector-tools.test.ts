import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@janusly/data', () => ({
  commitMemory: vi.fn(),
  getMemoryConfig: vi.fn(),
  recallMemory: vi.fn(),
}))

import { commitMemory, getMemoryConfig, recallMemory } from '@janusly/data'
import { vectorSearchTool, vectorUpsertTool } from './vector-tools'

describe('vector tools', () => {
  beforeEach(() => {
    vi.mocked(commitMemory).mockReset()
    vi.mocked(getMemoryConfig).mockReset()
    vi.mocked(getMemoryConfig).mockResolvedValue({ allowedKinds: new Set(['workflow_vector']) } as never)
    vi.mocked(recallMemory).mockReset()
  })

  it('vector.search threads topK as the recall limit and shapes the matches scoped to the workflow_vector kind', async () => {
    // recallMemory applies the limit in SQL; the extra mock row proves the
    // tool also preserves its public max-results contract defensively.
    vi.mocked(recallMemory).mockResolvedValue({
      entries: [
        { id: 'm1', kind: 'workflow_vector', content: 'churned A', similarity: 0.91, workflowId: null, runId: null, metadata: { customerId: 'cus_1' }, createdAt: new Date('2026-01-01T00:00:00Z') },
        { id: 'm2', kind: 'workflow_vector', content: 'churned B', similarity: 0.82, workflowId: null, runId: null, metadata: null, createdAt: new Date('2026-01-02T00:00:00Z') },
        { id: 'm3', kind: 'workflow_vector', content: 'churned C', similarity: 0.70, workflowId: null, runId: null, metadata: null, createdAt: new Date('2026-01-03T00:00:00Z') },
      ],
    } as never)

    const result = await vectorSearchTool.execute(
      { query: 'who churned', topK: 2 },
      {},
      { orgId: 'org-1', runId: 'run-1', nodeId: 'search' },
    )

    expect(result.ok).toBe(true)
    expect(result.entries).toHaveLength(2)
    expect(result.entries?.[0]).toEqual({
      content: 'churned A',
      similarity: 0.91,
      metadata: { customerId: 'cus_1' },
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    // The requested topK is passed through as the recall limit.
    expect(recallMemory).toHaveBeenCalledWith({ orgId: 'org-1', kind: 'workflow_vector', query: 'who churned', limit: 2 })
  })

  it('vector.search passes the default topK as the recall limit when topK is omitted', async () => {
    vi.mocked(recallMemory).mockResolvedValue({ entries: [] } as never)
    await vectorSearchTool.execute({ query: 'anything' }, {}, { orgId: 'org-1' })
    // DEFAULT_TOP_K (8) is the limit when the caller omits topK.
    expect(recallMemory).toHaveBeenCalledWith({ orgId: 'org-1', kind: 'workflow_vector', query: 'anything', limit: 8 })
  })

  it('vector.search returns empty entries when workflow_vector is not allowed (no throw)', async () => {
    vi.mocked(getMemoryConfig).mockResolvedValueOnce({ allowedKinds: new Set() } as never)
    vi.mocked(recallMemory).mockResolvedValue({ entries: [] } as never)
    const result = await vectorSearchTool.execute({ query: 'x' }, {}, { orgId: 'org-1' })
    expect(result).toMatchObject({ ok: true, entries: [] })
    expect(recallMemory).not.toHaveBeenCalled()
  })

  it('vector.search returns empty entries when memory config is unavailable (no throw)', async () => {
    vi.mocked(getMemoryConfig).mockRejectedValueOnce(new Error('config unavailable'))
    const result = await vectorSearchTool.execute({ query: 'x' }, {}, { orgId: 'org-1' })
    expect(result).toMatchObject({ ok: true, entries: [] })
    expect(recallMemory).not.toHaveBeenCalled()
  })

  it('vector.upsert stores under the workflow_vector kind and threads run/workflow ids', async () => {
    vi.mocked(commitMemory).mockResolvedValue({ ok: true, entryId: 'mem_123' } as never)

    const result = await vectorUpsertTool.execute(
      { content: 'cus_1 churned', metadata: { customerId: 'cus_1' } },
      {},
      { orgId: 'org-1', runId: 'run-1', nodeId: 'up', workflowId: 'wf-1' },
    )

    expect(result).toMatchObject({ ok: true, id: 'mem_123' })
    expect(commitMemory).toHaveBeenCalledWith({
      orgId: 'org-1',
      runId: 'run-1',
      workflowId: 'wf-1',
      kind: 'workflow_vector',
      content: 'cus_1 churned',
      metadata: { customerId: 'cus_1' },
    })
  })

  it('vector.upsert surfaces consent-off + embedding failures as envelopes (no throw)', async () => {
    vi.mocked(commitMemory).mockResolvedValueOnce({ ok: false, error: 'memory_disabled' } as never)
    await expect(vectorUpsertTool.execute({ content: 'x' }, {}, { orgId: 'org-1' }))
      .resolves.toMatchObject({ ok: false, error: 'memory_disabled' })

    vi.mocked(commitMemory).mockResolvedValueOnce({ ok: false, error: 'embedding_failed' } as never)
    await expect(vectorUpsertTool.execute({ content: 'x' }, {}, { orgId: 'org-1' }))
      .resolves.toMatchObject({ ok: false, error: 'embedding_failed' })
  })

  it('both tools require multi-tenant context and never touch the substrate without an org', async () => {
    const search = await vectorSearchTool.execute({ query: 'x' }, {}, {})
    const upsert = await vectorUpsertTool.execute({ content: 'x' }, {}, {})

    expect(search).toMatchObject({ ok: false })
    expect(upsert).toMatchObject({ ok: false })
    expect(search.error).toContain('multi-tenant')
    expect(upsert.error).toContain('multi-tenant')
    expect(recallMemory).not.toHaveBeenCalled()
    expect(commitMemory).not.toHaveBeenCalled()
  })

  it('vector.search never throws and redacts connection URLs if the substrate throws unexpectedly', async () => {
    vi.mocked(recallMemory).mockRejectedValue(new Error('connection to postgres://u:secret@h/db lost'))
    const result = await vectorSearchTool.execute({ query: 'x' }, {}, { orgId: 'org-1' })
    expect(result.ok).toBe(false)
    expect(result.error).not.toContain('postgres://')
    expect(result.error).not.toContain('secret')
  })
})
