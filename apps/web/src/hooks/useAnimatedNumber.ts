/**
 * Shared count-up animation hooks. `useAnimatedNumber` is an rAF-driven
 * cubic-ease-out interpolation from the current rendered value to a new
 * target, with `usePrefersReducedMotion` as the standard kill switch.
 *
 * Used by `HealthRing` in the home dashboard and by the cross-surface
 * `VitalSignsStrip` so a "12 failures" tile counts up from 0 instead of
 * snapping. Reduced-motion users (`prefers-reduced-motion: reduce`)
 * see the final value immediately — no opt-out by the call site.
 */

import { useEffect, useRef, useState } from 'react'

/**
 * Tracks `prefers-reduced-motion: reduce`. Returns true when the user has
 * asked the OS to suppress non-essential animation. Defensive against
 * non-browser execution (SSR, test setup without jsdom matchMedia) — returns
 * false in that case rather than throwing.
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReduced(mq.matches)
    const handler = (event: MediaQueryListEvent) => setPrefersReduced(event.matches)
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }
    // Older Safari quirk — addListener / removeListener still works.
    mq.addListener(handler)
    return () => mq.removeListener(handler)
  }, [])
  return prefersReduced
}

/**
 * rAF-driven count-up. Returns the live interpolated value as it animates
 * toward `target` over `durationMs`. When `snap` is true (or `target` is
 * non-finite), returns `target` immediately and skips the animation.
 *
 * Each `target` change re-anchors from the current rendered value, so a
 * fast user navigation that updates the target mid-animation stays smooth.
 */
export function useAnimatedNumber(target: number, durationMs: number, snap: boolean): number {
  const [value, setValue] = useState(snap ? target : 0)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number | null>(null)
  const startValueRef = useRef<number>(0)

  useEffect(() => {
    if (snap || !Number.isFinite(target)) {
      setValue(target)
      return
    }
    startValueRef.current = value
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
    // value intentionally excluded from deps — we re-anchor each target change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs, snap])

  return value
}
