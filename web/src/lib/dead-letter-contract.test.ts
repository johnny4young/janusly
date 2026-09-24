import { beforeEach, describe, expect, it, vi } from 'vitest'
import { contractApi } from '../api'
import { deadLetterWireDefaults } from '../test/dead-letter-fixture'
import { isGetDlqEntriesDeadLetterIdResponse } from './api-guards/operations/GetDlqEntriesDeadLetterId'
import { isPostDlqResolveResponse } from './api-guards/operations/PostDlqResolve'
import { parseDeadLetterDetail, readDeadLetterDetail, resolveDeadLetterEntry } from './dead-letter-contract'

vi.mock('../api', () => ({ contractApi: vi.fn() }))
beforeEach(() => vi.mocked(contractApi).mockReset())

describe('dead letter boundaries', () => {
  it('accepts explicit null metadata and opaque snapshots without queue overlays', () => {
    const value = { ...deadLetterWireDefaults, workflowJson: { nodes: [], edges: [] }, recovery: { bad: true } }
    const detail = parseDeadLetterDetail(value, value.id)
    expect(detail).toEqual({ ...deadLetterWireDefaults, workflowJson: value.workflowJson })
    expect(detail).not.toHaveProperty('recovery')
  })

  it.each([
    ['summary only', { id: 'dead-letter', runId: 'run', nodeId: 'node', attempt: 1, status: 'open', errorJson: null }],
    ['wrong identity', { ...deadLetterWireDefaults, id: 'other' }],
    ['missing snapshot', { ...deadLetterWireDefaults, workflowJson: undefined }],
    ['fractional attempt', { ...deadLetterWireDefaults, attempt: 0.5 }],
    ['bad timestamp', { ...deadLetterWireDefaults, createdAt: 42 }],
    ['unknown status', { ...deadLetterWireDefaults, status: 'done' }],
    ['bad drill', { ...deadLetterWireDefaults, drill: {} }],
    ['bad outcome', { ...deadLetterWireDefaults, drillOutcome: { status: 'recovered' } }],
    ['unimplemented correlation', { ...deadLetterWireDefaults, suspectVersion: {} }],
  ])('rejects %s before exposing recovery evidence', (_name, value) => {
    expect(parseDeadLetterDetail(value, 'dead-letter')).toBeNull()
  })

  it('uses the typed entry path with cancellation and rejects wrong-row data', async () => {
    const controller = new AbortController()
    vi.mocked(contractApi).mockResolvedValue({ ...deadLetterWireDefaults, id: 'a/b' })
    await expect(readDeadLetterDetail('a/b', controller.signal)).resolves.toMatchObject({ id: 'a/b' })
    expect(contractApi).toHaveBeenCalledWith('GET /dlq/entries/{deadLetterId}', '/dlq/entries/a%2Fb', undefined, {
      signal: controller.signal, guard: isGetDlqEntriesDeadLetterIdResponse,
    })
    vi.mocked(contractApi).mockResolvedValue(deadLetterWireDefaults)
    await expect(readDeadLetterDetail('other')).rejects.toThrow()
  })

  it.each([{}, null, { ok: false }, { ok: 'true' }])('does not confirm an invalid resolution receipt: %j', async value => {
    vi.mocked(contractApi).mockResolvedValue(value as never)
    await expect(resolveDeadLetterEntry('dead-letter')).rejects.toThrow()
  })

  it('sends exactly the selected id and accepts only an affirmative receipt', async () => {
    vi.mocked(contractApi).mockResolvedValue({ ok: true })
    await expect(resolveDeadLetterEntry('dead-letter')).resolves.toBeUndefined()
    expect(contractApi).toHaveBeenCalledWith('POST /dlq/resolve', '/dlq/resolve', { id: 'dead-letter' }, { guard: isPostDlqResolveResponse })
  })
})
