import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { consumeRecoveryAllClear } from './recovery-all-clear-bus'
import { requestRecoveryAllClearIfQueueEmpty } from './recovery-all-clear-coordinator'

vi.mock('../api', () => ({ api: vi.fn() }))

describe('recovery all-clear coordinator', () => {
  beforeEach(() => {
    localStorage.setItem('janusly:activeOrg', 'org-a')
    consumeRecoveryAllClear()
    vi.mocked(api).mockReset()
  })

  it('publishes only when the authoritative open count is zero', async () => {
    vi.mocked(api).mockResolvedValueOnce({ open: 0 })

    await expect(requestRecoveryAllClearIfQueueEmpty({ downtimeMs: 42_000 })).resolves.toBe(true)
    expect(consumeRecoveryAllClear()).toEqual({ downtimeMs: 42_000 })
  })

  it('suppresses the moment while another failure remains open', async () => {
    vi.mocked(api).mockResolvedValueOnce({ open: 1 })

    await expect(requestRecoveryAllClearIfQueueEmpty()).resolves.toBe(false)
    expect(consumeRecoveryAllClear()).toBeNull()
  })

  it('fails quietly when the count is unavailable or malformed', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('offline'))
    await expect(requestRecoveryAllClearIfQueueEmpty()).resolves.toBe(false)
    vi.mocked(api).mockResolvedValueOnce({ open: '0' })
    await expect(requestRecoveryAllClearIfQueueEmpty()).resolves.toBe(false)
    expect(consumeRecoveryAllClear()).toBeNull()
  })
})
