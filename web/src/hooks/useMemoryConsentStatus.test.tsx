import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useMemoryConsentStatus } from './useMemoryConsentStatus'

vi.mock('../api', () => ({ api: vi.fn() }))

const VALID_STATUS = {
  enabled: false,
  processEnabled: true,
  tenantEnabled: false,
  purge: { status: 'scheduled' as const, scheduledFor: '2026-07-21T12:00:00.000Z' },
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ orgId: 'memory-hook-org', platformVersion: 0 })
})

afterEach(() => {
  cleanup()
  useWorkflowStore.setState({ orgId: null, platformVersion: 0 })
})

describe('useMemoryConsentStatus', () => {
  it('fails closed instead of retaining a stale consent snapshot after a refresh error', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(VALID_STATUS)
      .mockRejectedValueOnce(new Error('status unavailable'))

    const { result } = renderHook(() => useMemoryConsentStatus())
    await waitFor(() => expect(result.current.status).toEqual(VALID_STATUS))

    act(() => useWorkflowStore.setState({ platformVersion: 1 }))

    await waitFor(() => expect(result.current.unavailable).toBe(true))
    expect(result.current.status).toBeNull()
  })
})
