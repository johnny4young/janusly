/**
 * rAF-driven count-up animation. Returns the live interpolated value as it
 * animates from the current rendered value toward `target` over `durationMs`
 * with a cubic-ease-out curve. `snap` is the kill switch — when true (or
 * when `target` is non-finite), returns `target` immediately and skips the
 * animation.
 *
 * Used by `HealthRing` in the home dashboard and by the cross-surface
 * `VitalSignsStrip` so a "12 failures" tile counts up from 0 instead of
 * snapping. Reduced-motion users should pass `usePrefersReducedMotion()`
 * (sibling hook) as the `snap` argument — call sites own the policy, not
 * this hook.
 *
 * Invariants:
 * - Each `target` change re-anchors from the current rendered value so a
 *   fast navigation that updates the target mid-animation stays smooth.
 * - Cleanup on unmount cancels the pending `requestAnimationFrame`.
 * - `snap=true` returns `target` synchronously on the next render; no rAF
 *   is scheduled.
 */

import { useEffect, useRef, useState } from 'react'

export function useAnimatedNumber(target: number, durationMs: number, snap: boolean): number {
  const [value, setValue] = useState(snap ? target : 0)
  const valueRef = useRef(value)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number | null>(null)
  const startValueRef = useRef<number>(0)

  useEffect(() => {
    valueRef.current = value
  }, [value])

  useEffect(() => {
    if (snap || !Number.isFinite(target)) {
      setValue(target)
      return
    }
    startValueRef.current = valueRef.current
    startRef.current = null
    const step = (timestamp: number) => {
      if (startRef.current === null) startRef.current = timestamp
      const elapsed = timestamp - startRef.current
      const t = Math.min(1, elapsed / durationMs)
      // Cubic ease-out.
      const eased = 1 - Math.pow(1 - t, 3)
      const next = startValueRef.current + (target - startValueRef.current) * eased
      setValue(next)
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        rafRef.current = null
      }
    }
    rafRef.current = requestAnimationFrame(step)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [target, durationMs, snap])

  return value
}
