/**
 * Small reactive wrapper around `window.matchMedia`.
 *
 * Used by shell-level components that need behavior to follow the same mobile
 * breakpoint as CSS (not only different styling). SSR and jsdom without a
 * `matchMedia` implementation safely resolve to `false`.
 */

import { useEffect, useState } from 'react'

export const MOBILE_WORKSPACE_QUERY = '(max-width: 760px)'

function matchesQuery(query: string): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesQuery(query))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])

  return matches
}
