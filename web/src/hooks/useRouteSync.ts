import { useEffect } from 'react'
import { onRouteChange, readRoute, writeRoute } from '../lib/route'
import { useWorkflowStore } from '../store'

/**
 * Keeps the store and the URL hash telling the same story: a cold load with
 * no hash writes the restored tab so the first link is already shareable,
 * and browser navigation (back, forward, a typed hash) lands in the store
 * without writing the hash again.
 */
export function useRouteSync(): void {
  useEffect(() => {
    if (!readRoute()) writeRoute({ tab: useWorkflowStore.getState().activeTab }, 'replace')
    return onRouteChange((route) => {
      if (!route) return
      const state = useWorkflowStore.getState()
      if (route.tab === state.activeTab && (route.recoveryCaseId ?? null) === (route.tab === 'recoveryCase' ? state.activeRecoveryCaseId : null)) return
      state.applyRoute(route)
    })
  }, [])
}
