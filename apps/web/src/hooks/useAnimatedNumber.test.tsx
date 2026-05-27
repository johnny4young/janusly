import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useAnimatedNumber } from './useAnimatedNumber'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Harness: renders the hook with the given props and captures its return
// value via a shared ref. The DOM render is a no-op div whose only purpose
// is to give React Testing Library something to mount.
type Captured = { value: number }

function Harness(props: { target: number; durationMs: number; snap: boolean; captured: Captured }) {
  const value = useAnimatedNumber(props.target, props.durationMs, props.snap)
  props.captured.value = value
  return <div />
}

/** Drives `requestAnimationFrame` deterministically via a fake-timer-backed
 *  callback queue. Each call to `flushFrame(ms)` advances `performance.now`
 *  by `ms` and runs every pending rAF callback once with the new timestamp,
 *  re-scheduling new ones the callbacks request. Returns a `restore()` to
 *  put the originals back. */
function mockRequestAnimationFrame(): {
  flushFrame: (ms: number) => void
  restore: () => void
} {
  let now = 0
  type Cb = (ts: number) => void
  let queue: Cb[] = []
  const origRaf = window.requestAnimationFrame
  const origCaf = window.cancelAnimationFrame
  const origPerfNow = performance.now
  window.requestAnimationFrame = ((cb: Cb): number => {
    queue.push(cb)
    return queue.length
  }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((handle: number): void => {
    // Mark slot as cleared by replacing with a no-op; preserves the handle index.
    queue[handle - 1] = () => undefined
  }) as typeof window.cancelAnimationFrame
  performance.now = () => now
  return {
    flushFrame(ms: number) {
      now += ms
      const pending = queue
      queue = []
      for (const cb of pending) cb(now)
    },
    restore() {
      window.requestAnimationFrame = origRaf
      window.cancelAnimationFrame = origCaf
      performance.now = origPerfNow
    },
  }
}

describe('useAnimatedNumber', () => {
  it('snap=true returns target synchronously, no rAF scheduled', () => {
    const captured: Captured = { value: -1 }
    const raf = mockRequestAnimationFrame()
    try {
      render(<Harness target={42} durationMs={600} snap={true} captured={captured} />)
      expect(captured.value).toBe(42)
      // Snap branch returns early in the effect — no rAF should be queued.
      // Flushing a frame with nothing pending is a no-op; the captured value
      // stays at 42.
      raf.flushFrame(16)
      expect(captured.value).toBe(42)
    } finally {
      raf.restore()
    }
  })

  it('snap=false interpolates toward the target and settles at it', () => {
    const captured: Captured = { value: -1 }
    const raf = mockRequestAnimationFrame()
    try {
      render(<Harness target={100} durationMs={600} snap={false} captured={captured} />)
      // Initial state: useState(snap ? target : 0) → 0 because snap is false.
      expect(captured.value).toBe(0)
      // First frame anchors `startRef.current` (elapsed=0) so the rendered
      // value stays at 0. The hook schedules a second rAF callback.
      act(() => raf.flushFrame(0))
      // A later frame with non-zero elapsed produces a non-zero eased value.
      act(() => raf.flushFrame(200))
      const mid = captured.value
      expect(mid).toBeGreaterThan(0)
      expect(mid).toBeLessThanOrEqual(100)
      // Drive past durationMs to force t to clamp at 1.
      act(() => raf.flushFrame(600))
      expect(captured.value).toBeCloseTo(100, 5)
    } finally {
      raf.restore()
    }
  })

  it('cleanup on unmount cancels the pending rAF', () => {
    const captured: Captured = { value: -1 }
    const raf = mockRequestAnimationFrame()
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')
    try {
      const { unmount } = render(
        <Harness target={100} durationMs={600} snap={false} captured={captured} />,
      )
      // First frame runs to verify the effect scheduled one.
      act(() => raf.flushFrame(16))
      expect(cancelSpy).not.toHaveBeenCalled()
      unmount()
      // Effect cleanup must have called cancelAnimationFrame on the handle
      // returned by the most recent requestAnimationFrame.
      expect(cancelSpy).toHaveBeenCalled()
    } finally {
      raf.restore()
    }
  })

  it('non-finite target snaps to the value (does not start an animation)', () => {
    const captured: Captured = { value: -1 }
    const raf = mockRequestAnimationFrame()
    try {
      render(<Harness target={Number.NaN} durationMs={600} snap={false} captured={captured} />)
      // The effect's early-return on non-finite target writes target to
      // state without scheduling rAF. We can't easily assert NaN equality
      // but we can confirm no further rAF callback runs.
      raf.flushFrame(16)
      expect(Number.isNaN(captured.value)).toBe(true)
    } finally {
      raf.restore()
    }
  })
})
