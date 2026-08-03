import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { usePrefersReducedMotion } from './usePrefersReducedMotion'

afterEach(() => {
  cleanup()
})

type Captured = { value: boolean }

function Harness({ captured }: { captured: Captured }) {
  captured.value = usePrefersReducedMotion()
  return <div />
}

/** Replaces `window.matchMedia` with a controllable stub. `setMatches(b)`
 *  flips the stored value AND dispatches the registered `change` listener
 *  with the new value so consumers re-render. Returns the captured
 *  listener for direct invocation and a `restore()` to put the original
 *  back. */
function stubMatchMedia(initial: boolean): {
  setMatches: (next: boolean) => void
  restore: () => void
  /** When unset (true), the stub mirrors older Safari that lacks
   *  addEventListener — the hook should fall back to addListener. */
  setLegacy: () => void
} {
  let currentMatches = initial
  let useLegacy = false
  let listener: ((event: MediaQueryListEvent) => void) | null = null
  const original = window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const mq = {
        get matches() { return currentMatches },
        media: query,
        onchange: null,
        addEventListener: useLegacy ? undefined : ((_event: string, cb: (e: MediaQueryListEvent) => void) => {
          listener = cb
        }),
        removeEventListener: useLegacy ? undefined : (() => {
          listener = null
        }),
        addListener: useLegacy ? ((cb: (e: MediaQueryListEvent) => void) => { listener = cb }) : (() => undefined),
        removeListener: useLegacy ? (() => { listener = null }) : (() => undefined),
        dispatchEvent: vi.fn(),
      }
      return mq
    }),
  })
  return {
    setMatches(next) {
      currentMatches = next
      if (listener) listener({ matches: next } as MediaQueryListEvent)
    },
    restore() {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: original })
    },
    setLegacy() {
      useLegacy = true
    },
  }
}

describe('usePrefersReducedMotion', () => {
  it('returns true when matchMedia reports matches=true', () => {
    const captured: Captured = { value: false }
    const stub = stubMatchMedia(true)
    try {
      render(<Harness captured={captured} />)
      expect(captured.value).toBe(true)
    } finally {
      stub.restore()
    }
  })

  it('returns false when matchMedia reports matches=false', () => {
    const captured: Captured = { value: true }
    const stub = stubMatchMedia(false)
    try {
      render(<Harness captured={captured} />)
      expect(captured.value).toBe(false)
    } finally {
      stub.restore()
    }
  })

  it('re-renders when the change event fires with a new matches value', () => {
    const captured: Captured = { value: false }
    const stub = stubMatchMedia(false)
    try {
      render(<Harness captured={captured} />)
      expect(captured.value).toBe(false)
      act(() => stub.setMatches(true))
      expect(captured.value).toBe(true)
      act(() => stub.setMatches(false))
      expect(captured.value).toBe(false)
    } finally {
      stub.restore()
    }
  })

  it('returns false without throwing when window.matchMedia is missing', () => {
    const captured: Captured = { value: true }
    const original = window.matchMedia
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined })
    try {
      // Render must not throw; the hook short-circuits on the typeof guard.
      render(<Harness captured={captured} />)
      expect(captured.value).toBe(false)
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: original })
    }
  })

  it('falls back to addListener on older Safari (no addEventListener)', () => {
    const captured: Captured = { value: false }
    const stub = stubMatchMedia(false)
    stub.setLegacy()
    try {
      render(<Harness captured={captured} />)
      // The legacy stub's addListener still wires the listener; flipping
      // matches via setMatches must propagate even without addEventListener.
      act(() => stub.setMatches(true))
      expect(captured.value).toBe(true)
    } finally {
      stub.restore()
    }
  })
})
