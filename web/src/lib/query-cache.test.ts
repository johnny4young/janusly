import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { invalidateTags, subscribeToTags, useInvalidationNonce, useResourceRefresh, type ResourceTag } from './query-cache'

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
    const tags = ['org-config'] as const
    const { result, unmount } = renderHook(() => useInvalidationNonce(tags))
    expect(result.current).toBe(0)
    act(() => invalidateTags(['org-config']))
    expect(result.current).toBe(1)
    act(() => invalidateTags(['usage']))
    expect(result.current).toBe(1)
    unmount()
    expect(() => invalidateTags(['org-config'])).not.toThrow()
  })

  it('replaces the subscription when the declared resources change', () => {
    const { result, rerender } = renderHook(
      ({ tags }: { tags: readonly ResourceTag[] }) => useInvalidationNonce(tags),
      { initialProps: { tags: ['workflows'] } },
    )
    rerender({ tags: ['roles'] })
    act(() => invalidateTags(['workflows']))
    expect(result.current).toBe(0)
    act(() => invalidateTags(['roles']))
    expect(result.current).toBe(1)
  })

  it('shares explicit retry and deduplicated resource invalidation in one stable counter', () => {
    const { result, rerender, unmount } = renderHook(
      ({ tags }: { tags: readonly ResourceTag[] }) => useResourceRefresh(tags),
      { initialProps: { tags: ['versions', 'workflows'] } },
    )
    const refresh = result.current[1]
    expect(result.current[0]).toBe(0)
    act(() => refresh())
    expect(result.current[0]).toBe(1)
    expect(result.current[1]).toBe(refresh)
    act(() => invalidateTags(['versions', 'workflows']))
    expect(result.current[0]).toBe(2)
    act(() => { refresh(); refresh() })
    expect(result.current[0]).toBe(4)
    rerender({ tags: ['rollouts'] })
    expect(result.current[1]).toBe(refresh)
    act(() => invalidateTags(['versions', 'workflows']))
    expect(result.current[0]).toBe(4)
    act(() => invalidateTags(['rollouts']))
    expect(result.current[0]).toBe(5)
    unmount()
    expect(() => invalidateTags(['rollouts'])).not.toThrow()
  })

})
