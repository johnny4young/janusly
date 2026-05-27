/**
 * `prefers-reduced-motion: reduce` listener. Returns `true` when the OS
 * asks the app to suppress non-essential animation. Defensive against
 * non-browser execution (SSR, jsdom-without-matchMedia) — returns `false`
 * rather than throwing in those environments.
 *
 * Used by `useAnimatedNumber` callers (`HealthRing`, `VitalSignsStrip`)
 * who pass the boolean back into the count-up hook to skip the animation
 * when reduced-motion is on. Standalone callers may use it directly to
 * gate other animations (e.g. transitions, parallax effects).
 *
 * Invariants:
 * - Always safe to call in non-browser environments (returns `false`).
 * - The change listener uses `addEventListener` first, falls back to
 *   the legacy `addListener` for older Safari.
 */

import { useEffect, useState } from 'react'

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
