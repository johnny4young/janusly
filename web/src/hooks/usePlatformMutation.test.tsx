import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePlatformMutation } from './usePlatformMutation'

const addToast = vi.fn()

vi.mock('../store', () => ({
  useWorkflowStore: (selector: (state: { addToast: typeof addToast }) => unknown) => selector({ addToast }),
}))

describe('usePlatformMutation', () => {
  beforeEach(() => addToast.mockReset())

  it('preserves success-toast timing around caller-owned effects', async () => {
    const order: string[] = []
    addToast.mockImplementation(() => order.push('toast'))
    const { result } = renderHook(() => usePlatformMutation())

    await act(async () => {
      const outcome = await result.current({
        request: async () => {
          order.push('request')
          return 7
        },
        failureMessage: 'failed',
        successToast: { message: 'saved', tone: 'success' },
        successToastTiming: 'before-effect',
        onSuccess: async () => { order.push('effect') },
      })
      expect(outcome).toEqual({ ok: true, value: 7 })
    })

    expect(order).toEqual(['request', 'toast', 'effect'])

    order.length = 0
    await act(async () => {
      await result.current({
        request: async () => {
          order.push('request')
          return 8
        },
        failureMessage: 'failed',
        successToast: (value) => ({ message: `saved ${value}`, tone: 'info' }),
        onSuccess: () => { order.push('effect') },
      })
    })

    expect(order).toEqual(['request', 'effect', 'toast'])
    expect(addToast).toHaveBeenLastCalledWith('saved 8', 'info')
  })

  it('uses Error messages and falls back for non-Error failures', async () => {
    const { result } = renderHook(() => usePlatformMutation())

    await act(async () => {
      const thrown = await result.current({
        request: async () => { throw new Error('server detail') },
        failureMessage: 'fallback',
      })
      expect(thrown.ok).toBe(false)
    })
    expect(addToast).toHaveBeenLastCalledWith('server detail', 'error')

    await act(async () => {
      const rejectedEffect = await result.current({
        request: async () => 'ok',
        failureMessage: 'effect failed',
        onSuccess: async () => { throw 'offline' },
      })
      expect(rejectedEffect.ok).toBe(false)
    })
    expect(addToast).toHaveBeenLastCalledWith('effect failed', 'error')
  })
})
