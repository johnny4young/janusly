import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useAliveRef } from './useAliveRef'

describe('useAliveRef', () => {
  it('keeps one ref across rerenders and marks it dead after unmount', () => {
    const { result, rerender, unmount } = renderHook(() => useAliveRef())
    const aliveRef = result.current

    expect(aliveRef.current).toBe(true)
    rerender()
    expect(result.current).toBe(aliveRef)
    expect(aliveRef.current).toBe(true)

    unmount()
    expect(aliveRef.current).toBe(false)
  })
})
