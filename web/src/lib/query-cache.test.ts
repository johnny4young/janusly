import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { invalidateTags, subscribeToTags, useInvalidationNonce } from './query-cache'

describe('tagged invalidation', () => {
  it('notifies only the subscribers whose tags intersect, once each', () => {
    const policies = vi.fn()
    const config = vi.fn()
    const stopPolicies = subscribeToTags(['alert-policies', 'credentials'], policies)
    const stopConfig = subscribeToTags(['org-config'], config)

    invalidateTags(['credentials', 'alert-policies'])
    expect(policies).toHaveBeenCalledTimes(1)
    expect(config).not.toHaveBeenCalled()

    invalidateTags(['org-config'])
    expect(config).toHaveBeenCalledTimes(1)

    stopPolicies()
    stopConfig()
    invalidateTags(['alert-policies', 'org-config'])
    expect(policies).toHaveBeenCalledTimes(1)
    expect(config).toHaveBeenCalledTimes(1)
  })

  it('advances a hook nonce for its tags and stops on unmount', () => {
    const tags = ['org-config']
    const { result, unmount } = renderHook(() => useInvalidationNonce(tags))
    expect(result.current).toBe(0)
    act(() => invalidateTags(['org-config']))
    expect(result.current).toBe(1)
    act(() => invalidateTags(['unrelated']))
    expect(result.current).toBe(1)
    unmount()
    expect(() => invalidateTags(['org-config'])).not.toThrow()
  })
})
