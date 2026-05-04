/**
 * Integration coverage for the persistence chokepoint — proves that
 * `appendEvent` and `markNodeFailed` route every payload through
 * `safePersistPayload` before it reaches `db.insert` / `db.update`.
 *
 * The DB driver is mocked at the `@janusly/db` boundary so the captured
 * `values()` / `set()` argument is the exact shape that would land in
 * Postgres. Tests assert sensitive-key fields come back as
 * `"[redacted]"` and that the helper actually fired.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const insertValuesMock = vi.fn().mockResolvedValue(undefined)
const updateSetMock = vi.fn()

vi.mock('@janusly/db', () => ({
  db: {
    insert: () => ({ values: insertValuesMock }),
    update: () => ({
      set: (args: unknown) => {
        updateSetMock(args)
        return { where: () => Promise.resolve(undefined) }
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    transaction: (fn: any) => fn({ insert: () => ({ values: () => Promise.resolve(undefined) }) }),
  },
  runs: {} as any,
  runNodes: {} as any,
  runEvents: {} as any,
  workflowVersions: {} as any,
}))

import { appendEvent, markNodeFailed } from './persistence'

describe('persistence chokepoint integration', () => {
  beforeEach(() => {
    insertValuesMock.mockClear()
    updateSetMock.mockClear()
  })

  it('appendEvent scrubs sensitive keys before writing run_events.payload', async () => {
    await appendEvent('run-1', 'node-1', 'http.response', {
      statusCode: 200,
      headers: { Authorization: 'Bearer leaky-token-abc', 'Content-Type': 'application/json' },
      body: '{"ok":true}',
    })

    expect(insertValuesMock).toHaveBeenCalledTimes(1)
    const written = insertValuesMock.mock.calls[0][0] as { payload: any }
    expect(written.payload.headers.Authorization).toBe('[redacted]')
    expect(written.payload.headers['Content-Type']).toBe('application/json')
    expect(written.payload.statusCode).toBe(200)
    // The literal token string never appears anywhere in the persisted JSON.
    expect(JSON.stringify(written.payload)).not.toContain('leaky-token-abc')
  })

  it('markNodeFailed scrubs sensitive keys before writing run_nodes.error_json', async () => {
    await markNodeFailed('run-1', 'node-1', {
      message: 'upstream returned 401',
      cause: { headers: { Authorization: 'Bearer leak-456' }, requestId: 'req_xyz' },
    })

    expect(updateSetMock).toHaveBeenCalledTimes(1)
    const written = updateSetMock.mock.calls[0][0] as { errorJson: any }
    expect(written.errorJson.message).toBe('upstream returned 401')
    expect(written.errorJson.cause.headers.Authorization).toBe('[redacted]')
    expect(written.errorJson.cause.requestId).toBe('req_xyz')
    expect(JSON.stringify(written.errorJson)).not.toContain('leak-456')
  })
})
