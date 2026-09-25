import { beforeEach, describe, expect, it, vi } from 'vitest'
import { contractApi } from '../api'
import { deadLetterWireDefaults } from '../test/dead-letter-fixture'
import { isGetDlqEntriesDeadLetterIdResponse } from './api-guards/operations/GetDlqEntriesDeadLetterId'
import { isPostDlqResolveResponse } from './api-guards/operations/PostDlqResolve'
import { parseDeadLetterDetail, readDeadLetterDetail, resolveDeadLetterEntry } from './dead-letter-contract'
import { MalformedResponseError } from './malformed-response'

vi.mock('../api', () => ({ contractApi: vi.fn() }))
beforeEach(() => vi.mocked(contractApi).mockReset())
// Run the operation's generated guard the way contractApi does.
const respond = (payload: unknown) => vi.mocked(contractApi).mockImplementation(async (_operation, _path, _request, options) => {
  if (options?.guard && !options.guard(payload)) throw new MalformedResponseError()
  return payload as never
})

describe('dead letter boundaries', () => {
  it('accepts explicit null metadata and opaque snapshots as a fresh copy', () => {
    const value = { ...deadLetterWireDefaults, workflowJson: { nodes: [], edges: [] } }
    const detail = parseDeadLetterDetail(value, value.id)
    expect(detail).toEqual(value)
    expect(detail).not.toBe(value)
  })

  it('leaves drill identifier lengths to the server', () => {
    const drill = { kind: 'solution_pack_drill', packId: 'p'.repeat(200), fixtureId: 'f'.repeat(200), recoveryPath: 'direct_failure' }
    expect(parseDeadLetterDetail({ ...deadLetterWireDefaults, drill }, 'dead-letter')).toMatchObject({ drill })
  })

  it('rejects another row before exposing recovery evidence', () => {
    expect(parseDeadLetterDetail({ ...deadLetterWireDefaults, id: 'other' }, 'dead-letter')).toBeNull()
  })

  it.each([
    ['summary only', { id: 'dead-letter', runId: 'run', nodeId: 'node', attempt: 1, status: 'open', errorJson: null }],
    ['queue overlay', { ...deadLetterWireDefaults, recovery: { bad: true } }],
    ['unknown status', { ...deadLetterWireDefaults, status: 'done' }],
  ])('delegates shape to the generated guard: %s', (_name, value) => {
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
    respond(value)
    await expect(resolveDeadLetterEntry('dead-letter')).rejects.toThrow()
  })

  it('sends exactly the selected id and accepts only an affirmative receipt', async () => {
    vi.mocked(contractApi).mockResolvedValue({ ok: true })
    await expect(resolveDeadLetterEntry('dead-letter')).resolves.toBeUndefined()
    expect(contractApi).toHaveBeenCalledWith('POST /dlq/resolve', '/dlq/resolve', { id: 'dead-letter' }, { guard: isPostDlqResolveResponse })
  })
})
