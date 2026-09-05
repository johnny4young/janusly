import { useEffect, useRef } from 'react'

/**
 * Tracks whether the component is still mounted. Async work that resolves
 * after dismount checks `aliveRef.current` before touching state, toasts or
 * the store, so a late response never acts on a UI the operator left.
 */
export function useAliveRef() {
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  return aliveRef
}
